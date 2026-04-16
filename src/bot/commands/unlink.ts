import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";

export async function unlinkCommand(ctx: Context) {
  if (ctx.chat?.type !== "private") return;
  const from = ctx.from;
  if (!from) return;

  const telegramId: string = from.id.toString();

  const result = await query(
    `SELECT id, wallet_address FROM users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (result.rows.length === 0 || !result.rows[0].wallet_address) {
    await ctx.reply("You don't have a wallet linked. Use /verify to link one.");
    return;
  }

  const user = result.rows[0];

  // Get all groups where this user is VERIFIED (needed for re-restricting)
  const groups = await query(
    `SELECT g.telegram_id AS group_telegram_id
     FROM members m
     JOIN groups g ON g.id = m.group_id
     WHERE m.user_id = $1 AND m.status = 'VERIFIED'`,
    [user.id],
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE users SET wallet_address = NULL, is_verified = false, verified_at = NULL
       WHERE id = $1`,
      [user.id],
    );
    await client.query(
      `UPDATE members SET status = 'PENDING', verification_deadline = now() + interval '1 hour'
       WHERE user_id = $1 AND status = 'VERIFIED'`,
      [user.id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BOT] Failed to unlink wallet:", err);
    await ctx.reply("Something went wrong while unlinking your wallet. Please try again.");
    return;
  } finally {
    client.release();
  }

  // Re-restrict user in all their groups
  for (const group of groups.rows) {
    try {
      await ctx.api.restrictChatMember(group.group_telegram_id, from.id, {
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
      console.error(`[BOT] Failed to restrict user in group ${group.group_telegram_id}:`, err);
    }
  }

  await ctx.reply(
    "Wallet unlinked. Your access to NFT-gated groups has been paused. You have 1 hour to re-verify or you'll be removed.\n\nUse /verify to link a new wallet.",
  );
}