import cron from "node-cron";
import { Bot } from "grammy";
import { query } from "../shared/db.js";
import { getVerifiedWallet, checkNftOwnership } from "../shared/enjin.js";

let isPolling = false;

export function startCronJobs(bot: Bot) {
  // Poll pending QR verifications every 15 seconds
  cron.schedule("*/15 * * * * *", async () => {
    if (isPolling) return;
    isPolling = true;
    try {
      await pollPendingVerifications(bot);
    } catch (err) {
      console.error("[CRON] Verification poll failed:", err);
    } finally {
      isPolling = false;
    }
  });

  cron.schedule("*/10 * * * *", async () => {
    console.log("[CRON] Running NFT ownership re-check...");
    try {
      await recheckVerifiedMembers(bot);
    } catch (err) {
      console.error("[CRON] Re-check failed:", err);
    }
  });

  cron.schedule("0 * * * *", async () => {
    console.log("[CRON] Checking for expired pending members...");
    try {
      await kickExpiredPendingMembers(bot);
    } catch (err) {
      console.error("[CRON] Kick expired failed:", err);
    }
  });

  console.log("[CRON] Jobs scheduled: verify-poll (*/15s), re-check (*/10min), kick-expired (hourly)");
}

async function pollPendingVerifications(bot: Bot) {
  // Clean up expired verifications
  await query(`DELETE FROM pending_verifications WHERE expires_at <= now()`);

  // Get all non-expired pending verifications
  const pending = await query(
    `SELECT pv.id, pv.verification_id, pv.telegram_chat_id, pv.user_id,
            u.telegram_id AS user_telegram_id
     FROM pending_verifications pv
     JOIN users u ON u.id = pv.user_id
     WHERE pv.expires_at > now()`,
  );

  if (pending.rows.length === 0) return;

  for (const row of pending.rows) {
    const walletAddress = await getVerifiedWallet(row.verification_id);
    if (!walletAddress) continue;

    // Check wallet isn't already claimed
    const existing = await query(
      `SELECT id FROM users WHERE wallet_address = $1 AND id != $2`,
      [walletAddress, row.user_id],
    );

    if (existing.rows.length > 0) {
      await bot.api.sendMessage(parseInt(row.telegram_chat_id),
        "This wallet is already linked to another Telegram account.");
      await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      continue;
    }

    // Link wallet
    await query(
      `UPDATE users SET wallet_address = $1, is_verified = true, verified_at = now()
       WHERE id = $2`,
      [walletAddress, row.user_id],
    );

    // Remove pending verification
    await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);

    // Check NFT ownership for all group memberships
    const memberships = await query(
      `SELECT m.id AS member_id, m.group_id, g.title AS group_title,
              r.collection_id, r.token_id, r.min_balance
       FROM members m
       JOIN groups g ON g.id = m.group_id
       LEFT JOIN nft_rules r ON r.group_id = m.group_id AND r.is_active = true
       WHERE m.user_id = $1`,
      [row.user_id],
    );

    const groupMap = new Map<
      string,
      { groupId: string; title: string; memberId: string; rules: any[] }
    >();

    for (const m of memberships.rows) {
      if (!groupMap.has(m.group_id)) {
        groupMap.set(m.group_id, {
          groupId: m.group_id,
          title: m.group_title,
          memberId: m.member_id,
          rules: [],
        });
      }
      if (m.collection_id) {
        groupMap.get(m.group_id)!.rules.push({
          collectionId: m.collection_id,
          tokenId: m.token_id,
          minBalance: m.min_balance,
        });
      }
    }

    let verifiedGroupCount = 0;

    for (const [, group] of groupMap) {
      if (group.rules.length === 0) continue;

      for (const rule of group.rules) {
        const hasNft = await checkNftOwnership(
          walletAddress,
          rule.collectionId,
          rule.tokenId,
          rule.minBalance,
        );

        if (hasNft) {
          verifiedGroupCount++;
          await query(
            `UPDATE members SET status = 'VERIFIED', last_checked = now()
             WHERE id = $1`,
            [group.memberId],
          );
          await query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [group.groupId, row.user_id, "USER_VERIFIED",
             JSON.stringify({ walletAddress, collectionId: rule.collectionId, tokenId: rule.tokenId })],
          );

          // Unrestrict user in the group
          try {
            const groupResult = await query(`SELECT telegram_id FROM groups WHERE id = $1`, [group.groupId]);
            if (groupResult.rows.length > 0) {
              await bot.api.restrictChatMember(
                parseInt(groupResult.rows[0].telegram_id),
                parseInt(row.user_telegram_id),
                {
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
                },
              );
            }
          } catch (err) {
            console.error(`[CRON] Failed to unrestrict user ${row.user_telegram_id}:`, err);
          }

          break;
        }
      }
    }

    // Notify the user
    let message: string;
    if (verifiedGroupCount > 0) {
      message = `Wallet \`${walletAddress}\` verified! You have access to ${verifiedGroupCount} group(s).`;
    } else if (groupMap.size === 0) {
      message = `Wallet \`${walletAddress}\` verified and linked!\n\nJoin an NFT-gated group and I'll automatically check your holdings.`;
    } else {
      message = `Wallet \`${walletAddress}\` verified and linked, but you don't hold the required NFTs for your current groups. You will remain muted until you hold the required NFTs.`;
    }

    try {
      await bot.api.sendMessage(parseInt(row.telegram_chat_id), message, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[CRON] Failed to notify user ${row.user_telegram_id}:`, err);
    }
  }
}

async function recheckVerifiedMembers(bot: Bot) {
  const result = await query(
    `SELECT g.id AS group_id, g.telegram_id AS group_telegram_id,
            m.id AS member_id, m.last_checked,
            u.id AS user_id, u.telegram_id AS user_telegram_id, u.wallet_address,
            r.collection_id, r.token_id, r.min_balance, r.check_interval_seconds
     FROM groups g
     JOIN members m ON m.group_id = g.id AND m.status = 'VERIFIED'
     JOIN users u ON u.id = m.user_id
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.is_active = true AND u.wallet_address IS NOT NULL`,
  );

  const memberChecks = new Map<string, {
    memberId: string;
    groupId: string;
    groupTelegramId: string;
    userId: string;
    userTelegramId: string;
    walletAddress: string;
    lastChecked: Date | null;
    rules: Array<{ collectionId: string; tokenId: string | null; minBalance: number; checkInterval: number }>;
  }>();

  for (const row of result.rows) {
    if (!memberChecks.has(row.member_id)) {
      memberChecks.set(row.member_id, {
        memberId: row.member_id,
        groupId: row.group_id,
        groupTelegramId: row.group_telegram_id,
        userId: row.user_id,
        userTelegramId: row.user_telegram_id,
        walletAddress: row.wallet_address,
        lastChecked: row.last_checked,
        rules: [],
      });
    }
    memberChecks.get(row.member_id)!.rules.push({
      collectionId: row.collection_id,
      tokenId: row.token_id,
      minBalance: row.min_balance,
      checkInterval: row.check_interval_seconds,
    });
  }

  let checkedCount = 0;
  let kickedCount = 0;

  for (const [, member] of memberChecks) {
    const minInterval = Math.min(...member.rules.map((r) => r.checkInterval));
    if (member.lastChecked) {
      const secondsSinceCheck = (Date.now() - new Date(member.lastChecked).getTime()) / 1000;
      if (secondsSinceCheck < minInterval) continue;
    }

    checkedCount++;
    let stillHoldsNft = false;

    for (const rule of member.rules) {
      if (await checkNftOwnership(member.walletAddress, rule.collectionId, rule.tokenId, rule.minBalance)) {
        stillHoldsNft = true;
        break;
      }
    }

    if (stillHoldsNft) {
      await query(`UPDATE members SET last_checked = now() WHERE id = $1`, [member.memberId]);
    } else {
      try {
        await bot.api.banChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId), {
          until_date: Math.floor(Date.now() / 1000) + 40,
        });
      } catch (err) {
        console.error(`[CRON] Failed to kick ${member.userTelegramId}:`, err);
      }

      await query(`UPDATE members SET status = 'KICKED', last_checked = now() WHERE id = $1`, [member.memberId]);
      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [member.groupId, member.userId, "USER_KICKED", JSON.stringify({ reason: "NFT no longer held" })],
      );

      kickedCount++;
    }
  }

  console.log(`[CRON] Re-check done. Checked: ${checkedCount}, Kicked: ${kickedCount}`);
}

async function kickExpiredPendingMembers(bot: Bot) {
  const result = await query(
    `SELECT m.id, m.group_id, g.telegram_id AS group_telegram_id,
            m.user_id, u.telegram_id AS user_telegram_id
     FROM members m
     JOIN groups g ON g.id = m.group_id
     JOIN users u ON u.id = m.user_id
     WHERE m.status = 'PENDING' AND m.created_at < now() - interval '1 hour'`,
  );

  for (const row of result.rows) {
    // Count previous kicks for this user in this group
    const kickHistory = await query(
      `SELECT COUNT(*) FROM audit_logs
       WHERE group_id = $1 AND user_id = $2 AND action = 'USER_KICKED'`,
      [row.group_id, row.user_id],
    );

    const previousKicks = parseInt(kickHistory.rows[0].count);
    const isBan = previousKicks >= 4;

    try {
      if (isBan) {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id));
      } else {
        await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id), {
          until_date: Math.floor(Date.now() / 1000) + 40,
        });
      }
    } catch (err) {
      console.error(`[CRON] Failed to ${isBan ? "ban" : "kick"} expired member:`, err);
    }

    await query(`UPDATE members SET status = 'KICKED' WHERE id = $1`, [row.id]);
    await query(
      `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [row.group_id, row.user_id, isBan ? "USER_BANNED" : "USER_KICKED",
       JSON.stringify({ reason: isBan ? "Banned after 5 failed verifications" : "Verification timeout (1h)" })],
    );

    console.log(`[CRON] ${isBan ? "Banned" : "Kicked"} expired: ${row.user_telegram_id} from ${row.group_telegram_id}`);
  }
}