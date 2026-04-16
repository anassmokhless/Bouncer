import cron from "node-cron";
import { Bot } from "grammy";
import { query, pool } from "../shared/db.js";
import { getVerifiedWallet, checkNftOwnership } from "../shared/enjin.js";
import { removeCheckedPair, pruneCheckedPairs } from "./handlers/existing-member.js";

let isPolling = false;
let isRechecking = false;
let isKicking = false;
let isLeaving = false;

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

async function withAdvisoryLock(lockId: number, fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT pg_try_advisory_lock($1) AS locked`, [lockId]);
    if (!result.rows[0].locked) return; // Another instance holds it — skip this tick.
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

  cron.schedule("0 * * * *", async () => {
    if (isKicking) return;
    isKicking = true;
    console.log("[CRON] Checking for expired pending members...");
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
    try {
      await withAdvisoryLock(LOCK_ID_LEAVE, () => leaveUnverifiedGroups(bot));
    } catch (err) {
      console.error("[CRON] Leave unverified groups failed:", err);
    } finally {
      isLeaving = false;
    }
  });

  console.log("[CRON] Jobs scheduled: verify-poll (*/15s), re-check (*/10min), kick-expired (hourly), admin-verify (*/1min)");
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

    for (const [, group] of groupMap) {
      if (group.rules.length === 0) continue;

      for (const rule of group.rules) {
        const hasNft = await checkNftOwnership(
          walletAddress,
          rule.collectionId,
          rule.tokenId,
          rule.minBalance,
        );

        if (hasNft === null) continue; // API error — skip this rule
        if (hasNft) {
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
    }

    // Transaction: link wallet + delete pending + update memberships + audit logs
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `UPDATE users SET wallet_address = $1, is_verified = true, verified_at = now() WHERE id = $2`,
        [walletAddress, row.user_id],
      );

      await client.query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);

      for (const vg of verifiedGroups) {
        await client.query(
          `UPDATE members SET status = 'VERIFIED', last_checked = now() WHERE id = $1`,
          [vg.memberId],
        );
        await client.query(
          `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
          [vg.groupId, row.user_id, "USER_VERIFIED",
           JSON.stringify({ walletAddress, collectionId: vg.collectionId, tokenId: vg.tokenId })],
        );
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

    // Unrestrict verified users in Telegram (outside transaction)
    for (const vg of verifiedGroups) {
      try {
        await bot.api.restrictChatMember(
          parseInt(vg.groupTelegramId),
          parseInt(row.user_telegram_id),
          {
            can_send_messages: true,
            can_send_audios: true,
            can_send_photos: true,
            can_send_voice_notes: true,
            can_send_other_messages: true,
          },
        );
      } catch (err) {
        console.error(`[CRON] Failed to unrestrict user ${row.user_telegram_id}:`, err);
      }
    }

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
        try {
          await bot.api.banChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId), {
            until_date: Math.floor(Date.now() / 1000) + 40,
          });
        } catch (err) {
          console.error(`[CRON] Failed to kick ${member.userTelegramId}:`, err);
        }

        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(`UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1`, [member.memberId]);
          await client.query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [member.groupId, member.userId, "USER_KICKED", JSON.stringify({ reason: "NFT no longer held" })],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          console.error(`[CRON] Failed to update kick status for ${member.userTelegramId}:`, err);
        } finally {
          client.release();
        }

        // Clear from existing-member cache so they get re-checked if they rejoin
        removeCheckedPair(member.groupTelegramId, member.userTelegramId);

        kickedCount++;
      }
    }));
  }

  console.log(`[CRON] Re-check done. Checked: ${checkedCount}, Kicked: ${kickedCount}`);
}

async function kickExpiredPendingMembers(bot: Bot) {
  const result = await query(
    `SELECT m.id, m.group_id, g.telegram_id AS group_telegram_id,
            m.user_id, u.telegram_id AS user_telegram_id,
            (SELECT COUNT(*) FROM audit_logs a
             WHERE a.group_id = m.group_id AND a.user_id = m.user_id AND a.action = 'USER_KICKED') AS previous_kicks
     FROM members m
     JOIN groups g ON g.id = m.group_id
     JOIN users u ON u.id = m.user_id
     WHERE m.status = 'PENDING' AND m.verification_deadline IS NOT NULL AND m.verification_deadline < now()`,
  );

  for (const row of result.rows) {
    const isBan = parseInt(row.previous_kicks) >= 4;

    try {
      if (isBan) {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id));
      } else {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id), {
          until_date: Math.floor(Date.now() / 1000) + 40,
        });
      }
    } catch (err) {
      console.error(`[CRON] Failed to ${isBan ? "ban" : "kick"} expired member:`, err);
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE members SET status = 'KICKED' WHERE id = $1`, [row.id]);
      await client.query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [row.group_id, row.user_id, isBan ? "USER_BANNED" : "USER_KICKED",
         JSON.stringify({ reason: isBan ? "Banned after 5 failed verifications" : "Verification timeout" })],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[CRON] Failed to update kick status:", err);
    } finally {
      client.release();
    }

    // Clear from existing-member cache so they get re-checked if they rejoin
    removeCheckedPair(row.group_telegram_id, row.user_telegram_id);

    console.log(`[CRON] ${isBan ? "Banned" : "Kicked"} expired: ${row.user_telegram_id} from ${row.group_telegram_id}`);
  }
}

async function leaveUnverifiedGroups(bot: Bot) {
  // Atomic: find and delete groups where admin_verify_deadline has passed AND admin still hasn't linked a wallet.
  // The NOT EXISTS check at DELETE time prevents races with pollPendingVerifications updating wallet_address
  // between a separate SELECT and DELETE. group_admins, nft_rules, members, audit_logs all cascade on groups.id.
  const result = await query(
    `DELETE FROM groups g
     WHERE g.admin_verify_deadline IS NOT NULL
       AND g.admin_verify_deadline < now()
       AND NOT EXISTS (
         SELECT 1 FROM users u
         WHERE u.id = g.admin_user_id AND u.wallet_address IS NOT NULL
       )
     RETURNING g.id, g.telegram_id`,
  );

  for (const row of result.rows) {
    try {
      await bot.api.sendMessage(parseInt(row.telegram_id), "Admin did not verify within 5 minutes. Leaving group.");
      await bot.api.leaveChat(parseInt(row.telegram_id));
    } catch (err) {
      console.error(`[CRON] Failed to leave group ${row.telegram_id}:`, err);
    }

    console.log(`[CRON] Left group ${row.telegram_id} — admin did not verify in time`);
  }

  // Clear deadline for admins who verified in time (cleanup so the cron stops evaluating these rows)
  await query(
    `UPDATE groups SET admin_verify_deadline = NULL, admin_user_id = NULL
     WHERE admin_verify_deadline IS NOT NULL
       AND admin_user_id IN (SELECT id FROM users WHERE wallet_address IS NOT NULL)`,
  );
}