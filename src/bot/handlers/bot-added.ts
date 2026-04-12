import { Context } from "grammy";
import { checkBouncerAccess } from "../helpers.js";

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
    }
}
