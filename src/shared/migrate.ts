// script used for migrations on db structure changes

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import pg from "pg";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

// reusable variable for filepath
const filePath: string = path.resolve(
  import.meta.dirname,
  "../../migrations/001_init.sql",
);

// SSL driven by the connection string, same rule as shared/db.ts — managed
// providers put sslmode=... in the URL; the bundled docker-compose Postgres
// speaks plain TCP. Hardcoding ssl:true made migrate.js unable to connect to
// the local container at all (server does not support SSL).
const useSsl = /\bsslmode=(require|verify-ca|verify-full|prefer)\b/.test(
  process.env.DATABASE_URL ?? "",
);

//connection to db
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl,
});

//actual migration function
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
  console.error("[MIGRATE] Migration failed. Exiting...");
} finally {
  await pool.end();
}
