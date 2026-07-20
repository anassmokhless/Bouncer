import { Context } from "grammy";
import { query, pool } from "../../shared/db.js";

// When Telegram converts a basic group to a supergroup it assigns a new chat_id;
// update groups.telegram_id to match. The internal UUID and all child rows are
// unchanged, so only this column moves.
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
    // 23505 = a duplicate group row already exists under newId (a concurrent
    // getOrCreateGroup created an empty one first). Discard that duplicate and
    // move the original row over, in one transaction.
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
    // Other failures: log loudly. Telegram never resends this event, so a failure
    // here needs manual reconciliation — but at least it's visible.
    console.error(`[BOT] Chat migration ${oldId} → ${newId} failed — group may keep the old telegram_id:`, err);
  }
}
