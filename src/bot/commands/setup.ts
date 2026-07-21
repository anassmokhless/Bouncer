import { Bot, Context } from "grammy";
import { query } from "../../shared/db.js";
import { getOrCreateGroup, getOrCreateUser, checkBouncerAccess, releasePendingMembers } from "../helpers.js";
import { collectionExists, tokenExists } from "../../shared/enjin.js";
import { removeCheckedPair, clearGroupCheckedPairs } from "../handlers/existing-member.js";

// Group admin who also holds the pass (or open-access).
async function isAuthorizedAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in groups.");
    return false;
  }

  // Anonymous admins post as the group itself — that's admin proof, and
  // getChatMember wouldn't work on their GroupAnonymousBot ctx.from.
  const isAnonymousAdmin = ctx.senderChat?.id === ctx.chat.id;

  if (!isAnonymousAdmin) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (member.status !== "administrator" && member.status !== "creator") {
        return false;
      }
    } catch (e) {
      console.error("[BOT] Admin status check failed:", e);
      return false;
    }
  }

  const access = await checkBouncerAccess(ctx.from.id.toString());
  if (access === null) {
    // Enjin API error — ask them to retry rather than lock them out.
    await ctx.reply(
      "Couldn't verify your Bouncer Pass right now. Please try again in a moment.",
    );
    return false;
  }
  if (!access) {
    // An anonymous admin has no wallet to link, so give them a real way out
    // instead of a dead-end "/verify".
    if (isAnonymousAdmin) {
      await ctx.reply(
        "Bouncer can't verify a Bouncer Pass for anonymous admins. Turn off 'Remain Anonymous' and try again, or have a non-anonymous admin run this command.",
      );
      return false;
    }
    await ctx.reply(
      "You need a Bouncer Pass NFT to use admin commands. DM me and run /verify to link your wallet.",
    );
    return false;
  }

  return true;
}

// Record the caller as a group admin, return their user row.
async function syncAdmin(ctx: Context, groupId: string) {
  const user = await getOrCreateUser(
    ctx.from!.id.toString(),
    ctx.from?.username,
    ctx.from?.first_name,
  );

  await query(
    `INSERT INTO group_admins (group_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, user.id],
  );

  return user;
}

export function registerSetupCommands(bot: Bot) {
  bot.command("setup", async (ctx) => {
    if (!(await isAuthorizedAdmin(ctx))) return;

    await ctx.reply(
      [
        "Bot Setup Commands:",
        "",
        "/addrule <collection_id> [token_id] [min_balance]",
        "  Add an NFT requirement",
        "",
        "/removerule <rule_number>",
        "  Remove an NFT requirement",
        "",
        "/rules",
        "  View current NFT requirements",
        "",
        "/setinterval <hours>",
        "  Set re-check interval (minimum 1 hour)",
      ].join("\n"),
    );
  });

  bot.command("addrule", async (ctx) => {
    if (!(await isAuthorizedAdmin(ctx))) return;

    const text = ctx.message?.text || "";
    // Split on whitespace runs so a double space doesn't produce an empty arg
    // and shift the token id into the min_balance slot.
    const parts = text.trim().split(/\s+/).slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        [
          "Usage: /addrule <collection_id> [token_id] [min_balance]",
          "",
          "Examples:",
          "  /addrule 1234             — Any token in collection 1234",
          "  /addrule 1234 5678        — Only token 5678",
          "  /addrule 1234 5678 3      — At least 3 of token 5678",
        ].join("\n"),
      );
      return;
    }

    const collectionId = parts[0];
    const tokenId = parts[1] || null;

    // Strict positive integer, capped at int4 max. Reject rather than let
    // parseInt silently coerce "-1" or "1e5" into a wrong gate threshold.
    let minBalance = 1;
    if (parts[2] !== undefined) {
      const parsed = /^\d+$/.test(parts[2]) ? parseInt(parts[2]) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
        await ctx.reply("Min balance must be a whole number of at least 1. Example: /addrule 1234 5678 3");
        return;
      }
      minBalance = parsed;
    }

    // Collection/token IDs are numeric.
    if (!/^\d+$/.test(collectionId)) {
      await ctx.reply("Collection ID must be numeric. Example: /addrule 1234 5678 3");
      return;
    }
    if (tokenId !== null && !/^\d+$/.test(tokenId)) {
      await ctx.reply("Token ID must be numeric. Example: /addrule 1234 5678 3");
      return;
    }

    // Confirm the collection (and token) exist on Enjin — catches typo'd IDs.
    const collectionOk = await collectionExists(collectionId);
    if (collectionOk === false) {
      await ctx.reply(`Collection ${collectionId} was not found on the Enjin blockchain. Double-check the ID.`);
      return;
    }
    if (collectionOk === null) {
      await ctx.reply("Couldn't validate the collection right now. Please try again in a moment.");
      return;
    }
    if (tokenId !== null) {
      const tokenOk = await tokenExists(collectionId, tokenId);
      if (tokenOk === false) {
        await ctx.reply(`Token ${tokenId} was not found in collection ${collectionId}. Double-check the ID.`);
        return;
      }
      if (tokenOk === null) {
        await ctx.reply("Couldn't validate the token right now. Please try again in a moment.");
        return;
      }
    }

    const chatId = ctx.chat!.id.toString();

    // try/catch so a DB error replies to the admin instead of vanishing into bot.catch.
    try {
      const group = await getOrCreateGroup(chatId, ctx.chat!.title || "Unknown");

      await query(
        `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance)
         VALUES ($1, $2, $3, $4)`,
        [group.id, collectionId, tokenId, minBalance],
      );

      // Users cached as 'skip' while the group had no rules must re-check now.
      clearGroupCheckedPairs(chatId);

      const admin = await syncAdmin(ctx, group.id);

      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [
          group.id,
          admin.id,
          "RULE_ADDED",
          JSON.stringify({ collectionId, tokenId, minBalance }),
        ],
      );

      await ctx.reply(
        [
          "NFT rule added!",
          `  Collection: ${collectionId}`,
          `  Token: ${tokenId || "Any"}`,
          `  Min balance: ${minBalance}`,
          "",
          `Existing members — to keep your access, <a href="https://t.me/${process.env.BOT_USERNAME}?start=verify">DM me and verify</a>.`,
          "",
          "Members without a linked wallet have 24 hours to verify; anyone who doesn't qualify will be removed on a scheduled re-check.",
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } catch (err) {
      console.error("[BOT] /addrule failed:", err);
      try {
        await ctx.reply("Something went wrong while adding the rule. Please try again — if this keeps happening, check the bot logs.");
      } catch (replyErr) {
        console.error("[BOT] Also failed to notify admin of /addrule error:", replyErr);
      }
    }
  });

  bot.command("rules", async (ctx) => {
    if (!(await isAuthorizedAdmin(ctx))) return;

    const chatId = ctx.chat!.id.toString();
    const result = await query(
      `SELECT r.* FROM nft_rules r
       JOIN groups g ON g.id = r.group_id
       WHERE g.telegram_id = $1 AND r.is_active = true
       ORDER BY r.created_at`,
      [chatId],
    );

    if (result.rows.length === 0) {
      await ctx.reply("No NFT rules configured. Use /addrule to add one.");
      return;
    }

    const lines = result.rows.map(
      (r: any, i: number) =>
        `${i + 1}. Collection: ${r.collection_id} | Token: ${r.token_id || "Any"} | Min: ${r.min_balance} | Check: ${r.check_interval_seconds / 3600}h`,
    );

    await ctx.reply("Current NFT Rules:\n\n" + lines.join("\n"));
  });

  bot.command("removerule", async (ctx) => {
    if (!(await isAuthorizedAdmin(ctx))) return;

    const text = ctx.message?.text || "";
    // Whitespace-run split — see /addrule.
    const ruleNumber = parseInt(text.trim().split(/\s+/)[1]);

    if (!ruleNumber || ruleNumber < 1) {
      await ctx.reply(
        "Usage: /removerule <rule_number>\nUse /rules to see the list.",
      );
      return;
    }

    const chatId = ctx.chat!.id.toString();

    // try/catch so a DB error replies to the admin instead of vanishing into bot.catch.
    try {
      const result = await query(
        `SELECT r.id, r.collection_id, r.token_id FROM nft_rules r
         JOIN groups g ON g.id = r.group_id
         WHERE g.telegram_id = $1 AND r.is_active = true
         ORDER BY r.created_at`,
        [chatId],
      );

      if (result.rows.length === 0) {
        await ctx.reply("No rules configured yet. Use /addrule to add one.");
        return;
      }
      if (ruleNumber > result.rows.length) {
        await ctx.reply(
          `No rule at slot ${ruleNumber}. You have ${result.rows.length} rule(s) configured — use /rules to see them.`,
        );
        return;
      }

      const rule = result.rows[ruleNumber - 1];

      await query(`UPDATE nft_rules SET is_active = false WHERE id = $1`, [
        rule.id,
      ]);

      const group = await getOrCreateGroup(chatId, ctx.chat!.title || "Unknown");
      const admin = await syncAdmin(ctx, group.id);

      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [
          group.id,
          admin.id,
          "RULE_REMOVED",
          JSON.stringify({
            collectionId: rule.collection_id,
            tokenId: rule.token_id,
          }),
        ],
      );

      // Release stuck PENDING members if that was the last rule (no-op otherwise).
      const releasedCount = await releasePendingMembers(ctx.api, chatId, removeCheckedPair);

      const remaining = await query(
        `SELECT COUNT(*)::int AS c FROM nft_rules WHERE group_id = $1 AND is_active = true`,
        [group.id],
      );
      const lines = [`Rule ${ruleNumber} removed: Collection ${rule.collection_id}, Token ${rule.token_id || "Any"}.`];
      if (remaining.rows[0].c === 0) {
        lines.push(
          "",
          releasedCount > 0
            ? `No active rules remain — gating is off and ${releasedCount} pending member(s) were restored.`
            : "No active rules remain — gating is off until you add a new rule.",
        );
      }
      await ctx.reply(lines.join("\n"));
    } catch (err) {
      console.error("[BOT] /removerule failed:", err);
      try {
        await ctx.reply("Something went wrong while removing the rule. Please try again — if this keeps happening, check the bot logs.");
      } catch (replyErr) {
        console.error("[BOT] Also failed to notify admin of /removerule error:", replyErr);
      }
    }
  });

  bot.command("setinterval", async (ctx) => {
    if (!(await isAuthorizedAdmin(ctx))) return;

    const text = ctx.message?.text || "";
    // Whitespace-run split so a double space doesn't produce an empty arg.
    const input = text.trim().split(/\s+/)[1];
    const hours = parseFloat(input);

    if (!hours || !isFinite(hours)) {
      await ctx.reply("Usage: /setinterval <hours>\nExample: /setinterval 6");
      return;
    }

    if (hours < 1) {
      await ctx.reply("Minimum interval is 1 hour.");
      return;
    }

    if (hours > 720) {
      await ctx.reply("Maximum interval is 720 hours (30 days).");
      return;
    }

    const seconds = Math.round(hours * 3600);
    const chatId = ctx.chat!.id.toString();

    // try/catch so a DB error replies to the admin instead of vanishing into bot.catch.
    try {
      await query(
        `UPDATE nft_rules SET check_interval_seconds = $1
         WHERE group_id = (SELECT id FROM groups WHERE telegram_id = $2) AND is_active = true`,
        [seconds, chatId],
      );

      await ctx.reply(
        `Re-check interval updated to ${hours} hour(s) for all rules.`,
      );
    } catch (err) {
      console.error("[BOT] /setinterval failed:", err);
      try {
        await ctx.reply("Something went wrong while updating the interval. Please try again — if this keeps happening, check the bot logs.");
      } catch (replyErr) {
        console.error("[BOT] Also failed to notify admin of /setinterval error:", replyErr);
      }
    }
  });
}
