import { Pool, QueryResultRow, QueryResult } from "pg";
import dotenv from "dotenv";
dotenv.config();

// TLS is driven by the connection string: managed providers (Neon, RDS, ...)
// put sslmode=require/verify-ca/verify-full in their URLs, a local or
// in-compose Postgres has no sslmode param and speaks plain TCP. Hardcoding
// ssl: true here would make the pool refuse non-TLS servers entirely.
const useSsl = /\bsslmode=(require|verify-ca|verify-full|prefer)\b/.test(
  process.env.DATABASE_URL ?? "",
);

//connection to db
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl,
  // Default is 10. Bumped to 20 to give headroom for advisory-lock connections
  // (one per active cron) on top of transaction connections held by cron workers.
  // Worst case: all 4 crons firing simultaneously + recheck mid-batch ≈ 10-11
  // concurrent connections. 20 gives 2x safety margin.
  max: 20,
});

pool.on("error", (err) => console.error("[DB] Pool error:", err));

//helper function for queries
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export { pool };
