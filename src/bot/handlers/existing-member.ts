import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateUser, safeMute, escapeHtml } from "../helpers.js";

// Per-entry cache with TWO modes:
//   - 'skip'   → user is verified / admin / in a group without rules. Skip the full flow.
//   - 'delete' → user is PENDING. Delete every message they send until the entry expires
//                or is cleared (e.g., on successful verification). Supports basic groups
//                where Telegram's mute API doesn't work.
//
// Different TTLs per scenario: successful check → 1 hour, admin → 5 min (so demotions
// take effect quickly), API error → 30 sec backoff (prevent 429 cascades), pending →
// 1 hour (cleared early by cron.ts when user verifies via QR).
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — normal TTL after a successful check or on pending path
const ADMIN_TTL_MS = 5 * 60 * 1000;  // 5 minutes — shorter TTL for admin status so demotions take effect quickly
const ERROR_BACKOFF_MS = 30 * 1000;  // 30 seconds — short backoff after an API error

type CacheEntry = { validUntil: number; mode: "skip" | "delete" };

// Hard size cap protects against memory amplification in raid-style attacks where
// attackers flood a gated group with many unique (chatId, userId) pairs faster than
// the hourly prune can reclaim expired entries. Without this, a SIM-farm raid could
// push the Map into hundreds of MB before the next prune runs. At ~140 bytes/entry,
// 50K caps memory at ~7MB. Eviction is FIFO (oldest insertion first) since Map
// preserves insertion order; an evicted legitimate user just re-checks on their next
// message (2 DB queries + 1 Telegram API call — not free but not harmful).
const MAX_CACHE_SIZE = 50_000;
const checkedPairs = new Map<string, CacheEntry>();

/** Set a cache entry, enforcing the size cap via FIFO eviction when full */
function setChecked(key: string, validUntil: number, mode: "skip" | "delete" = "skip") {
  // Only evict if we're at the cap AND this is a brand-new key — if key already
  // exists, .set() updates in place without growing the Map.
  if (checkedPairs.size >= MAX_CACHE_SIZE && !checkedPairs.has(key)) {
    const oldest = checkedPairs.keys().next().value;
    if (oldest !== undefined) checkedPairs.delete(oldest);
  }
  checkedPairs.set(key, { validUntil, mode });
}

/** Remove a specific pair so the user gets re-checked on next message */
export function removeCheckedPair(chatId: string, userId: string) {
  checkedPairs.delete(`${chatId}:${userId}`);
}

/** Prune all expired entries from the cache */
export function pruneCheckedPairs() {
  const now = Date.now();
  for (const [key, entry] of checkedPairs) {
    if (entry.validUntil <= now) checkedPairs.delete(key);
  }
}

export async function handleExistingMember(ctx: Context) {
  if (!ctx.message || !ctx.chat || ctx.chat.type === "private") return;
  if (!ctx.from || ctx.from.is_bot) return;

  const chatId = ctx.chat.id.toString();
  const userId = ctx.from.id.toString();
  const key = `${chatId}:${userId}`;

  // Cache fast-path. Two modes:
  //   'skip'   → user was recently verified / admin / in a rule-less group → return
  //   'delete' → user is known-PENDING → delete this message and return (no DB/API work)
  // Entries are cleared by cron.ts when a user verifies via QR so their next message goes through.
  const cached = checkedPairs.get(key);
  if (cached && Date.now() < cached.validUntil) {
    if (cached.mode === "delete") {
      try {
        await ctx.deleteMessage();
      } catch (err) {
        console.error("[BOT] Failed to delete cached-pending message:", err);
      }
    }
    return;
  }

  // Check if group has active rules
  const groupResult = await query(
    `SELECT g.id FROM groups g
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.telegram_id = $1
     LIMIT 1`,
    [chatId],
  );

  if (groupResult.rows.length === 0) { setChecked(key, Date.now() + CACHE_TTL_MS); return; } // No rules — skip
  const groupId = groupResult.rows[0].id;

  // Check if user is already tracked as VERIFIED
  const memberResult = await query(
    `SELECT m.status FROM members m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND u.telegram_id = $2`,
    [groupId, userId],
  );

  if (memberResult.rows.length > 0 && memberResult.rows[0].status === "VERIFIED") { setChecked(key, Date.now() + CACHE_TTL_MS); return; }

  // User is not verified — check if they're an admin (don't restrict admins)
  try {
    const chatMember = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (chatMember.status === "administrator" || chatMember.status === "creator") { setChecked(key, Date.now() + ADMIN_TTL_MS); return; }
  } catch (err) {
    console.error("[BOT] Failed to check admin status:", err);
    // Short backoff so spamming messages during a Telegram API blip don't each trigger
    // another getChatMember call (429 cascade protection). 30s is short enough that an
    // admin briefly mis-classified during the blip is re-checked quickly after recovery.
    setChecked(key, Date.now() + ERROR_BACKOFF_MS);
    return;
  }

  // Get or create user record
  const user = await getOrCreateUser(userId, ctx.from.username, ctx.from.first_name);

  // If user has a wallet, try auto-verify
  if (user.wallet_address) {
    const rules = await query(
      `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
      [groupId],
    );

    let gotCleanApiResult = false;

    for (const rule of rules.rows) {
      const hasNft = await checkNftOwnership(
        user.wallet_address,
        rule.collection_id,
        rule.token_id,
        rule.min_balance,
      );

      if (hasNft === null) continue;
      gotCleanApiResult = true;
      if (hasNft) {
        await query(
          `INSERT INTO members (group_id, user_id, status, last_checked)
           VALUES ($1, $2, 'VERIFIED', now())
           ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED', last_checked = now()`,
          [groupId, user.id],
        );

        await query(
          `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
          [groupId, user.id, "USER_AUTO_VERIFIED", JSON.stringify({ collectionId: rule.collection_id })],
        );

        setChecked(key, Date.now() + CACHE_TTL_MS); return; // Verified — don't restrict
      }
    }

    // If every rule check errored, we can't fairly evaluate this user — skip without
    // deleting or restricting. Short backoff so subsequent messages during the outage
    // don't each re-trigger the full Enjin API check. Once the API recovers, the
    // recheck cron or the user's next message (after backoff expires) will restrict
    // them if they truly don't hold the required NFTs.
    if (rules.rows.length > 0 && !gotCleanApiResult) {
      console.log(`[BOT] Skipped existing member ${userId} in ${chatId} — Enjin API errored on all rules`);
      setChecked(key, Date.now() + ERROR_BACKOFF_MS);
      return;
    }
  }

  // Not verified. Two-pronged defense:
  //   1. Delete the current message immediately (works in basic groups AND supergroups).
  //   2. Attempt to mute so future messages never arrive (works in supergroups; no-ops in
  //      basic groups — safeMute detects this and silent-skips after the first 400).
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.error("[BOT] Failed to delete message from existing member:", err);
  }

  await safeMute(ctx.api, ctx.chat.id, ctx.from.id);

  // Was the user already in PENDING state? If so, we've already sent them a prompt on
  // an earlier message (before the delete cache was set) and shouldn't spam another.
  const wasAlreadyPending =
    memberResult.rows.length > 0 && memberResult.rows[0].status === "PENDING";

  // Set as pending with 24-hour deadline for existing members. Only set a new deadline
  // when transitioning INTO pending — if they're already pending, preserve their
  // existing deadline so a persistent spammer can't avoid the kick by sending messages.
  await query(
    `INSERT INTO members (group_id, user_id, status, verification_deadline)
     VALUES ($1, $2, 'PENDING', now() + interval '24 hours')
     ON CONFLICT (group_id, user_id) DO UPDATE SET
       status = 'PENDING',
       verification_deadline = CASE
         WHEN members.status = 'PENDING' AND members.verification_deadline IS NOT NULL
           THEN members.verification_deadline
         ELSE now() + interval '24 hours'
       END`,
    [groupId, user.id],
  );

  if (!wasAlreadyPending) {
    try {
      // HTML parse mode (not Markdown v1) — see the matching change in
      // new-member.ts for full rationale. Short version: first_name can
      // contain `_` / `*` / etc. which break Markdown v1 parsing mid-message.
      await ctx.reply([
        `${escapeHtml(ctx.from.first_name || "")}, access to this group requires an Enjin NFT.`,
        "",
        "Your messages will be removed until you verify your wallet.",
        `<a href="https://t.me/${process.env.BOT_USERNAME}?start=verify">Start verification</a>`,
        "",
        "You have 24 hours to verify or you'll be removed.",
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err) {
      console.error("[BOT] Failed to send verification prompt:", err);
    }
  }

  // Cache in 'delete' mode so subsequent messages from this user are deleted
  // immediately without re-running the full check flow. Cleared by cron.ts on
  // successful verification so their next message goes through cleanly.
  setChecked(key, Date.now() + CACHE_TTL_MS, "delete");
  console.log(`[BOT] Existing member ${userId} pending verification in ${chatId} — message deleted`);
}
