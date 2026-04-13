import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateUser } from "../helpers.js";

// TTL cache: checked user-group pairs expire after 1 hour
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const checkedPairs = new Map<string, number>();

/** Remove a specific pair so the user gets re-checked on next message */
export function removeCheckedPair(chatId: string, userId: string) {
  checkedPairs.delete(`${chatId}:${userId}`);
}

/** Prune all expired entries from the cache */
export function pruneCheckedPairs() {
  const now = Date.now();
  for (const [key, timestamp] of checkedPairs) {
    if (now - timestamp > CACHE_TTL_MS) checkedPairs.delete(key);
  }
}

export async function handleExistingMember(ctx: Context) {
  if (!ctx.message || !ctx.chat || ctx.chat.type === "private") return;
  if (!ctx.from || ctx.from.is_bot) return;

  const chatId = ctx.chat.id.toString();
  const userId = ctx.from.id.toString();
  const key = `${chatId}:${userId}`;

  // Already checked within TTL — skip
  const lastChecked = checkedPairs.get(key);
  if (lastChecked && Date.now() - lastChecked < CACHE_TTL_MS) return;
  checkedPairs.set(key, Date.now());

  // Check if group has active rules
  const groupResult = await query(
    `SELECT g.id FROM groups g
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.telegram_id = $1
     LIMIT 1`,
    [chatId],
  );

  if (groupResult.rows.length === 0) return; // No rules — skip
  const groupId = groupResult.rows[0].id;

  // Check if user is already tracked as VERIFIED
  const memberResult = await query(
    `SELECT m.status FROM members m
     JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND u.telegram_id = $2`,
    [groupId, userId],
  );

  if (memberResult.rows.length > 0 && memberResult.rows[0].status === "VERIFIED") return;

  // User is not verified — check if they're an admin (don't restrict admins)
  try {
    const chatMember = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (chatMember.status === "administrator" || chatMember.status === "creator") return;
  } catch (err) {
    console.error("[BOT] Failed to check admin status:", err);
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

    for (const rule of rules.rows) {
      const hasNft = await checkNftOwnership(
        user.wallet_address,
        rule.collection_id,
        rule.token_id,
        rule.min_balance,
      );

      if (hasNft === null) continue;
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

        return; // Verified — don't restrict
      }
    }
  }

  // Not verified — restrict and prompt
  try {
    await ctx.api.restrictChatMember(ctx.chat.id, ctx.from.id, {
      can_send_messages: false,
      can_send_audios: false,
      can_send_documents: false,
      can_send_photos: false,
      can_send_videos: false,
      can_send_video_notes: false,
      can_send_voice_notes: false,
      can_send_polls: false,
      can_send_other_messages: false,
      can_add_web_page_previews: false,
      can_change_info: false,
      can_invite_users: false,
      can_pin_messages: false,
      can_manage_topics: false,
    });
  } catch (err) {
    console.error("[BOT] Failed to restrict existing member:", err);
  }

  // Set as pending — offset created_at so the 1-hour cron kicks after 24h total
  await query(
    `INSERT INTO members (group_id, user_id, status, created_at)
     VALUES ($1, $2, 'PENDING', now() + interval '23 hours')
     ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'PENDING', created_at = now() + interval '23 hours'`,
    [groupId, user.id],
  );

  try {
    await ctx.api.sendMessage(ctx.chat.id, [
      `${ctx.from.first_name}, this group requires NFT verification.`,
      "",
      "You are muted until you verify your wallet.",
      `DM me to verify: [Click here to start](https://t.me/${process.env.BOT_USERNAME}?start=verify)`,
      "",
      "You have 24 hours to verify or you'll be removed.",
    ].join("\n"), { parse_mode: "Markdown" });
  } catch (err) {
    console.error("[BOT] Failed to send verification prompt:", err);
  }

  console.log(`[BOT] Existing member ${userId} restricted in ${chatId} — pending verification`);
}
