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

  for (const member of newMembers) {
    if (!member.is_bot) {
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
      } else {
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

        if (user.wallet_address) {
          for (const rule of rules.rows) {
            const hasNft = await checkNftOwnership(
              user.wallet_address,
              rule.collection_id,
              rule.token_id,
              rule.min_balance,
            );

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
                  can_send_documents: true,
                  can_send_photos: true,
                  can_send_videos: true,
                  can_send_video_notes: true,
                  can_send_voice_notes: true,
                  can_send_polls: true,
                  can_send_other_messages: true,
                  can_add_web_page_previews: true,
                  can_change_info: true,
                  can_invite_users: true,
                  can_pin_messages: true,
                  can_manage_topics: true,
                });
              } catch (err) {
                console.error("[BOT] Failed to unrestrict member:", err);
              }

              break;
            }
          }
        }

        // Not verified — set as pending
        if (!verified) {
          await query(
            `INSERT INTO members (group_id, user_id, status)
             VALUES ($1, $2, 'PENDING')
             ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'PENDING'`,
            [group.id, user.id],
          );

          try {
            await ctx.api.sendMessage(ctx.chat!.id, [
              `Welcome ${member.first_name}! This group requires Enjin NFT ownership.`,
              "",
              "You are muted until you verify your wallet.",
              `DM me to verify: [Click here to start](https://t.me/${process.env.BOT_USERNAME}?start=verify)`,
              "",
              "You have 1 hour to verify or you'll be removed.",
            ].join("\n"), { parse_mode: "Markdown" });
          } catch (err) {
            console.error("[BOT] Failed to send welcome message:", err);
          }
        }
      }
    }
  }
}