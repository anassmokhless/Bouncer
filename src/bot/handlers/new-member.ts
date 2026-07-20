import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateGroup, getOrCreateUser, safeMute, safeUnmute, escapeHtml } from "../helpers.js";

export async function handleNewMembers(ctx: Context) {
  const newMembers = ctx.message?.new_chat_members;
  if (!newMembers || !ctx.chat) return;

  const chatId = ctx.chat.id.toString();
  const group = await getOrCreateGroup(chatId, ctx.chat.title || "Unknown");

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
    [group.id],
  );

  const actualMembers = newMembers.filter((m) => !m.is_bot);
  const BATCH_SIZE = 5;

  for (let i = 0; i < actualMembers.length; i += BATCH_SIZE) {
    const batch = actualMembers.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(async (member) => {
      const telegramId = member.id.toString();
      const user = await getOrCreateUser(telegramId, member.username, member.first_name);

      if (rules.rows.length === 0) {
        // No rules — allow freely
        await query(
          `INSERT INTO members (group_id, user_id, status)
           VALUES ($1, $2, 'VERIFIED')
           ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED'`,
          [group.id, user.id],
        );
        return;
      }

      // Restrict user immediately — mute until verified. In basic groups (not
      // supergroups) muting isn't supported and silently no-ops; any messages
      // they send will be deleted on sight by handleExistingMember instead.
      await safeMute(ctx.api, ctx.chat!.id, member.id);

      // If user has a wallet, check NFT immediately
      let verified = false;
      let gotCleanApiResult = false;

      if (user.wallet_address) {
        for (const rule of rules.rows) {
          const hasNft = await checkNftOwnership(
            user.wallet_address,
            rule.collection_id,
            rule.token_id,
            rule.min_balance,
          );

          if (hasNft === null) continue; // API error — skip this rule
          gotCleanApiResult = true;
          if (hasNft) {
            verified = true;

            // Audit only on a real transition to VERIFIED. On a rejoin where the
            // member is already VERIFIED the guarded DO UPDATE matches no row
            // (WHERE ... IS DISTINCT FROM 'VERIFIED'), so no duplicate
            // USER_AUTO_VERIFIED entry; a separate refresh keeps last_checked current.
            const transition = await query(
              `INSERT INTO members (group_id, user_id, status, last_checked)
               VALUES ($1, $2, 'VERIFIED', now())
               ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED', last_checked = now()
               WHERE members.status IS DISTINCT FROM 'VERIFIED'
               RETURNING id`,
              [group.id, user.id],
            );
            if ((transition.rowCount ?? 0) > 0) {
              await query(
                `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
                [group.id, user.id, "USER_AUTO_VERIFIED", JSON.stringify({ collectionId: rule.collection_id })],
              );
            } else {
              await query(
                `UPDATE members SET last_checked = now() WHERE group_id = $1 AND user_id = $2`,
                [group.id, user.id],
              );
            }

            // Unrestrict — user has the NFT. No-op in basic groups (they were
            // never muted there to begin with).
            await safeUnmute(ctx.api, ctx.chat!.id, member.id);

            break;
          }
        }
      }

      // Not verified — set as pending (or preserve VERIFIED if API errored on all rules)
      if (!verified) {
        // If user has wallet but all API calls errored, check existing status
        // Preserve VERIFIED so the recheck cron can revalidate once API recovers
        if (user.wallet_address && !gotCleanApiResult) {
          const existing = await query(
            `SELECT status FROM members WHERE group_id = $1 AND user_id = $2`,
            [group.id, user.id],
          );
          if (existing.rows.length > 0 && existing.rows[0].status === "VERIFIED") {
            // Preserve VERIFIED — unrestrict and let recheck cron revalidate
            await safeUnmute(ctx.api, ctx.chat!.id, member.id);
            console.log(`[BOT] Preserved VERIFIED for ${telegramId} — Enjin API errored on all rules`);
            return;
          }
        }

        await query(
          `INSERT INTO members (group_id, user_id, status, verification_deadline)
           VALUES ($1, $2, 'PENDING', now() + interval '5 minutes')
           ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'PENDING', verification_deadline = now() + interval '5 minutes'`,
          [group.id, user.id],
        );

        try {
          // HTML parse mode (not Markdown v1) — Markdown v1 breaks on any `_`
          // or `*` in first_name (e.g., "Cryptan_19"). HTML only needs `<`, `>`,
          // `&` escaped, which escapeHtml handles. first_name can be absent on
          // accounts without a display name, so guard with `|| ""`.
          await ctx.reply([
            `Welcome ${escapeHtml(member.first_name || "")}! Access to this group requires an Enjin NFT.`,
            "",
            "Your messages will be removed until you verify your wallet.",
            `<a href="https://t.me/${process.env.BOT_USERNAME}?start=verify">Start verification</a>`,
            "",
            "You have 5 minutes to verify or you'll be removed.",
          ].join("\n"), { parse_mode: "HTML" });
        } catch (err) {
          console.error("[BOT] Failed to send welcome message:", err);
        }
      }
    }));

    // Surface per-member failures. Promise.allSettled never rejects, so without
    // this a joiner dropped by a DB/Telegram error (e.g. getOrCreateUser threw
    // before safeMute) leaves no trace — unrestricted, unlogged, no PENDING row.
    // They self-heal on their next message (handleExistingMember re-gates them),
    // but the log makes the gap visible instead of silent.
    results.forEach((r, idx) => {
      if (r.status === "rejected") {
        console.error(`[BOT] Failed to process new member ${batch[idx].id} in ${chatId}:`, r.reason);
      }
    });
  }
}