import { Bot, Context } from "grammy";
import { query } from "../../shared/db.js";
import { getOrCreateGroup, getOrCreateUser, checkBouncerAccess } from "../helpers.js";
//for group admins

//check if user is group admin + holds bouncer pass
async function isAuthorizedAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") {
    await ctx.reply("This command only works in groups.");
    return false;
  }

  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    if (member.status !== "administrator" && member.status !== "creator") {
      return false;
    }
  } catch (e) {
    console.error(e);
    return false;
  }

  if (!(await checkBouncerAccess(ctx.from.id.toString()))) {
    await ctx.reply(
      "You need a Bouncer Pass NFT to use admin commands. DM me /verify to link your wallet.",
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
    const parts = text.split(" ").slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        [
          "Usage: /addrule <collection_id> [token_id] [min_balance]",
          "",
          "Examples:",
          "  /addrule 1234             — Any token in collection 1234",
          "  /addrule 1234 5678        — Token 5678 in collection 1234",
          "  /addrule 1234 5678 3      — At least 3 of token 5678",
        ].join("\n"),
      );
      return;
    }

    const collectionId = parts[0];
    const tokenId = parts[1] || null;
    const minBalance = parseInt(parts[2]) || 1;
    const chatId = ctx.chat!.id.toString();

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
        "Existing members: DM me to verify your wallet.",
        `Start here: https://t.me/${process.env.BOT_USERNAME}?start=verify`,
        "",
        "Unverified members will be removed during the next check.",
      ].join("\n"),
    );
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
    const result = await query(
      `SELECT r.id, r.collection_id, r.token_id FROM nft_rules r
       JOIN groups g ON g.id = r.group_id
       WHERE g.telegram_id = $1 AND r.is_active = true
       ORDER BY r.created_at`,
      [chatId],
    );

    if (result.rows.length === 0 || ruleNumber > result.rows.length) {
      await ctx.reply("Invalid rule number. Use /rules to see the list.");
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

    await ctx.reply(`Rule ${ruleNumber} removed.`);
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

    await query(
      `UPDATE nft_rules SET check_interval_seconds = $1
       WHERE group_id = (SELECT id FROM groups WHERE telegram_id = $2) AND is_active = true`,
      [seconds, chatId],
    );

    await ctx.reply(
      `Re-check interval updated to ${hours} hour(s) for all rules.`,
    );
  });
}
