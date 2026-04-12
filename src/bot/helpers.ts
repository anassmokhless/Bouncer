import { query } from "../shared/db.js";
import { hasBouncerPass } from "../shared/enjin.js";

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

//check if a user holds the bouncer pass by telegram id
export async function checkBouncerAccess(telegramId: string): Promise<boolean> {
  if (!process.env.BOUNCER_COLLECTION_ID) return true; // early access disabled

  const user = await query(
    `SELECT wallet_address FROM users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (!user.rows[0]?.wallet_address) return false;
  return hasBouncerPass(user.rows[0].wallet_address);
}