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

// Advisory-lock ids so crons don't overlap across bot instances (the in-memory
// flags above only cover a single process). pg_try_advisory_lock is non-blocking,
// so an unavailable lock just skips the tick.
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
      // Warn, not info: in a single-instance deployment this should never happen
      // (usually a stuck lock or a pooler quirk, not another bot doing work).
      console.warn(`[CRON] Advisory lock ${lockId} unavailable — skipping tick`);
      return;
    }
    try {
      await fn();
    } finally {
      // Best-effort release; a stuck lock frees itself when the connection drops.
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
  // Poll pending QR verifications every 15s.
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

  // Kick past-deadline members every minute.
  cron.schedule("* * * * *", async () => {
    if (isKicking) return;
    isKicking = true;
    console.log("[CRON] kick-expired tick");
    try {
      await withAdvisoryLock(LOCK_ID_KICK, async () => {
        pruneCheckedPairs();
        await kickExpiredPendingMembers(bot);
      });
    } catch (err) {
      console.error("[CRON] Kick expired failed:", err);
    } finally {
      isKicking = false;
    }
  });

  // Leave groups whose admin-verify deadline expired — every minute.
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

  // Every 5 min, arm the leave-deadline on groups where no admin holds the pass
  // anymore (catches a pass sold/transferred without /unlink). The */1min cron
  // above does the actual leave once the deadline fires.
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

    // Reject a wallet already linked to another account.
    const existing = await query(
      `SELECT id FROM users WHERE wallet_address = $1 AND id != $2`,
      [walletAddress, row.user_id],
    );

    if (existing.rows.length > 0) {
      try {
        await bot.api.sendMessage(parseInt(row.telegram_chat_id),
          "This wallet is already linked to another Telegram account. Please use a different wallet.");
      } catch (err) {
        console.error(`[CRON] Failed to notify ${row.user_telegram_id} of duplicate wallet:`, err);
      }
      // Drop the pending row — retrying can't help while the wallet stays claimed.
      await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      continue;
    }

    // Memberships and their active rules, grouped per group.
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

    const verifiedGroups: Array<{ groupId: string; memberId: string; groupTelegramId: string; collectionId: string; tokenId: string | null }> = [];
    // True if any group's checks were all inconclusive (every rule returned null).
    // We must NOT finalize the verification then — see the guarded delete below.
    let sawInconclusiveGroup = false;

    for (const [, group] of groupMap) {
      if (group.rules.length === 0) {
        // Rule-less group: nothing to verify against, so release the PENDING row
        // back to VERIFIED and unmute. Guarded; no audit (nothing was verified).
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

      // Every rule errored and no match — inconclusive, so retry next tick rather
      // than finalize a possible holder as "no access".
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

      // Keep the pending row when a group was inconclusive so the next tick can
      // retry; deleting it would strand a real holder as PENDING.
      if (!sawInconclusiveGroup) {
        await client.query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      }

      for (const vg of verifiedGroups) {
        // Stmt 1 audits only a real PENDING→VERIFIED transition (guard on
        // status='PENDING'); stmt 2 just refreshes last_checked when already
        // VERIFIED, no audit. LEFT/KICKED matches neither, so status stays put.
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
          // Already VERIFIED — refresh last_checked only, no audit.
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
      // 23505 = another account claimed this wallet in the race between the
      // pre-check and the UPDATE. Drop the pending row and tell the user.
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

    // Unmute the verified groups and clear their cache entries.
    for (const vg of verifiedGroups) {
      await safeUnmute(
        bot.api,
        parseInt(vg.groupTelegramId),
        parseInt(row.user_telegram_id),
      );
      removeCheckedPair(vg.groupTelegramId, row.user_telegram_id);
    }

    // Inconclusive: don't notify yet (a "you don't hold the NFTs" message would
    // be wrong and would repeat every tick). The resolving tick sends the real one.
    if (sawInconclusiveGroup) continue;

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
  // Re-gate wallet-less VERIFIED members of ruled groups — they joined before the
  // group had rules, so nothing else re-checks them. Flip to PENDING with a 24h
  // window and clear their cache so the next message prompts them.
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

  // Load only members due for a recheck (last_checked older than a rule's interval).
  // EXISTS, not a WHERE on the interval, so ALL of a due member's rules load —
  // otherwise a longer-interval rule drops out and causes a false kick.
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

      if (apiError) return; // inconclusive — retry next cycle

      if (stillHoldsNft) {
        await query(`UPDATE members SET last_checked = now() WHERE id = $1`, [member.memberId]);
      } else {
        // Flip to KICKED only if the ban succeeded — Telegram rejects banning
        // group creators, and the next cycle retries.
        let kickSuccess = false;
        try {
          await bot.api.banChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId), {
            until_date: Math.floor(Date.now() / 1000) + 40,
          });
          kickSuccess = true;
        } catch (err) {
          if (isUserNotParticipantError(err)) {
            // Already left — reconcile to LEFT (guarded), no kick audit.
            await query(`UPDATE members SET status = 'LEFT' WHERE id = $1 AND status = 'VERIFIED'`, [member.memberId]);
            removeCheckedPair(member.groupTelegramId, member.userTelegramId);
            console.log(`[CRON] ${member.userTelegramId} already left ${member.groupTelegramId} — marked LEFT, skipping kick`);
            return;
          }
          console.error(`[CRON] Failed to kick ${member.userTelegramId}:`, err);
        }

        if (kickSuccess) {
          // Guard on status='VERIFIED' so we don't overwrite a LEFT that
          // handleMemberLeft may have committed in the meantime.
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
  // The active-rules EXISTS is the "no rules = no enforcement" safety net: never
  // kick from a rule-less group even if a PENDING row with a deadline exists.
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

    // Flip status only if the ban succeeded — Telegram rejects banning group
    // creators; the next tick retries.
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
        // Already left — reconcile to LEFT (guarded), no kick audit.
        await query(`UPDATE members SET status = 'LEFT' WHERE id = $1 AND status = 'PENDING'`, [row.id]);
        removeCheckedPair(row.group_telegram_id, row.user_telegram_id);
        console.log(`[CRON] ${row.user_telegram_id} already left ${row.group_telegram_id} — marked LEFT, skipping kick`);
        continue;
      }
      console.error(`[CRON] Failed to ${isBan ? "ban" : "kick"} expired member:`, err);
    }

    if (!kickSuccess) continue;

    // Guard on status='PENDING' so a voluntary LEFT committed in the meantime
    // isn't overwritten with a spurious KICKED.
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
  // Nothing to enforce in open-access mode.
  if (!process.env.BOUNCER_COLLECTION_ID) return;

  // A group survives as long as any of its group_admins holds the pass. If every
  // admin check errors, skip the tick and leave the deadline armed for a retry.
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
      // Every admin check errored — retry next tick.
      console.warn(
        `[CRON] Skipping leave check for group ${row.telegram_id} — every admin pass check errored`,
      );
      continue;
    }

    // No admin holds the pass: leave and delete the group (cascades child rows).
    // Best-effort farewell — a failed send must not block the leave.
    try {
      await bot.api.sendMessage(
        parseInt(row.telegram_id),
        "No admin has a valid Bouncer Pass. Leaving group.",
      );
    } catch (err) {
      console.error(`[CRON] Failed to send leave notice to ${row.telegram_id}:`, err);
    }

    // Delete the row only after actually leaving — otherwise a rejoin would
    // recreate the group rule-less and auto-verify everyone.
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

// For each active group with no deadline armed, arm the 5-min deadline if no
// admin still holds the pass (leaveUnverifiedGroups then enforces it). Skips
// groups that already have a deadline so a running countdown isn't reset.
async function recheckAdminPassOwnership(_bot: Bot) {
  // Nothing to check in open-access mode.
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
      // Every admin check errored — don't arm on unreliable data; retry next tick.
      continue;
    }

    // No admin holds the pass. Arm the deadline; the WHERE re-checks IS NULL so a
    // running countdown isn't reset.
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