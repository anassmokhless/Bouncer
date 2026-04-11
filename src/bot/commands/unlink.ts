import { Context } from "grammy";
import { query } from "../../shared/db.js";

export async function unlinkCommand(ctx: Context) {
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

  await query(
    `UPDATE users SET wallet_address = NULL, is_verified = false, verified_at = NULL
     WHERE id = $1`,
    [user.id],
  );

  await query(
    `UPDATE members SET status = 'PENDING'
     WHERE user_id = $1 AND status = 'VERIFIED'`,
    [user.id],
  );

  await ctx.reply(
    "Wallet unlinked. Your group memberships have been reset to pending.\n\nUse /verify to link a new wallet.",
  );
}