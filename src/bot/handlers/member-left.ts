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

  // Ignore removals the bot itself performed (kick-expired cron, re-check cron,
  // manual dashboard recheck) — those code paths own the members-status write
  // and the USER_KICKED/USER_BANNED audit entry. Telegram often delivers this
  // chat_member update BEFORE the kicking transaction commits, so handling it
  // here would win the race: we'd write LEFT + a USER_LEFT audit first, the
  // kicker's guarded UPDATE would match zero rows, and the kick audit would be
  // lost — silently undercounting the 5-kick ban escalation (which counts
  // USER_KICKED rows). The existing status guard below can't prevent that
  // ordering; checking the actor does.
  if (update.from.id === ctx.me.id) {
    console.log(`[BOT] chat_member removal of ${update.new_chat_member.user.id} in ${ctx.chat.id} was bot-initiated — kick path owns the DB transition`);
    return;
  }

  const telegramId = update.new_chat_member.user.id.toString();
  const chatId = ctx.chat.id.toString();

  // Atomic UPDATE...RETURNING with a status guard. The guard prevents a race
  // where a kick cron has already committed status=KICKED and the Telegram
  // API response to its own banChatMember call triggers THIS chat_member
  // event. Without the guard we'd overwrite KICKED → LEFT and insert a
  // spurious USER_LEFT audit entry on top of the cron's USER_KICKED.
  // Splitting the SELECT from the UPDATE also allowed cron's COMMIT to slip
  // in between them; merging the two into one atomic statement closes the gap.
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
    // Clear from existing-member cache so they get re-checked if they rejoin
    removeCheckedPair(chatId, telegramId);
    console.log(`[BOT] Member ${telegramId} left group ${chatId}`);
  }
}
