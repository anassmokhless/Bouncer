import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import { Bot, GrammyError, HttpError } from "grammy";
import { pool } from "../shared/db.js";
import { verifyCommand } from "./commands/verify.js";
import { unlinkCommand } from "./commands/unlink.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommands } from "./commands/setup.js";
import { handleNewMembers } from "./handlers/new-member.js";
import { startCronJobs } from "./cron.js";

const bot = new Bot(process.env.BOT_TOKEN!);

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
bot.on(":new_chat_members", handleNewMembers);

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
function shutdown() {
  console.log("[BOT] Shutting down...");
  bot.stop();
  pool.end().then(() => {
    console.log("[BOT] Stopped.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("[BOT] Starting...");
  startCronJobs(bot);
  await bot.start({
    onStart: () => console.log("[BOT] Running! Listening for messages..."),
    allowed_updates: ["message", "chat_member", "callback_query"],
  });
}

main().catch((err) => {
  console.error("[BOT] Fatal error:", err);
  process.exit(1);
});
