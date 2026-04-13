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

        // Check again after 5 minutes — leave if still not verified
        setTimeout(async () => {
            try {
                const check = await query(
                    `SELECT wallet_address FROM users WHERE telegram_id = $1`,
                    [addedBy.id.toString()],
                );
                if (!check.rows[0]?.wallet_address) {
                    await ctx.api.sendMessage(chatId, "Admin did not verify within 5 minutes. Leaving group.");
                    await ctx.api.leaveChat(chatId);
                    await query(`DELETE FROM group_admins WHERE group_id = $1 AND user_id = $2`, [group.id, user.id]);
                    await query(`DELETE FROM groups WHERE id = $1`, [group.id]);
                    console.log(`[BOT] Left group ${chatId} — admin did not verify in time`);
                }
            } catch (err) {
                console.error("[BOT] Failed to check admin verification:", err);
            }
        }, 5 * 60 * 1000);
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
