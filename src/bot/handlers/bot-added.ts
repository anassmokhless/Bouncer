import { Context } from "grammy";
import { checkBouncerAccess, getOrCreateGroup, getOrCreateUser } from "../helpers.js";
import { query } from "../../shared/db.js";

export async function handleBotAdded(ctx: Context) {
    const update = ctx.myChatMember;
    if (!update) return;

    // Only handle when bot goes from non-member to member/admin
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;

    if (oldStatus === "member" || oldStatus === "administrator") return;
    if (newStatus !== "member" && newStatus !== "administrator") return;

    const addedBy = update.from;
    const chatId = update.chat.id;

    // Verify the user who added the bot is actually an admin of the chat
    try {
        const member = await ctx.api.getChatMember(chatId, addedBy.id);
        if (member.status !== "administrator" && member.status !== "creator") {
            try {
                await ctx.api.sendMessage(
                    chatId,
                    "Only group admins can add Bouncer. Ask an admin to invite me.",
                );
                await ctx.api.leaveChat(chatId);
            } catch (err) {
                console.error("[BOT] Failed to leave chat (non-admin adder):", err);
            }
            return;
        }
    } catch (err) {
        console.error("[BOT] Failed to verify admin status:", err);
        try {
            await ctx.api.leaveChat(chatId);
        } catch (leaveErr) {
            console.error("[BOT] Failed to leave chat after verify failure:", leaveErr);
        }
        return;
    }

    const access = await checkBouncerAccess(addedBy.id.toString());
    if (access === null) {
        // API error — can't confirm the adder holds the pass. Refuse the add
        // conservatively (safer than admitting a potential non-holder) but tell
        // them to retry once the API recovers. Nothing is persisted yet, so a
        // retry is a clean slate.
        try {
            await ctx.api.sendMessage(
                chatId,
                "Couldn't verify the Bouncer Pass right now (Enjin API error). Please try adding me again in a moment.",
            );
            await ctx.api.leaveChat(chatId);
        } catch (err) {
            console.error("[BOT] Failed to leave chat (verification error):", err);
        }
        return;
    }
    if (!access) {
        try {
            await ctx.api.sendMessage(
                chatId,
                "Bouncer is in early access. The admin who added me needs a Bouncer Pass NFT. DM me and run /verify to link your wallet first.",
            );
            await ctx.api.leaveChat(chatId);
        } catch (err) {
            console.error("[BOT] Failed to leave chat:", err);
        }
        return;
    }

    // Register the group and admin
    const group = await getOrCreateGroup(chatId.toString(), update.chat.title || "Unknown");
    const user = await getOrCreateUser(addedBy.id.toString(), addedBy.username, addedBy.first_name);

    // Make the user an admin of the group
    await query(
        `INSERT INTO group_admins (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [group.id, user.id],
    );

    // Record the first-adder as provenance. The early-access gate no longer
    // reads admin_user_id (it iterates group_admins instead), but the column
    // is preserved for audit/debug value.
    await query(
        `UPDATE groups SET admin_user_id = $1 WHERE id = $2`,
        [user.id, group.id],
    );

    if (!user.wallet_address) {
        // Store deadline so the cron can enforce it even after a restart
        await query(
            `UPDATE groups SET admin_verify_deadline = now() + interval '5 minutes' WHERE id = $1`,
            [group.id],
        );

        await ctx.api.sendMessage(
            chatId,
            [
                "Bouncer is active! Use /addrule to set up NFT gating.",
                "",
                "⚠️ Make sure to promote me to admin so I can manage members.",
                "",
                `You haven't linked a wallet yet. DM me and run /verify to link your wallet first.`,
                "",
                "You have 5 minutes to link your wallet or I'll leave this group.",
            ].join("\n"),
        );
    } else {
        await ctx.api.sendMessage(
            chatId,
            [
                "Bouncer is active! Use /addrule to set up NFT gating.",
                "",
                "⚠️ Make sure to promote me to admin so I can manage members.",
            ].join("\n"),
        );
    }
}
