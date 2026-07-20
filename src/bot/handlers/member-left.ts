import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";
import { removeCheckedPair } from "./existing-member.js";

// On admin → non-admin, drop the user's group_admins row so a demoted admin no
// longer counts toward the early-access gate. No-op if they weren't recorded.
export async function handleAdminDemoted(ctx: Context) {
  const update = ctx.chatMember;
  if (!update || !ctx.chat) return;

  const telegramId = update.new_chat_member.user.id.toString();
  const chatId = ctx.chat.id.toString();

  // Swallow errors: the router calls this then handleMemberLeft independently,
  // so a throw here must not skip the LEFT write on a demote-straight-to-kicked.
  try {
    const result = await query(
      `DELETE FROM group_admins
       WHERE group_id = (SELECT id FROM groups WHERE telegram_id = $1)
         AND user_id = (SELECT id FROM users WHERE telegram_id = $2)`,
      [chatId, telegramId],
    );

    if ((result.rowCount ?? 0) > 0) {
      console.log(
        `[BOT] Admin demoted: removed ${telegramId} from group_admins for ${chatId}`,
      );
    }
  } catch (err) {
    console.error(`[BOT] Failed to prune group_admins for demoted ${telegramId} in ${chatId}:`, err);
  }
}

export async function handleMemberLeft(ctx: Context) {
  const update = ctx.chatMember;
  if (!update || !ctx.chat) return;

  const newStatus = update.new_chat_member.status;
  if (newStatus !== "left" && newStatus !== "kicked") return;

  // Ignore removals the bot itself performed — the kick paths own the status
  // write and the kick audit. Telegram often delivers this event before the
  // kick transaction commits, so handling it here would race ahead and write a
  // spurious USER_LEFT, dropping the USER_KICKED the ban escalation counts.
  if (update.from.id === ctx.me.id) {
    console.log(`[BOT] chat_member removal of ${update.new_chat_member.user.id} in ${ctx.chat.id} was bot-initiated — kick path owns the DB transition`);
    return;
  }

  const telegramId = update.new_chat_member.user.id.toString();
  const chatId = ctx.chat.id.toString();

  // Atomic UPDATE...RETURNING guarded on status IN (VERIFIED, PENDING): only
  // flip live members to LEFT, never overwrite a KICKED a cron just committed.
  let didUpdate = false;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE members SET status = 'LEFT'
       FROM groups g, users u
       WHERE members.group_id = g.id
         AND members.user_id = u.id
         AND g.telegram_id = $1
         AND u.telegram_id = $2
         AND members.status IN ('VERIFIED', 'PENDING')
       RETURNING members.id, members.group_id, members.user_id`,
      [chatId, telegramId],
    );

    if (result.rows.length > 0) {
      const member = result.rows[0];
      await client.query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [member.group_id, member.user_id, "USER_LEFT", JSON.stringify({ telegramId })],
      );
      didUpdate = true;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BOT] Failed to update member-left status:", err);
  } finally {
    client.release();
  }

  if (didUpdate) {
    // Clear the cache so they re-check on rejoin.
    removeCheckedPair(chatId, telegramId);
    console.log(`[BOT] Member ${telegramId} left group ${chatId}`);
  }
}
