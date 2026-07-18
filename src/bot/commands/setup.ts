import { Bot, Context } from "grammy";
import { query } from "../../shared/db.js";
import { getOrCreateGroup, getOrCreateUser, checkBouncerAccess } from "../helpers.js";
import { collectionExists, tokenExists } from "../../shared/enjin.js";
//for group admins

//check if user is group admin + holds bouncer pass
async function isAuthorizedAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in groups.");
    return false;
  }

  // Anonymous admins post as the group itself (sender_chat === chat) and only
  // admins can do that — accept it as admin proof. Their ctx.from is the
  // GroupAnonymousBot service account, so the getChatMember path below can't
  // work for them. Note: syncAdmin/audit entries will then attribute actions
  // to "GroupAnonymousBot", which is exactly the anonymity the admin chose.
  const isAnonymousAdmin = ctx.senderChat?.id === ctx.chat.id;

  if (!isAnonymousAdmin) {
    try {
      const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
      if (member.status !== "administrator" && member.status !== "creator") {
        return false;
      }
    } catch (e) {
      console.error(e);
      return false;
    }
  }

  const access = await checkBouncerAccess(ctx.from.id.toString());
  if (access === null) {
    // API error — can't confirm the admin has the pass, but shouldn't lock them
    // out permanently. Tell them to retry; the next command attempt will re-check.
    await ctx.reply(
      "Couldn't verify your Bouncer Pass right now. Please try again in a moment.",
    );
    return false;
  }
  if (!access) {
    // The service account can never link a wallet, so in early-access mode an
    // anonymous admin needs an honest explanation instead of a dead-end
    // "/verify" suggestion. In open-access mode checkBouncerAccess is always
    // true and anonymous admins work without restriction.
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

//admin register/update and return
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

//setup all admin commands
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
    // Split on whitespace RUNS, not single spaces: "/addrule 1234  5678" (double
    // space, common on mobile) would otherwise yield ["1234", "", "5678"] —
    // shifting the token id into the min_balance slot and silently saving a
    // rule nobody can pass.
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

    // min_balance gets the same strict treatment as the IDs below, because
    // parseInt alone is dangerous in both directions: "-1" opens the gate to
    // every wallet, and prefix-parsing quietly WEAKENS it ("1e5" → 1 when the
    // admin meant 100000). Rejecting beats silently rewriting a gate
    // threshold. Upper bound = int4 max, matching the column type.
    // (checkNftOwnership also floors its input, so even a bad stored row can
    // never open the gate — this check is about honest admin feedback.)
    let minBalance = 1;
    if (parts[2] !== undefined) {
      const parsed = /^\d+$/.test(parts[2]) ? parseInt(parts[2]) : NaN;
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2147483647) {
        await ctx.reply("Min balance must be a whole number of at least 1. Example: /addrule 1234 5678 3");
        return;
      }
      minBalance = parsed;
    }

    // Enjin collection/token IDs are numeric. Reject non-numeric input early so admins get
    // clear feedback instead of silently-broken rules that never verify anyone.
    if (!/^\d+$/.test(collectionId)) {
      await ctx.reply("Collection ID must be numeric. Example: /addrule 1234 5678 3");
      return;
    }
    if (tokenId !== null && !/^\d+$/.test(tokenId)) {
      await ctx.reply("Token ID must be numeric. Example: /addrule 1234 5678 3");
      return;
    }

    // Verify collection (and token, if specified) actually exist on Enjin. Prevents
    // admins from saving a typo'd ID that never verifies anyone.
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

    // Wrap DB writes + success reply in try/catch. Without this, any DB error
    // (transient connectivity blip, constraint violation, etc.) propagates to
    // grammy's global error handler — which logs but sends nothing back to the
    // admin. The admin assumes the command succeeded and is confused when /rules
    // shows no change. Replying with a generic error is safer UX; the real error
    // is still logged server-side for debugging.
    try {
      const group = await getOrCreateGroup(chatId, ctx.chat!.title || "Unknown");

      await query(
        `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance)
         VALUES ($1, $2, $3, $4)`,
        [group.id, collectionId, tokenId, minBalance],
      );

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
          "Anyone unverified will be removed on the next scheduled re-check.",
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
    if (ctx.chat?.type === "private") return;

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
    const ruleNumber = parseInt(text.split(" ")[1]);

    if (!ruleNumber || ruleNumber < 1) {
      await ctx.reply(
        "Usage: /removerule <rule_number>\nUse /rules to see the list.",
      );
      return;
    }

    const chatId = ctx.chat!.id.toString();

    // Wrap DB reads + writes + reply so any DB failure reaches the admin as a
    // visible error message instead of silently disappearing into grammy's
    // global error handler.
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

      await ctx.reply(
        `Rule ${ruleNumber} removed: Collection ${rule.collection_id}, Token ${rule.token_id || "Any"}.`,
      );
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
    const input = text.split(" ")[1];
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

    // Wrap DB write + reply so any DB failure reaches the admin as a visible
    // error instead of silently disappearing into grammy's global error handler.
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
