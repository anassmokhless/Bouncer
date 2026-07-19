import cron from "node-cron";
import { Bot } from "grammy";
import { query, pool } from "../shared/db.js";
import { getVerifiedWallet, checkNftOwnership, hasBouncerPass } from "../shared/enjin.js";
import { safeUnmute, isUserNotParticipantError } from "./helpers.js";
import { removeCheckedPair, pruneCheckedPairs } from "./handlers/existing-member.js";

let isPolling = false;
let isRechecking = false;
let isKicking = false;
let isLeaving = false;
let isAdminRechecking = false;

// Cross-process coordination via PostgreSQL advisory locks.
// The in-memory flags above prevent overlapping runs within a single Node process.
// These lock IDs prevent overlapping runs across multiple bot instances (e.g. during
// rolling deploys, accidental double-start, or HA setups). Each cron gets a unique
// stable integer; pg_try_advisory_lock is non-blocking so unavailable locks are a
// no-op skip (same semantics as the in-memory flag).
const LOCK_ID_POLL = 1001;
const LOCK_ID_RECHECK = 1002;
const LOCK_ID_KICK = 1003;
const LOCK_ID_LEAVE = 1004;
const LOCK_ID_ADMIN_RECHECK = 1005;

async function withAdvisoryLock(lockId: number, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
    if (!result.rows[0].locked) {
      // Another instance holds it — skip this tick. Logged as a warning because
      // in a single-instance deployment this should essentially never happen; if
      // it does, it usually signals a connection-pooler quirk (see pg_advisory
      // lock + pooler interactions) or a stuck lock from a prior session, not
      // a legitimate "another bot is doing work" scenario.
      console.warn(`[CRON] Advisory lock ${lockId} unavailable — skipping tick`);
      return;
    }
    try {
      await fn();
    } finally {
      // Best-effort release. If this fails the lock stays held on this pooled connection
      // until the process exits (TCP disconnect releases session-scoped locks). That's
      // acceptable degradation — the work still ran, and the next tick will either reuse
      // this connection (reentrant try_lock returns true — work runs as normal) or get a
      // different connection.
      try {
        await client.query(`SELECT pg_advisory_unlock($1)`, [lockId]);
      } catch (unlockErr) {
        console.error(`[CRON] Failed to release advisory lock ${lockId}:`, unlockErr);
      }
    }
  } finally {
    client.release();
  }
}

export function startCronJobs(bot: Bot) {
  // Poll pending QR verifications every 15 seconds
  cron.schedule("*/15 * * * * *", async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      await withAdvisoryLock(LOCK_ID_POLL, () => pollPendingVerifications(bot));
    } catch (err) {
      console.error("[CRON] Verification poll failed:", err);
    } finally {
      isPolling = false;
    }
  });

  cron.schedule("*/10 * * * *", async () => {
    if (isRechecking) return;
    isRechecking = true;
    console.log("[CRON] Running NFT ownership re-check...");
    try {
      await withAdvisoryLock(LOCK_ID_RECHECK, () => recheckVerifiedMembers(bot));
    } catch (err) {
      console.error("[CRON] Re-check failed:", err);
    } finally {
      isRechecking = false;
    }
  });

  // Every minute — matches the shortest verification deadline (5 min for new joiners),
  // so users get kicked within ~1 min of their deadline instead of waiting up to an hour.
  // Cheap: the filtering SELECT is indexed and typically returns 0 rows.
  cron.schedule("* * * * *", async () => {
    if (isKicking) return;
    isKicking = true;
    console.log("[CRON] kick-expired tick");
    try {
      await withAdvisoryLock(LOCK_ID_KICK, async () => {
        // Prune expired entries from existing-member TTL cache
        pruneCheckedPairs();
        await kickExpiredPendingMembers(bot);
      });
    } catch (err) {
      console.error("[CRON] Kick expired failed:", err);
    } finally {
      isKicking = false;
    }
  });

  // Check for groups where admin didn't verify in time — every minute
  cron.schedule("* * * * *", async () => {
    if (isLeaving) return;
    isLeaving = true;
    console.log("[CRON] admin-verify tick");
    try {
      await withAdvisoryLock(LOCK_ID_LEAVE, () => leaveUnverifiedGroups(bot));
    } catch (err) {
      console.error("[CRON] Leave unverified groups failed:", err);
    } finally {
      isLeaving = false;
    }
  });

  // Periodic admin Pass-ownership sweep — every 5 minutes. Catches admins who
  // transferred/sold their Bouncer Pass without running /unlink. Arms the 5-min
  // admin_verify_deadline on groups where NO admin currently holds the pass;
  // leaveUnverifiedGroups (the */1min cron above) does the actual kick once the
  // deadline fires, giving admins a grace window to re-acquire the pass.
  cron.schedule("*/5 * * * *", async () => {
    if (isAdminRechecking) return;
    isAdminRechecking = true;
    console.log("[CRON] admin-recheck tick");
    try {
      await withAdvisoryLock(LOCK_ID_ADMIN_RECHECK, () => recheckAdminPassOwnership(bot));
    } catch (err) {
      console.error("[CRON] Admin pass recheck failed:", err);
    } finally {
      isAdminRechecking = false;
    }
  });

  console.log("[CRON] Jobs scheduled: verify-poll (*/15s), re-check (*/10min), kick-expired (*/1min), admin-verify (*/1min), admin-recheck (*/5min)");
}

async function pollPendingVerifications(bot: Bot) {
  // Clean up expired verifications
  await query(`DELETE FROM pending_verifications WHERE expires_at <= now()`);

  // Get all non-expired pending verifications
  const pending = await query(
    `SELECT pv.id, pv.verification_id, pv.telegram_chat_id, pv.user_id,
            u.telegram_id AS user_telegram_id
     FROM pending_verifications pv
     JOIN users u ON u.id = pv.user_id
     WHERE pv.expires_at > now()`,
  );

  if (pending.rows.length === 0) return;

  for (const row of pending.rows) {
    const walletAddress = await getVerifiedWallet(row.verification_id);
    if (!walletAddress) continue;

    // Check wallet isn't already claimed
    const existing = await query(
      `SELECT id FROM users WHERE wallet_address = $1 AND id != $2`,
      [walletAddress, row.user_id],
    );

    if (existing.rows.length > 0) {
      // Wrap sendMessage so a delivery failure (user blocked bot, chat deleted, Telegram
      // rate limit) doesn't abort this cron tick and leave the pending row stranded for
      // up to 10 min until the expires_at sweep. Without this, the exception propagates
      // out of the loop and blocks processing of every other pending row in this batch.
      try {
        await bot.api.sendMessage(parseInt(row.telegram_chat_id),
          "This wallet is already linked to another Telegram account. Please use a different wallet.");
      } catch (err) {
        console.error(`[CRON] Failed to notify ${row.user_telegram_id} of duplicate wallet:`, err);
      }
      // Always delete the pending row — retrying notification won't help (the wallet is
      // still claimed by someone else), and keeping the row alive just burns more Enjin
      // API calls on every 15s tick.
      await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      continue;
    }

    // Get memberships and rules (read-only, outside transaction)
    const memberships = await query(
      `SELECT m.id AS member_id, m.group_id, g.title AS group_title, g.telegram_id AS group_telegram_id,
              r.collection_id, r.token_id, r.min_balance
       FROM members m
       JOIN groups g ON g.id = m.group_id
       LEFT JOIN nft_rules r ON r.group_id = m.group_id AND r.is_active = true
       WHERE m.user_id = $1`,
      [row.user_id],
    );

    const groupMap = new Map<
      string,
      { groupId: string; title: string; memberId: string; groupTelegramId: string; rules: any[] }
    >();

    for (const m of memberships.rows) {
      if (!groupMap.has(m.group_id)) {
        groupMap.set(m.group_id, {
          groupId: m.group_id,
          title: m.group_title,
          memberId: m.member_id,
          groupTelegramId: m.group_telegram_id,
          rules: [],
        });
      }
      if (m.collection_id) {
        groupMap.get(m.group_id)!.rules.push({
          collectionId: m.collection_id,
          tokenId: m.token_id,
          minBalance: m.min_balance,
        });
      }
    }

    // Check NFT ownership per group (external API calls, outside transaction)
    const verifiedGroups: Array<{ groupId: string; memberId: string; groupTelegramId: string; collectionId: string; tokenId: string | null }> = [];
    // Set when a group's ownership check was entirely inconclusive (every rule
    // returned null: Enjin error, or a wallet too large to paginate). We must
    // NOT finalize the verification in that case — see the guarded delete/notify
    // below.
    let sawInconclusiveGroup = false;

    for (const [, group] of groupMap) {
      if (group.rules.length === 0) {
        // Rule-less group: nothing to verify against. Instead of skipping (which
        // left a stuck PENDING row un-releasable forever), reconcile: flip back
        // to VERIFIED and unmute. Guarded so VERIFIED/KICKED/LEFT are untouched.
        // No audit entry — no rule was passed; this is state reconciliation.
        const released = await query(
          `UPDATE members SET status = 'VERIFIED', verification_deadline = NULL
           WHERE id = $1 AND status = 'PENDING'`,
          [group.memberId],
        );
        if ((released.rowCount ?? 0) > 0) {
          await safeUnmute(bot.api, group.groupTelegramId, row.user_telegram_id);
          removeCheckedPair(group.groupTelegramId, row.user_telegram_id);
          console.log(`[CRON] Released ${row.user_telegram_id} in rule-less group ${group.groupTelegramId} — nothing to verify against`);
        }
        continue;
      }

      let holds = false;
      let sawCleanResult = false; // at least one rule gave a decisive true/false
      for (const rule of group.rules) {
        const hasNft = await checkNftOwnership(
          walletAddress,
          rule.collectionId,
          rule.tokenId,
          rule.minBalance,
        );

        if (hasNft === null) continue; // API error / pagination cap — inconclusive
        sawCleanResult = true;
        if (hasNft) {
          holds = true;
          verifiedGroups.push({
            groupId: group.groupId,
            memberId: group.memberId,
            groupTelegramId: group.groupTelegramId,
            collectionId: rule.collectionId,
            tokenId: rule.tokenId,
          });
          break;
        }
      }

      // Every rule for this group errored and the member wasn't verified here:
      // we couldn't fairly decide. Flag it so we retry instead of finalizing a
      // holder as "no access" (which would strand them PENDING → kicked).
      if (!holds && !sawCleanResult) sawInconclusiveGroup = true;
    }

    // Transaction: link wallet + delete pending + update memberships + audit logs
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE users SET wallet_address = $1, is_verified = true, verified_at = now() WHERE id = $2`,
        [walletAddress, row.user_id],
      );

      // Keep the pending row when any group was inconclusive so the next tick
      // retries once Enjin recovers; deleting it here strands a real holder as
      // PENDING with no recheck path, and kick-expired would then remove them.
      // The row's expires_at still bounds the retries.
      if (!sawInconclusiveGroup) {
        await client.query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      }

      for (const vg of verifiedGroups) {
        // Two-step write: scheid transitie (audit-waardig) van idempotente
        // refresh (niet audit-waardig).
        //
        // Statement 1 — STRICTE guard `status = 'PENDING'`: alleen een echte
        // PENDING → VERIFIED transitie schrijft een USER_VERIFIED audit. Voorkomt
        // dat een user die meerdere keren `/verify` runt (bv. omdat ze niet weten
        // dat ze al verified zijn) elke keer een nieuwe audit entry produceert.
        // De vorige guard `IN ('PENDING','VERIFIED')` was te lossig — re-runs op
        // al-VERIFIED users gaven rowCount > 0 en dus duplicate audits.
        //
        // Statement 2 — refresh `last_checked` als status al VERIFIED was. Geen
        // audit. Houdt onze "wanneer voor 't laatst gecheckt" data fresh zonder
        // de audit log te vervuilen. Als status LEFT/KICKED is (race-condition
        // waarbij user vertrok tussen NFT-check en transactie), matcht geen van
        // beide statements — status blijft correct, geen spurious audit.
        const transitionResult = await client.query(
          `UPDATE members SET status = 'VERIFIED', last_checked = now()
           WHERE id = $1 AND status = 'PENDING'`,
          [vg.memberId],
        );
        if ((transitionResult.rowCount ?? 0) > 0) {
          await client.query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [vg.groupId, row.user_id, "USER_VERIFIED",
             JSON.stringify({ walletAddress, collectionId: vg.collectionId, tokenId: vg.tokenId })],
          );
        } else {
          // Was al VERIFIED — alleen last_checked bijwerken, geen audit.
          await client.query(
            `UPDATE members SET last_checked = now()
             WHERE id = $1 AND status = 'VERIFIED'`,
            [vg.memberId],
          );
        }
      }

      await client.query("COMMIT");
    } catch (err: any) {
      await client.query("ROLLBACK");
      // 23505 = PostgreSQL unique_violation. The only UNIQUE constraint hit by this transaction
      // is users.wallet_address — meaning another user claimed this wallet in the race window
      // between our pre-check SELECT (line 90) and the UPDATE (line 170). Delete the pending row
      // outside the rolled-back transaction and notify the user — otherwise the cron retries the
      // same row every 15s until the 10min expiry sweep cleans it up.
      if (err?.code === "23505") {
        try {
          await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
        } catch (delErr) {
          console.error(`[CRON] Failed to delete duplicate-wallet pending row ${row.id}:`, delErr);
        }
        try {
          await bot.api.sendMessage(
            parseInt(row.telegram_chat_id),
            "This wallet was just linked to another Telegram account. Please try a different wallet.",
          );
        } catch (notifyErr) {
          console.error(`[CRON] Failed to notify ${row.user_telegram_id} of duplicate wallet:`, notifyErr);
        }
      } else {
        console.error(`[CRON] Transaction failed for user ${row.user_telegram_id}:`, err);
      }
      continue;
    } finally {
      client.release();
    }

    // Unrestrict verified users in Telegram (outside transaction). Also clear the
    // existing-member cache so their next message passes through cleanly — without
    // this, a user who was recently in 'delete' cache mode (basic group fallback)
    // would still have their messages deleted until the cache expires.
    for (const vg of verifiedGroups) {
      await safeUnmute(
        bot.api,
        parseInt(vg.groupTelegramId),
        parseInt(row.user_telegram_id),
      );
      removeCheckedPair(vg.groupTelegramId, row.user_telegram_id);
    }

    // Held the pending row for a retry (some group was inconclusive): don't
    // notify yet. A "you don't hold the NFTs" message would be wrong here, and
    // it would repeat every 15s tick — the resolving tick sends the real one.
    // Verified groups (if any) were already unmuted above, so partial progress
    // isn't lost.
    if (sawInconclusiveGroup) continue;

    // Notify the user
    let message: string;
    if (verifiedGroups.length > 0) {
      message = `Wallet \`${walletAddress}\` verified! You have access to ${verifiedGroups.length} group(s).`;
    } else if (groupMap.size === 0) {
      message = `Wallet \`${walletAddress}\` verified!\n\nJoin an NFT-gated group and I'll automatically check your holdings.`;
    } else {
      message = `Wallet \`${walletAddress}\` verified, but you don't hold the NFTs required for your current groups. You'll stay muted until you do.`;
    }

    try {
      await bot.api.sendMessage(parseInt(row.telegram_chat_id), message, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[CRON] Failed to notify user ${row.user_telegram_id}:`, err);
    }
  }
}

async function recheckVerifiedMembers(bot: Bot) {
  // EXISTS filter pushes the "is this member due?" decision into SQL so we only load
  // members that actually need rechecking instead of every verified member in every
  // active group. A member is due if ANY of their group's rules has an interval
  // Wallet-less VERIFIED members of ruled groups can never satisfy any rule —
  // they are pre-first-rule joiners (new-member writes VERIFIED when a group
  // has no rules yet). Without this they are permanently exempt: every
  // checking path filters on wallet IS NOT NULL and the message handler skips
  // VERIFIED rows. Fold them back into normal enforcement: PENDING with the
  // same 24h window existing members get; cache-clear so their next message
  // triggers the verification prompt; kick-expired enforces the deadline.
  const regated = await query(
    `UPDATE members m SET status = 'PENDING', verification_deadline = now() + interval '24 hours'
     FROM groups g, users u
     WHERE g.id = m.group_id AND u.id = m.user_id
       AND m.status = 'VERIFIED' AND u.wallet_address IS NULL
       AND g.is_active = true
       AND EXISTS (SELECT 1 FROM nft_rules r WHERE r.group_id = m.group_id AND r.is_active = true)
     RETURNING g.telegram_id AS group_telegram_id, u.telegram_id AS user_telegram_id`,
  );
  for (const r of regated.rows) {
    removeCheckedPair(r.group_telegram_id, r.user_telegram_id);
  }
  if ((regated.rowCount ?? 0) > 0) {
    console.log(`[CRON] Re-gated ${regated.rowCount} wallet-less VERIFIED member(s) — their groups have active rules now`);
  }

  // that has elapsed since last_checked (equivalent to "min interval has elapsed").
  // Using EXISTS (not a WHERE predicate on r.check_interval_seconds) is important:
  // we need to load ALL rule rows for due members, so the NFT check loop evaluates
  // every rule. Filtering on r.check_interval_seconds directly would drop non-due
  // rules from the result set and cause false kicks for members holding an NFT
  // that matches only a longer-interval rule.
  const result = await query(
    `SELECT g.id AS group_id, g.telegram_id AS group_telegram_id,
            m.id AS member_id, m.last_checked,
            u.id AS user_id, u.telegram_id AS user_telegram_id, u.wallet_address,
            r.collection_id, r.token_id, r.min_balance, r.check_interval_seconds
     FROM groups g
     JOIN members m ON m.group_id = g.id AND m.status = 'VERIFIED'
     JOIN users u ON u.id = m.user_id
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.is_active = true
       AND u.wallet_address IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM nft_rules r2
         WHERE r2.group_id = g.id AND r2.is_active = true
           AND (m.last_checked IS NULL
                OR m.last_checked < now() - (r2.check_interval_seconds || ' seconds')::interval)
       )`,
  );

  const memberChecks = new Map<string, {
    memberId: string;
    groupId: string;
    groupTelegramId: string;
    userId: string;
    userTelegramId: string;
    walletAddress: string;
    lastChecked: Date | null;
    rules: Array<{ collectionId: string; tokenId: string | null; minBalance: number; checkInterval: number }>;
  }>();

  for (const row of result.rows) {
    if (!memberChecks.has(row.member_id)) {
      memberChecks.set(row.member_id, {
        memberId: row.member_id,
        groupId: row.group_id,
        groupTelegramId: row.group_telegram_id,
        userId: row.user_id,
        userTelegramId: row.user_telegram_id,
        walletAddress: row.wallet_address,
        lastChecked: row.last_checked,
        rules: [],
      });
    }
    memberChecks.get(row.member_id)!.rules.push({
      collectionId: row.collection_id,
      tokenId: row.token_id,
      minBalance: row.min_balance,
      checkInterval: row.check_interval_seconds,
    });
  }

  let checkedCount = 0;
  let kickedCount = 0;

  // SQL already filtered to members due for recheck (see EXISTS clause above), so
  // every entry in memberChecks is ready to process. No JS-side filter needed.
  const dueMembers = Array.from(memberChecks.values());

  const BATCH_SIZE = 5;
  for (let i = 0; i < dueMembers.length; i += BATCH_SIZE) {
    const batch = dueMembers.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (member) => {
      checkedCount++;
      let stillHoldsNft = false;
      let apiError = false;

      for (const rule of member.rules) {
        const result = await checkNftOwnership(member.walletAddress, rule.collectionId, rule.tokenId, rule.minBalance);
        if (result === null) {
          apiError = true;
          break;
        }
        if (result) {
          stillHoldsNft = true;
          break;
        }
      }

      // API error — skip this member, try again next cycle
      if (apiError) return;

      if (stillHoldsNft) {
        await query(`UPDATE members SET last_checked = now() WHERE id = $1`, [member.memberId]);
      } else {
        // Only update DB + audit log if the kick actually succeeded. Telegram
        // rejects attempts to ban group creators (and some other edge cases), so
        // optimistically flipping status to KICKED would leave stale state — user
        // visible in the group but marked KICKED in DB. Guarding on kickSuccess
        // keeps DB in sync with reality; the next cron cycle retries automatically.
        let kickSuccess = false;
        try {
          await bot.api.banChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId), {
            until_date: Math.floor(Date.now() / 1000) + 40,
          });
          kickSuccess = true;
        } catch (err) {
          if (isUserNotParticipantError(err)) {
            // User already left — stop retrying, reconcile DB with reality.
            // Guarded VERIFIED → LEFT; no USER_KICKED audit (we didn't kick).
            await query(`UPDATE members SET status = 'LEFT' WHERE id = $1 AND status = 'VERIFIED'`, [member.memberId]);
            removeCheckedPair(member.groupTelegramId, member.userTelegramId);
            console.log(`[CRON] ${member.userTelegramId} already left ${member.groupTelegramId} — marked LEFT, skipping kick`);
            return;
          }
          console.error(`[CRON] Failed to kick ${member.userTelegramId}:`, err);
        }

        if (kickSuccess) {
          // Same status-guard pattern as kickExpiredPendingMembers: only flip
          // VERIFIED → KICKED. If handleMemberLeft already committed LEFT
          // (user voluntarily left between the recheck SELECT and this UPDATE),
          // skip the UPDATE and audit log to avoid double-logging.
          let didKick = false;
          const client = await pool.connect();
          try {
            await client.query("BEGIN");
            const updateResult = await client.query(
              `UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1 AND status = 'VERIFIED'`,
              [member.memberId],
            );
            if ((updateResult.rowCount ?? 0) > 0) {
              await client.query(
                `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
                [member.groupId, member.userId, "USER_KICKED", JSON.stringify({ reason: "NFT no longer held" })],
              );
              didKick = true;
            }
            await client.query("COMMIT");
          } catch (err) {
            await client.query("ROLLBACK");
            console.error(`[CRON] Failed to update kick status for ${member.userTelegramId}:`, err);
          } finally {
            client.release();
          }

          if (didKick) {
            // Clear from existing-member cache so they get re-checked if they rejoin
            removeCheckedPair(member.groupTelegramId, member.userTelegramId);
            kickedCount++;
          }
        }
      }
    }));
  }

  console.log(`[CRON] Re-check done. Checked: ${checkedCount}, Kicked: ${kickedCount}`);
}

async function kickExpiredPendingMembers(bot: Bot) {
  // The active-rules EXISTS is the "zero rules = zero enforcement" safety net:
  // members of rule-less groups are never kicked, even if a PENDING row with a
  // deadline exists (legacy data, or an admin removed the last rule while
  // members were mid-verification).
  const result = await query(
    `SELECT m.id, m.group_id, g.telegram_id AS group_telegram_id,
            m.user_id, u.telegram_id AS user_telegram_id,
            (SELECT COUNT(*) FROM audit_logs a
             WHERE a.group_id = m.group_id AND a.user_id = m.user_id AND a.action = 'USER_KICKED') AS previous_kicks
     FROM members m
     JOIN groups g ON g.id = m.group_id
     JOIN users u ON u.id = m.user_id
     WHERE m.status = 'PENDING' AND m.verification_deadline IS NOT NULL AND m.verification_deadline < now()
       AND EXISTS (SELECT 1 FROM nft_rules r WHERE r.group_id = m.group_id AND r.is_active = true)`,
  );

  for (const row of result.rows) {
    const isBan = parseInt(row.previous_kicks) >= 4;

    // Only update DB + audit log if the ban/kick actually succeeded. Telegram
    // rejects attempts to ban group creators (and some other edge cases), so
    // optimistically flipping status to KICKED would leave stale state — user
    // visible in the group but marked KICKED in DB. Next cron tick retries.
    let kickSuccess = false;
    try {
      if (isBan) {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id));
      } else {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id), {
          until_date: Math.floor(Date.now() / 1000) + 40,
        });
      }
      kickSuccess = true;
    } catch (err) {
      if (isUserNotParticipantError(err)) {
        // User already left — stop retrying, reconcile DB with reality.
        // Guarded PENDING → LEFT; no USER_KICKED/USER_BANNED audit (we didn't kick).
        await query(`UPDATE members SET status = 'LEFT' WHERE id = $1 AND status = 'PENDING'`, [row.id]);
        removeCheckedPair(row.group_telegram_id, row.user_telegram_id);
        console.log(`[CRON] ${row.user_telegram_id} already left ${row.group_telegram_id} — marked LEFT, skipping kick`);
        continue;
      }
      console.error(`[CRON] Failed to ${isBan ? "ban" : "kick"} expired member:`, err);
    }

    if (!kickSuccess) continue;

    // Guarded UPDATE: only flip PENDING → KICKED. If the user left voluntarily
    // between our SELECT (top of the loop) and this UPDATE, members.status is
    // now LEFT and we'd otherwise overwrite it + log a spurious USER_KICKED on
    // top of the existing USER_LEFT. Same-class race as handleMemberLeft's
    // fix; guarding both sides makes whichever transaction commits first win.
    let didKick = false;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const updateResult = await client.query(
        `UPDATE members SET status = 'KICKED' WHERE id = $1 AND status = 'PENDING'`,
        [row.id],
      );
      if ((updateResult.rowCount ?? 0) > 0) {
        await client.query(
          `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
          [row.group_id, row.user_id, isBan ? "USER_BANNED" : "USER_KICKED",
           JSON.stringify({ reason: isBan ? "Banned after 5 failed verifications" : "Verification timeout" })],
        );
        didKick = true;
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[CRON] Failed to update kick status:", err);
    } finally {
      client.release();
    }

    if (didKick) {
      // Clear from existing-member cache so they get re-checked if they rejoin
      removeCheckedPair(row.group_telegram_id, row.user_telegram_id);
      console.log(`[CRON] ${isBan ? "Banned" : "Kicked"} expired: ${row.user_telegram_id} from ${row.group_telegram_id}`);
    }
  }
}

async function leaveUnverifiedGroups(bot: Bot) {
  // No-op in open-access mode — no pass exists to enforce, so nothing here
  // should ever make the bot leave. Mirrors recheckAdminPassOwnership, and
  // guards the switch-from-early-to-open case where deadlines were left armed.
  if (!process.env.BOUNCER_COLLECTION_ID) return;

  // Triggers for admin_verify_deadline being set:
  //   1. bot-added.ts — adder hasn't linked a wallet yet (initial 5-min window)
  //   2. unlink.ts — an admin ran /unlink; groups they admin get 5 min to re-verify
  //   3. recheckAdminPassOwnership cron — periodic sweep finds a group with no
  //      pass-holding admins and arms the deadline (Fix #2)
  //
  // A group is safe as long as AT LEAST ONE of its group_admins holds the pass.
  // This is the multi-admin fix: the original code only checked groups.admin_user_id
  // (the single first-adder), ignoring co-admins who might still hold the pass.
  //
  // Null handling: if the Enjin API errors on EVERY admin we can't fairly decide,
  // so we skip the tick and let the deadline stay armed for a retry. If we get at
  // least one clean result and none are `true`, the group genuinely has no
  // pass-holding admin and we leave.
  //
  // admin_user_id is kept as provenance (first-adder) but no longer load-bearing.
  const result = await query(
    `SELECT g.id, g.telegram_id
     FROM groups g
     WHERE g.admin_verify_deadline IS NOT NULL
       AND g.admin_verify_deadline < now()`,
  );

  for (const row of result.rows) {
    const admins = await query(
      `SELECT u.wallet_address
       FROM group_admins ga
       JOIN users u ON u.id = ga.user_id
       WHERE ga.group_id = $1 AND u.wallet_address IS NOT NULL`,
      [row.id],
    );

    let anyHolds = false;
    let sawCleanResult = false;

    for (const admin of admins.rows) {
      const passResult = await hasBouncerPass(admin.wallet_address);
      if (passResult === null) continue; // API error — try the next admin
      sawCleanResult = true;
      if (passResult === true) {
        anyHolds = true;
        break;
      }
    }

    if (anyHolds) {
      // At least one admin holds the pass — clear the deadline, keep the group.
      await query(`UPDATE groups SET admin_verify_deadline = NULL WHERE id = $1`, [row.id]);
      continue;
    }

    if (admins.rows.length > 0 && !sawCleanResult) {
      // Every admin check errored — can't fairly decide, skip this tick and retry next minute.
      console.warn(
        `[CRON] Skipping leave check for group ${row.telegram_id} — every admin pass check errored`,
      );
      continue;
    }

    // No admins with wallets OR at least one clean `false` with zero `true`:
    // no admin holds the pass. Leave the group and delete the DB row.
    // Cascade removes group_admins, nft_rules, members, audit_logs.
    // Best-effort farewell — a failed send (bot muted, rate limited) must not
    // block the leave below.
    try {
      await bot.api.sendMessage(
        parseInt(row.telegram_id),
        "No admin has a valid Bouncer Pass. Leaving group.",
      );
    } catch (err) {
      console.error(`[CRON] Failed to send leave notice to ${row.telegram_id}:`, err);
    }

    // Only delete the DB row after we've actually left. If leaveChat fails we
    // keep the row (deadline still armed) so the next tick retries, instead of
    // deleting state while still a member — which would let getOrCreateGroup
    // recreate the group rule-less on the next join and auto-verify everyone.
    try {
      await bot.api.leaveChat(parseInt(row.telegram_id));
    } catch (err) {
      console.error(`[CRON] Failed to leave group ${row.telegram_id}, keeping row for retry:`, err);
      continue;
    }

    await query(`DELETE FROM groups WHERE id = $1`, [row.id]);

    console.log(`[CRON] Left group ${row.telegram_id} — no admin holds a Bouncer Pass`);
  }
}

// Periodic sweep: for every active group with NO currently-armed
// admin_verify_deadline, verify that at least one admin still holds the
// Bouncer Pass. If none do, arm the 5-min deadline — leaveUnverifiedGroups
// will enforce the eventual kick. Catches the "admin transferred their pass
// without /unlink'ing" case that the original early-access system missed.
//
// Why arm instead of leaving immediately: admins deserve the same 5-min grace
// window that the /unlink and bot-added flows give. This keeps enforcement
// consistent across all triggers.
//
// Why guard on `admin_verify_deadline IS NULL`: if a deadline is already
// running (set by /unlink, bot-added, or a prior recheck cycle), we don't want
// to reset it to a newer timestamp — that would extend their grace window
// forever as long as we keep detecting them as Pass-less. The existing
// countdown will fire on its own schedule.
//
// Null handling mirrors leaveUnverifiedGroups: if every admin check errored,
// skip this group this cycle and retry next 5-minute tick.
async function recheckAdminPassOwnership(_bot: Bot) {
  // No-op in open-access mode — no pass exists to check against. Saves a DB
  // query + Enjin API round-trips every 5 minutes.
  if (!process.env.BOUNCER_COLLECTION_ID) return;

  const groups = await query(
    `SELECT id, telegram_id
     FROM groups
     WHERE is_active = true
       AND admin_verify_deadline IS NULL`,
  );

  let armedCount = 0;

  for (const group of groups.rows) {
    const admins = await query(
      `SELECT u.wallet_address
       FROM group_admins ga
       JOIN users u ON u.id = ga.user_id
       WHERE ga.group_id = $1 AND u.wallet_address IS NOT NULL`,
      [group.id],
    );

    let anyHolds = false;
    let sawCleanResult = false;

    for (const admin of admins.rows) {
      const passResult = await hasBouncerPass(admin.wallet_address);
      if (passResult === null) continue;
      sawCleanResult = true;
      if (passResult === true) {
        anyHolds = true;
        break;
      }
    }

    if (anyHolds) continue; // at least one admin still holds — nothing to do

    if (admins.rows.length > 0 && !sawCleanResult) {
      // Every admin check errored this cycle — can't fairly decide, try again
      // in 5 minutes. This group either has a real problem (all admins lack
      // the pass) or Enjin is flaky; either way, don't arm a deadline on
      // unreliable data.
      continue;
    }

    // No admin holds the pass (either zero wallets to check, or at least one
    // clean `false` and zero `true`). Arm the deadline — but only if none is
    // set, to avoid resetting an existing countdown. Race-safe: the WHERE
    // clause re-checks admin_verify_deadline at UPDATE time.
    const updateResult = await query(
      `UPDATE groups
       SET admin_verify_deadline = now() + interval '5 minutes'
       WHERE id = $1 AND admin_verify_deadline IS NULL`,
      [group.id],
    );

    if ((updateResult.rowCount ?? 0) > 0) {
      armedCount++;
      console.log(
        `[CRON] Armed admin-verify deadline for group ${group.telegram_id} — no admin holds a Bouncer Pass`,
      );
    }
  }

  if (armedCount > 0) {
    console.log(`[CRON] Admin pass recheck done. Armed ${armedCount} group(s).`);
  }
}