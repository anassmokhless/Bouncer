// Runs migrations/001_init.sql (idempotent) in one transaction.

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import pg from "pg";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const filePath: string = path.resolve(
  import.meta.dirname,
  "../../migrations/001_init.sql",
);

// SSL from the URL, same rule as shared/db.ts.
const useSsl = /\bsslmode=(require|verify-ca|verify-full|prefer)\b/.test(
  process.env.DATABASE_URL ?? "",
);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl,
});

async function migrate() {
  const sql: string = await fs.promises.readFile(filePath, "utf-8");

  let client: pg.PoolClient | undefined;
  let inTransaction: boolean = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    inTransaction = true;
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    if (inTransaction && client) {
      try {
        await client.query("ROLLBACK");
      } catch (e) {
        console.error("[MIGRATE] Error during rollback:", e);
      }
    }
    console.error("[MIGRATE] Migration failed:", err);
    process.exit(1);
  } finally {
    if (client) {
      client.release();
    }
  }
}

try {
  await migrate();
  console.log("[MIGRATE] Migration completed successfully.");
} catch (err) {
  // Reached when readFile throws before the inner try — must not exit 0, or
  // the deploy pipeline treats the skipped migration as success.
  console.error("[MIGRATE] Migration failed:", err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
