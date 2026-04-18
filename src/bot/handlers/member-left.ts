import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";
import { removeCheckedPair } from "./existing-member.js";

/**
 * Called when a user transitions from administrator/creator to anything else.
 * Prunes their row from `group_admins` so stale "admin on paper only" rows
 * don't keep a group alive through the early-access gate
 * (leaveUnverifiedGroups iterates group_admins and survives the group if any
 * of them still holds the Bouncer Pass — a demoted user shouldn't count).
 *
 * Dispatched from bot/index.ts's chat_member router based on status
 * transition; the routing also calls handleMemberLeft for users who went all
 * the way to left/kicked, so demote-then-leave chains are fully handled.
 *
 * Idempotent: no-op when the user isn't in group_admins (most Telegram admins
 * aren't — only those who ran /addrule or added the bot are recorded).
 */
export async function handleAdminDemoted(ctx: Context) {
  const update = ctx.chatMember;
  if (!update || !ctx.chat) return;

  const telegramId = update.new_chat_member.user.id.toString();
  const chatId = ctx.chat.id.toString();

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
}

export async function handleMemberLeft(ctx: Context) {
  const update = ctx.chatMember;
  if (!update || !ctx.chat) return;

  const newStatus = update.new_chat_member.status;
  if (newStatus !== "left" && newStatus !== "kicked") return;

  const telegramId = update.new_chat_member.user.id.toString();
  const chatId = ctx.chat.id.toString();

  // Find the member in our database
  const result = await query(
    `SELECT m.id, m.group_id, u.id AS user_id
     FROM members m
     JOIN groups g ON g.id = m.group_id
     JOIN users u ON u.id = m.user_id
     WHERE g.telegram_id = $1 AND u.telegram_id = $2 AND m.status IN ('VERIFIED', 'PENDING')`,
    [chatId, telegramId],
  );

  if (result.rows.length === 0) return;

  const member = result.rows[0];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE members SET status = 'LEFT' WHERE id = $1`, [member.id]);
    await client.query(
      `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [member.group_id, member.user_id, "USER_LEFT", JSON.stringify({ telegramId })],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BOT] Failed to update member-left status:", err);
  } finally {
    client.release();
  }

  // Clear from existing-member cache so they get re-checked if they rejoin
  removeCheckedPair(chatId, telegramId);

  console.log(`[BOT] Member ${telegramId} left group ${chatId}`);
}
