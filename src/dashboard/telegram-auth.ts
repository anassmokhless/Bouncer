import crypto from "crypto";
import { query } from "../shared/db.js";

interface TelegramLoginData {
  id: string;
  first_name?: string;
  // Part of the signed payload (when present), so it must go into the HMAC
  // check-string even though we never store it.
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

export function verifyTelegramLogin(data: TelegramLoginData): boolean {
  const { hash, ...rest } = data;

  // HMAC-SHA256 is 64 hex chars.
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return false;

  const secret = crypto
    .createHash("sha256")
    .update(process.env.BOT_TOKEN!)
    .digest();

  const checkString = Object.keys(rest)
    .sort()
    .filter((key) => rest[key as keyof typeof rest] !== undefined)
    .map((key) => `${key}=${rest[key as keyof typeof rest]}`)
    .join("\n");

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  if (!crypto.timingSafeEqual(Buffer.from(hmac, "hex"), Buffer.from(hash, "hex"))) return false;

  // Reject blobs older than 5 min to bound replay (needs a synced server clock).
  const authDate = parseInt(data.auth_date);
  if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > 300) return false;

  return true;
}

export async function upsertTelegramUser(data: TelegramLoginData) {
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE($2, users.username),
       first_name = COALESCE($3, users.first_name)
     RETURNING *`,
    [data.id, data.username || null, data.first_name || null],
  );
  return result.rows[0];
}