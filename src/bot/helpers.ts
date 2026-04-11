import { query } from "../shared/db.js";

export async function getOrCreateGroup(telegramId: string, title: string) {
  const result = await query(
    `INSERT INTO groups (telegram_id, title)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET title = $2
     RETURNING *`,
    [telegramId, title],
  );
  return result.rows[0];
}

export async function getOrCreateUser(telegramId: string,username?: string,firstName?: string,) {
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE($2, users.username),
       first_name = COALESCE($3, users.first_name)
     RETURNING *`,
    [telegramId, username || null, firstName || null],
  );
  return result.rows[0];
}