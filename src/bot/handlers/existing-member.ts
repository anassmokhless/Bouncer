import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateUser, safeMute, escapeHtml } from "../helpers.js";

// Per-(chat,user) cache. 'skip' = verified/admin/rule-less group, skip the flow;
// 'delete' = PENDING, delete their messages (covers basic groups where mute fails).
const CACHE_TTL_MS = 60 * 60 * 1000; // 1h — after a check, or on the pending path
const ADMIN_TTL_MS = 5 * 60 * 1000;  // 5m — short so demotions take effect quickly
const ERROR_BACKOFF_MS = 30 * 1000;  // 30s — backoff after an API error

type CacheEntry = { validUntil: number; mode: "skip" | "delete" };

// Cap so a raid flooding unique (chatId, userId) pairs can't balloon the Map
// before the hourly prune (~7MB at 50K). FIFO eviction; an evicted user re-checks.
const MAX_CACHE_SIZE = 50_000;
const checkedPairs = new Map<string, CacheEntry>();

// Set a cache entry; FIFO-evict the oldest when at the cap.
function setChecked(key: string, validUntil: number, mode: "skip" | "delete" = "skip") {
  // An existing key updates in place; only a new key at the cap needs eviction.
  if (checkedPairs.size >= MAX_CACHE_SIZE && !checkedPairs.has(key)) {
    const oldest = checkedPairs.keys().next().value;
    if (oldest !== undefined) checkedPairs.delete(oldest);
  }
  checkedPairs.set(key, { validUntil, mode });
}

// Remove a pair so the user re-checks on their next message.
export function removeCheckedPair(chatId: string, userId: string) {
  checkedPairs.delete(`${chatId}:${userId}`);
}

// Drop expired entries.
export function pruneCheckedPairs() {
  const now = Date.now();
  for (const [key, entry] of checkedPairs) {
    if (entry.validUntil <= now) checkedPairs.delete(key);
  }
}

// "Send as channel" post in a group with active rules — delete it. Rule-less
// groups enforce nothing, so the post stays.
async function deleteChannelPost(ctx: Context) {
  const groupResult = await query(
    `SELECT g.id FROM groups g
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.telegram_id = $1
     LIMIT 1`,
    [ctx.chat!.id.toString()],
  );
  if (groupResult.rows.length === 0) return;

  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.error("[BOT] Failed to delete send-as-channel message:", err);
  }
}

export async function handleExistingMember(ctx: Context) {
  if (!ctx.message || !ctx.chat || ctx.chat.type === "private") return;

  // Channel posts auto-forwarded into a linked discussion group arrive as the
  // Telegram service user (777000) with sender_chat set — never gate those, or
  // every channel post gets deleted and 777000 ends up PENDING.
  if (ctx.message.is_automatic_forward) return;

  if (ctx.senderChat) {
    // Anonymous admins post as the group itself — only admins can do that.
    if (ctx.senderChat.id === ctx.chat.id) return;
    // Any other sender_chat is "send as channel": the real sender is
    // unattributable and can't be verified, so in a ruled group the message is
    // removed. Without this, an unverified member could bypass gating by
    // posting as any channel they own.
    await deleteChannelPost(ctx);
    return;
  }

  if (!ctx.from || ctx.from.is_bot) return;

  const chatId = ctx.chat.id.toString();
  const userId = ctx.from.id.toString();
  const key = `${chatId}:${userId}`;

  // Cache fast-path: 'skip' returns, 'delete' deletes the message and returns.
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

  if (groupResult.rows.length === 0) { setChecked(key, Date.now() + CACHE_TTL_MS); return; } // no rules — skip
  const groupId = groupResult.rows[0].id;

  const memberResult = await query(
    `SELECT m.status FROM members m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND u.telegram_id = $2`,
    [groupId, userId],
  );

  if (memberResult.rows.length > 0 && memberResult.rows[0].status === "VERIFIED") { setChecked(key, Date.now() + CACHE_TTL_MS); return; }

  // Not verified — don't restrict admins.
  try {
    const chatMember = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (chatMember.status === "administrator" || chatMember.status === "creator") { setChecked(key, Date.now() + ADMIN_TTL_MS); return; }
  } catch (err) {
    console.error("[BOT] Failed to check admin status:", err);
    // Short backoff so message spam during an API blip doesn't fire a getChatMember each.
    setChecked(key, Date.now() + ERROR_BACKOFF_MS);
    return;
  }

  const user = await getOrCreateUser(userId, ctx.from.username, ctx.from.first_name);

  // Try auto-verify against the group's rules.
  if (user.wallet_address) {
    const rules = await query(
      `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
      [groupId],
    );

    let sawNull = false;

    for (const rule of rules.rows) {
      const hasNft = await checkNftOwnership(
        user.wallet_address,
        rule.collection_id,
        rule.token_id,
        rule.min_balance,
      );

      if (hasNft === null) { sawNull = true; continue; }
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

        setChecked(key, Date.now() + CACHE_TTL_MS); return; // verified — don't restrict
      }
    }

    // Rules are OR'd — an errored rule may be the one they hold, so any null
    // without a match is inconclusive: skip with a backoff instead of
    // restricting. Their next message re-evaluates once Enjin recovers.
    if (rules.rows.length > 0 && sawNull) {
      console.log(`[BOT] Skipped existing member ${userId} in ${chatId} — Enjin check inconclusive`);
      setChecked(key, Date.now() + ERROR_BACKOFF_MS);
      return;
    }
  }

  // Not verified: delete this message (works everywhere) and mute future ones
  // (no-op in basic groups).
  try {
    await ctx.deleteMessage();
  } catch (err) {
    console.error("[BOT] Failed to delete message from existing member:", err);
  }

  await safeMute(ctx.api, ctx.chat.id, ctx.from.id);

  // PENDING with a 24h deadline. Preserve an existing pending deadline so a
  // spammer can't reset it by sending messages.
  const upsert = await query(
    `INSERT INTO members (group_id, user_id, status, verification_deadline)
     VALUES ($1, $2, 'PENDING', now() + interval '24 hours')
     ON CONFLICT (group_id, user_id) DO UPDATE SET
       status = 'PENDING',
       verification_deadline = CASE
         WHEN members.status = 'PENDING' AND members.verification_deadline IS NOT NULL
           THEN members.verification_deadline
         ELSE now() + interval '24 hours'
       END
     RETURNING verification_deadline`,
    [groupId, user.id],
  );

  // Prompt on every full-flow pass (throttled to ~once per cache TTL), so members
  // who became PENDING elsewhere (unlink, re-gate sweep) also get told why. Hours
  // come from the actual deadline, so a 1h window isn't reported as 24h.
  const deadline: Date | null = upsert.rows[0]?.verification_deadline ?? null;
  const hoursLeft = deadline ? Math.max(1, Math.ceil((deadline.getTime() - Date.now()) / 3600000)) : 24;
  try {
    await ctx.reply([
      `${escapeHtml(ctx.from.first_name || "")}, access to this group requires an Enjin NFT.`,
      "",
      "Your messages will be removed until you verify your wallet.",
      `<a href="https://t.me/${process.env.BOT_USERNAME}?start=verify">Start verification</a>`,
      "",
      hoursLeft <= 1
        ? "You have less than an hour to verify or you'll be removed."
        : `You have about ${hoursLeft} hours to verify or you'll be removed.`,
    ].join("\n"), { parse_mode: "HTML" });
  } catch (err) {
    console.error("[BOT] Failed to send verification prompt:", err);
  }

  // 'delete' mode; cleared by cron.ts on successful verification.
  setChecked(key, Date.now() + CACHE_TTL_MS, "delete");
  console.log(`[BOT] Existing member ${userId} pending verification in ${chatId} — message deleted`);
}
