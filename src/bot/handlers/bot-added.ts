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

    if (!(await checkBouncerAccess(addedBy.id.toString()))) {
        try {
            await ctx.api.sendMessage(
                chatId,
                "Bouncer is in early access. The admin who added me needs a Bouncer Pass NFT. DM me /verify to link your wallet first.",
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

    // Check if admin has a linked wallet
    if (!user.wallet_address) {
        // Store deadline in DB so the cron can enforce it even after a restart
        await query(
            `UPDATE groups SET admin_verify_deadline = now() + interval '5 minutes', admin_user_id = $1 WHERE id = $2`,
            [user.id, group.id],
        );

        await ctx.api.sendMessage(
            chatId,
            [
                "Bouncer is active! Use /addrule to set up NFT gating.",
                "",
                "⚠️ Make sure to promote me to admin so I can manage members.",
                "",
                `You haven't linked a wallet yet. DM me to verify: https://t.me/${process.env.BOT_USERNAME}?start=verify`,
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
