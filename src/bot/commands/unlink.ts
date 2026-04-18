import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";
import { safeMute } from "../helpers.js";
import { removeCheckedPair } from "../handlers/existing-member.js";

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

  // Count how many groups this user administers. If they're responsible for any,
  // we'll start a 5-minute admin-verify countdown — leaveUnverifiedGroups checks
  // Bouncer Pass ownership when the deadline expires.
  const adminGroupsResult = await query(
    `SELECT COUNT(*)::int AS count FROM groups WHERE admin_user_id = $1`,
    [user.id],
  );
  const adminGroupCount: number = adminGroupsResult.rows[0].count;

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
    // Start the 5-minute admin-verify countdown on every group this user administers.
    // If they re-verify with a Bouncer-Pass-holding wallet before the deadline,
    // leaveUnverifiedGroups clears the deadline. Otherwise it leaves those groups.
    if (adminGroupCount > 0) {
      await client.query(
        `UPDATE groups SET admin_verify_deadline = now() + interval '5 minutes'
         WHERE admin_user_id = $1`,
        [user.id],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[BOT] Failed to unlink wallet:", err);
    await ctx.reply("Something went wrong while unlinking your wallet. Please try again.");
    return;
  } finally {
    client.release();
  }

  // Re-restrict user in all their groups. Also clear the existing-member cache so
  // their 'skip' entry (left over from when they were VERIFIED) doesn't let them
  // keep posting freely until it naturally expires. On their next message the
  // handler will see status=PENDING and switch them to delete-on-send mode.
  for (const group of groups.rows) {
    await safeMute(ctx.api, group.group_telegram_id, from.id);
    removeCheckedPair(group.group_telegram_id, telegramId);
  }

  // Build the reply — admins of any group get an extra warning about the 5-minute
  // bot-leave deadline on top of the standard member unlink message.
  const lines = ["Wallet unlinked."];
  if (adminGroupCount > 0) {
    lines.push(
      "",
      `⚠️ You administer ${adminGroupCount} group${adminGroupCount === 1 ? "" : "s"} with Bouncer. Re-verify with your Bouncer Pass within 5 minutes or I'll leave ${adminGroupCount === 1 ? "that group" : "those groups"}.`,
    );
  }
  lines.push(
    "",
    "Your access to gated groups (as a member) has been paused. You have 1 hour to re-verify or you'll be removed.",
    "",
    "Use /verify to link a new wallet.",
  );

  await ctx.reply(lines.join("\n"));
}