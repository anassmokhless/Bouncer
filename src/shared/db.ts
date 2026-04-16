import { Pool, QueryResultRow, QueryResult } from "pg";
import dotenv from "dotenv";
dotenv.config();

//connection to db
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
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
