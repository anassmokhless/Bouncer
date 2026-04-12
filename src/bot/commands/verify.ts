import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { requestAccountVerification } from "../../shared/enjin.js";
import { getOrCreateUser } from "../helpers.js";

export async function verifyCommand(ctx: Context) {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Please DM me to verify your wallet.");
    return;
  }

  const from = ctx.from;
  if (!from) return;

  const telegramId: string = from.id.toString();
  const user = await getOrCreateUser(
    telegramId,
    from.username,
    from.first_name,
  );

  // Check if already verified
  if (user.wallet_address) {
    await ctx.reply(
      `You already have a wallet linked: \`${user.wallet_address}\`\n\nUse /unlink to remove it first.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Check for existing pending verification
  const pending = await query(
    `SELECT id FROM pending_verifications WHERE user_id = $1 AND expires_at > now()`,
    [user.id],
  );

  //if already pending verification
  if (pending.rows.length > 0) {
    await ctx.reply(
      "You already have a pending verification. Please scan the QR code sent earlier.",
    );
    return;
  }

  // Request QR code from Enjin
  let qrCode: string;
  let verificationId: string;

  try {
    const result = await requestAccountVerification();
    qrCode = result.qrCode;
    verificationId = result.verificationId;
  } catch (error) {
    console.error("[VERIFY] Failed to request account verification:", error);
    await ctx.reply("Failed to generate QR code. Please try again later.");
    return;
  }

  // Store in DB — cron job will poll for completion
  await query(
    `INSERT INTO pending_verifications (user_id, verification_id, telegram_chat_id)
     VALUES ($1, $2, $3)`,
    [user.id, verificationId, ctx.chat!.id.toString()],
  );

  await ctx.replyWithPhoto(qrCode, {
    caption: [
      "Scan this QR code with your **Enjin Wallet** app to verify your wallet.",
      "",
      "I'll notify you once the verification is confirmed (up to 5 minutes).",
    ].join("\n"),
    parse_mode: "Markdown",
  });
}
