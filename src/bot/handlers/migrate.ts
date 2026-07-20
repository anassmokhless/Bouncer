import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";

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

  try {
    const result = await query(
      `UPDATE groups SET telegram_id = $1 WHERE telegram_id = $2`,
      [newId, oldId],
    );

    if ((result.rowCount ?? 0) > 0) {
      console.log(`[BOT] Group migrated: ${oldId} → ${newId}`);
    }
  } catch (err: any) {
    // 23505 = unique_violation on groups.telegram_id: a fresh (rule-less) group
    // row was already created under newId by a concurrent getOrCreateGroup
    // before this migration ran, so the straight UPDATE collides. Reconcile in
    // one transaction — discard that empty duplicate, then move the original
    // (rich: rules/members/admins/audit) row to newId. Without this the
    // original keeps the old id, every future event lands on the empty new row,
    // and the group ends up rule-less → everyone auto-verifies (silent gating
    // bypass). Any stray child rows on the duplicate cascade away and self-heal
    // on the members' next message.
    if (err?.code === "23505") {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM groups WHERE telegram_id = $1`, [newId]);
        await client.query(`UPDATE groups SET telegram_id = $1 WHERE telegram_id = $2`, [newId, oldId]);
        await client.query("COMMIT");
        console.log(`[BOT] Group migrated (reconciled duplicate): ${oldId} → ${newId}`);
      } catch (mergeErr) {
        await client.query("ROLLBACK");
        console.error(`[BOT] Chat migration ${oldId} → ${newId} failed to reconcile duplicate row:`, mergeErr);
      } finally {
        client.release();
      }
      return;
    }
    // Any other failure (DB blip): log loudly. Telegram won't resend
    // migrate_from_chat_id, so this needs manual reconciliation if it fires —
    // but at least it's visible instead of silently swallowed by bot.catch.
    console.error(`[BOT] Chat migration ${oldId} → ${newId} failed — group may keep the old telegram_id:`, err);
  }
}
