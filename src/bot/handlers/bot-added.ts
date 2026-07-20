import { Context } from "grammy";
import { checkBouncerAccess, getOrCreateGroup, getOrCreateUser, GROUP_ANONYMOUS_BOT_ID } from "../helpers.js";
import { query } from "../../shared/db.js";

export async function handleBotAdded(ctx: Context) {
    const update = ctx.myChatMember;
    if (!update) return;

    // Only handle non-member → member/admin.
    const oldStatus = update.old_chat_member.status;
    const newStatus = update.new_chat_member.status;

    if (oldStatus === "member" || oldStatus === "administrator") return;
    if (newStatus !== "member" && newStatus !== "administrator") return;

    const addedBy = update.from;
    const chatId = update.chat.id;

    // The adder must be a group admin. Anonymous admins arrive as the
    // GroupAnonymousBot service account, which is itself admin proof — skip the
    // getChatMember check (it would fail on the service account).
    const addedByAnonymousAdmin = addedBy.id === GROUP_ANONYMOUS_BOT_ID;
    if (!addedByAnonymousAdmin) {
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
    }

    const access = await checkBouncerAccess(addedBy.id.toString());
    if (access === null) {
        // Enjin API error — can't confirm the pass, so refuse and ask to retry.
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

    // Register the group and its admin.
    const group = await getOrCreateGroup(chatId.toString(), update.chat.title || "Unknown");
    const user = await getOrCreateUser(addedBy.id.toString(), addedBy.username, addedBy.first_name);

    await query(
        `INSERT INTO group_admins (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [group.id, user.id],
    );

    // First-adder provenance only; the gate reads group_admins, not this column.
    await query(
        `UPDATE groups SET admin_user_id = $1 WHERE id = $2`,
        [user.id, group.id],
    );

    await ctx.api.sendMessage(
        chatId,
        [
            "Bouncer is active! Use /addrule to set up NFT gating.",
            "",
            "⚠️ Make sure to promote me to admin so I can manage members.",
        ].join("\n"),
    );
}
