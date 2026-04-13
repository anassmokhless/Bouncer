import { Context } from "grammy";
import { query } from "../../shared/db.js";

export async function statusCommand(ctx: Context) {
  if (ctx.chat?.type !== "private") return;
  const from = ctx.from;
  if (!from) return;

  const result = await query(`SELECT * FROM users WHERE telegram_id = $1`, [
    from.id.toString(),
  ]);

  if (result.rows.length === 0) {
    await ctx.reply("You haven't started verification yet. Use /verify to begin.");
    return;
  }

  const user = result.rows[0];

  if (!user.wallet_address) {
    await ctx.reply("You haven't linked a wallet yet. Use /verify to link one.");
    return;
  }

  const lines = [
    `*Wallet:* \`${user.wallet_address}\``,
    `*Verified:* ${user.is_verified ? "Yes" : "No"}`,
  ];

  if (user.verified_at) {
    lines.push(`*Verified at:* ${new Date(user.verified_at).toLocaleString()}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}