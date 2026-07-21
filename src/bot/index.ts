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
import { handleNewMembers, handleChatMemberJoined } from "./handlers/new-member.js";
import { handleBotAdded, handleBotRemoved } from "./handlers/bot-added.js";
import { handleMemberLeft, handleAdminDemoted } from "./handlers/member-left.js";
import { handleExistingMember, removeCheckedPair } from "./handlers/existing-member.js";
import { handleChatMigration } from "./handlers/migrate.js";
import { startCronJobs } from "./cron.js";

const bot = new Bot(process.env.BOT_TOKEN!);

// Block non-admin commands in groups — only DMs and group admins can use commands.
// Note: when blocking a non-admin, we still run handleExistingMember inline so the
// group's NFT-gating logic applies to slash-command messages too. Without this,
// unverified users could bypass message deletion by prefixing every message with "/".
bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/") && ctx.chat && ctx.chat.type !== "private") {
    // Anonymous admins ("Remain Anonymous") post as the group itself:
    // sender_chat === chat, and only admins can do that — that IS the admin
    // proof. Their ctx.from is the GroupAnonymousBot service account, so the
    // getChatMember lookup below would fail/return non-admin and silently
    // swallow every command from an anonymous owner.
    if (ctx.senderChat?.id === ctx.chat.id) {
      await next();
      return;
    }
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from!.id);
      if (member.status !== "administrator" && member.status !== "creator") {
        await handleExistingMember(ctx);
        return;
      }
    } catch (err) {
      // Admin check failed (Telegram blip / 429). Fail CLOSED, not open: defer
      // to handleExistingMember rather than silently dropping through. Its cache
      // fast-path still deletes a known-PENDING user's message with no API call,
      // so a `/`-prefix can't bypass gating during an outage; if the user isn't
      // cached it applies its own backoff. Either way the command is blocked.
      console.error("[BOT] Command-gate admin check failed, deferring to gating:", err);
      await handleExistingMember(ctx);
      return;
    }
  }
  await next();
});

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Welcome! I control access to Telegram groups based on Enjin NFT ownership.",
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
// Both handlers self-select on their own transition (add vs. remove).
bot.on("my_chat_member", async (ctx) => {
  await handleBotAdded(ctx);
  await handleBotRemoved(ctx);
});
// chat_member fires on any membership-status change in a group where the bot
// is admin. We dispatch to two handlers independently, not as an if/else:
//   - Admin → non-admin transition (demotion) → prune group_admins row.
//   - Any status → left/kicked transition → mark members row as LEFT and clear caches.
// Both can fire in the same event when someone is demoted straight to kicked,
// so each handler runs conditionally on its own transition check.
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update) return;

  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;

  const wasAdmin = oldStatus === "administrator" || oldStatus === "creator";
  const isAdmin = newStatus === "administrator" || newStatus === "creator";

  if (wasAdmin && !isAdmin) {
    await handleAdminDemoted(ctx);
  }

  if (!wasAdmin && isAdmin) {
    // Promoted to admin: drop any stale existing-member cache entry so their
    // messages aren't deleted for up to the ~1h TTL. The next message re-checks,
    // sees admin, and passes through. (Promotion has no DB state to change —
    // group_admins is only populated by /setup/rule commands, not membership.)
    removeCheckedPair(ctx.chat.id.toString(), update.new_chat_member.user.id.toString());
  }

  if (newStatus === "left" || newStatus === "kicked") {
    await handleMemberLeft(ctx);
  }

  // Plain join (not present → member). Telegram omits the new_chat_members
  // service message in large supergroups and for join-request approvals, so
  // this transition is the only gating signal there; new-member.ts dedupes
  // against the service-message path for groups that get both.
  const wasIn =
    oldStatus === "member" ||
    wasAdmin ||
    (update.old_chat_member.status === "restricted" && update.old_chat_member.is_member);
  const isIn =
    newStatus === "member" ||
    (update.new_chat_member.status === "restricted" && update.new_chat_member.is_member);
  if (!wasIn && isIn) {
    await handleChatMemberJoined(ctx);
  }
});
bot.on(":new_chat_members", handleNewMembers);
// basic → supergroup migration. Must be registered BEFORE the generic "message"
// handler so we update the DB's telegram_id before any other message-path runs
// (otherwise handleExistingMember would fail to find the group by new chat_id).
bot.on("message:migrate_from_chat_id", handleChatMigration);
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
    allowed_updates: ["message", "chat_member", "my_chat_member"],
  });
}

main().catch((err) => {
  console.error("[BOT] Fatal error:", err);
  process.exit(1);
});
