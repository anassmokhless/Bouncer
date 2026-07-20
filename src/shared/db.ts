import { Pool, QueryResultRow, QueryResult } from "pg";
import dotenv from "dotenv";
dotenv.config();

// TLS on iff the URL asks for it (managed providers set sslmode=...; the
// in-compose Postgres has none and speaks plain TCP).
const useSsl = /\bsslmode=(require|verify-ca|verify-full|prefer)\b/.test(
  process.env.DATABASE_URL ?? "",
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl,
  max: 20, // headroom for advisory-lock + transaction connections across crons
});

pool.on("error", (err) => console.error("[DB] Pool error:", err));

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export { pool };
