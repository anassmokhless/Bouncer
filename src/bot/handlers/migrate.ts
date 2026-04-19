import { Context } from "grammy";
import { query } from "../../shared/db.js";

// Keep the DB in sync when Telegram auto-converts a basic group to a supergroup.
// Triggers for conversion: 200-member cap, enabling "approval required" / public
// username / slow-mode / forum, etc. Telegram gives the group a new chat_id;
// without this handler the bot keeps the old chat_id in `groups.telegram_id`
// and all gating silently breaks because event lookups won't find the row.
//
// The internal groups.id (UUID) doesn't change, so group_admins, nft_rules,
// members, audit_logs — all of them — survive the migration automatically.
// Only the telegram_id column needs updating.
export async function handleChatMigration(ctx: Context) {
  const newId = ctx.chat?.id.toString();
  const oldId = ctx.message?.migrate_from_chat_id?.toString();
  if (!newId || !oldId) return;

  const result = await query(
    `UPDATE groups SET telegram_id = $1 WHERE telegram_id = $2`,
    [newId, oldId],
  );

  if ((result.rowCount ?? 0) > 0) {
    console.log(`[BOT] Group migrated: ${oldId} → ${newId}`);
  }
}
