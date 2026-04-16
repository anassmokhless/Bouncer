import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateGroup, getOrCreateUser } from "../helpers.js";

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
    await Promise.allSettled(batch.map(async (member) => {
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

      // Restrict user immediately — mute until verified
      try {
        await ctx.api.restrictChatMember(ctx.chat!.id, member.id, {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
          can_manage_topics: false,
        });
      } catch (err) {
        console.error("[BOT] Failed to restrict member:", err);
      }

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

            await query(
              `INSERT INTO members (group_id, user_id, status, last_checked)
               VALUES ($1, $2, 'VERIFIED', now())
               ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED', last_checked = now()`,
              [group.id, user.id],
            );

            await query(
              `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
              [group.id, user.id, "USER_AUTO_VERIFIED", JSON.stringify({ collectionId: rule.collection_id })],
            );

            // Unrestrict — user has the NFT
            try {
              await ctx.api.restrictChatMember(ctx.chat!.id, member.id, {
                can_send_messages: true,
                can_send_audios: true,
                can_send_photos: true,
                can_send_voice_notes: true,
                can_send_other_messages: true,
              });
            } catch (err) {
              console.error("[BOT] Failed to unrestrict member:", err);
            }

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
            try {
              await ctx.api.restrictChatMember(ctx.chat!.id, member.id, {
                can_send_messages: true,
                can_send_audios: true,
                can_send_photos: true,
                can_send_voice_notes: true,
                can_send_other_messages: true,
              });
            } catch (err) {
              console.error("[BOT] Failed to unrestrict preserved VERIFIED member:", err);
            }
            console.log(`[BOT] Preserved VERIFIED for ${telegramId} — Enjin API errored on all rules`);
            return;
          }
        }

        await query(
          `INSERT INTO members (group_id, user_id, status, verification_deadline)
           VALUES ($1, $2, 'PENDING', now() + interval '1 hour')
           ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'PENDING', verification_deadline = now() + interval '1 hour'`,
          [group.id, user.id],
        );

        try {
          await ctx.api.sendMessage(ctx.chat!.id, [
            `Welcome ${member.first_name}! Access to this group requires an Enjin NFT.`,
            "",
            "You are muted until you verify your wallet.",
            `DM me to verify: [Start verification](https://t.me/${process.env.BOT_USERNAME}?start=verify)`,
            "",
            "You have 1 hour to verify or you'll be removed.",
          ].join("\n"), { parse_mode: "Markdown" });
        } catch (err) {
          console.error("[BOT] Failed to send welcome message:", err);
        }
      }
    }));
  }
}