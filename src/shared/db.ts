import { Pool, QueryResultRow, QueryResult } from "pg";
import dotenv from "dotenv";
dotenv.config();

//connection to db
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: true,
});

//helper function for queries
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<QueryResult<T>> {
  return pool.query<T>(text, params);
}

export { pool };
