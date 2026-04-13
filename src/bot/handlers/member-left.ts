import { Context } from "grammy";
import { query } from "../../shared/db.js";

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

  await query(`UPDATE members SET status = 'LEFT' WHERE id = $1`, [member.id]);
  await query(
    `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [member.group_id, member.user_id, "USER_LEFT", JSON.stringify({ telegramId })],
  );

  console.log(`[BOT] Member ${telegramId} left group ${chatId}`);
}
