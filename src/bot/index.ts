import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import { validateEnv } from "../shared/env.js";
validateEnv();

import { Bot, GrammyError, HttpError } from "grammy";
import { pool } from "../shared/db.js";
import { verifyCommand } from "./commands/verify.js";
import { unlinkCommand } from "./commands/unlink.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommands } from "./commands/setup.js";
import { handleNewMembers } from "./handlers/new-member.js";
import { handleBotAdded } from "./handlers/bot-added.js";
import { handleMemberLeft } from "./handlers/member-left.js";
import { handleExistingMember } from "./handlers/existing-member.js";
import { startCronJobs } from "./cron.js";

const bot = new Bot(process.env.BOT_TOKEN!);

// Block non-admin commands in groups — only DMs and group admins can use commands
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/") && ctx.chat && ctx.chat.type !== "private") {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from!.id);
      if (member.status !== "administrator" && member.status !== "creator") return;
    } catch {
      return;
    }
  }
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Welcome! I gate Telegram groups based on Enjin NFT ownership.",
      "",
      "Commands:",
      "/verify — Link your Enjin wallet (QR code)",
      "/unlink — Remove linked wallet",
      "/status — Check your verification status",
      "/setup — (Admins only) Configure NFT rules",
    ].join("\n"),
  );
});

bot.command("verify", verifyCommand);
bot.command("unlink", unlinkCommand);
bot.command("status", statusCommand);
registerSetupCommands(bot);
bot.on("my_chat_member", handleBotAdded);
bot.on("chat_member", handleMemberLeft);
bot.on(":new_chat_members", handleNewMembers);
bot.on("message", handleExistingMember);

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[BOT] Error handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError)
    console.error("[BOT] Grammy error:", e.description);
  else if (e instanceof HttpError) console.error("[BOT] HTTP error:", e);
  else console.error("[BOT] Unknown error:", e);
});

// Graceful shutdown
async function shutdown() {
  console.log("[BOT] Shutting down...");
  await bot.stop();
  await pool.end();
  console.log("[BOT] Stopped.");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("[BOT] Starting...");
  startCronJobs(bot);
  await bot.start({
    onStart: () => console.log("[BOT] Running! Listening for messages..."),
    allowed_updates: ["message", "chat_member", "my_chat_member", "callback_query"],
  });
}

main().catch((err) => {
  console.error("[BOT] Fatal error:", err);
  process.exit(1);
});
