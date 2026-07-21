// Seed script to insert fake demo data for dashboard preview
// Run: npx tsx testscripts/seed-demo.ts <your-telegram-id>

import dotenv from "dotenv";
import path from "path";
import pg from "pg";

dotenv.config({ path: path.resolve(import.meta.dirname, "../.env") });

const telegramId = process.argv[2];
if (!telegramId) {
  console.error("Usage: npx tsx testscripts/seed-demo.ts <your-telegram-id>");
  process.exit(1);
}

// SSL from the URL, same rule as shared/db.ts.
const useSsl = /\bsslmode=(require|verify-ca|verify-full|prefer)\b/.test(
  process.env.DATABASE_URL ?? "",
);

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl,
});

async function seed() {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Upsert the admin user (you)
    const adminResult = await client.query(
      `INSERT INTO users (telegram_id, username, first_name, wallet_address, is_verified, verified_at)
       VALUES ($1, 'bouncer_admin', 'Admin', 'efSjQ3r6J1kFeP8tAu5oDv2PZLexWb4iMyVlIjC2E0qU6Tg8', true, now())
       ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
       RETURNING id`,
      [telegramId],
    );
    const adminId = adminResult.rows[0].id;

    // Create 3 demo groups
    const groups = [
      { telegramId: "-1001000000001", title: "Enjin Holders VIP" },
      { telegramId: "-1001000000002", title: "NFT Collectors Lounge" },
      { telegramId: "-1001000000003", title: "Bouncer Beta Testers" },
    ];

    const groupIds: string[] = [];

    for (const g of groups) {
      const result = await client.query(
        `INSERT INTO groups (telegram_id, title)
         VALUES ($1, $2)
         ON CONFLICT (telegram_id) DO UPDATE SET title = EXCLUDED.title
         RETURNING id`,
        [g.telegramId, g.title],
      );
      groupIds.push(result.rows[0].id);

      // Make you admin of each group
      await client.query(
        `INSERT INTO group_admins (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [result.rows[0].id, adminId],
      );
    }

    // Create fake users
    const fakeUsers = [
      {
        telegramId: "900001",
        username: "alice_nft",
        firstName: "Alice",
        wallet: "efTkR8y4n3V1D5pEuAJMbe1RsNqxXg7ueJMVHxqsT4pJ9R4gZ",
      },
      {
        telegramId: "900002",
        username: "bob_hodl",
        firstName: "Bob",
        wallet: "efUqJ7s2M4nKdR6vCx8pGw3QaTfYbE9hNzWmLkXs5D2rV8Fg4",
      },
      {
        telegramId: "900003",
        username: "carol_web3",
        firstName: "Carol",
        wallet: "efWpL5t8K2mHfS9uBv7qEx4RbNgYc6jPwAzXnJkD3F1sT7Uh9",
      },
      {
        telegramId: "900004",
        username: "dave_enjin",
        firstName: "Dave",
        wallet: null,
      },
      {
        telegramId: "900005",
        username: null,
        firstName: "Eve",
        wallet: "efXrM6u9L3nJgT1vCw8rFy5ScPhZd7kQxBaYoKlE4G2uV9Wi0",
      },
      {
        telegramId: "900006",
        username: "frank_defi",
        firstName: "Frank",
        wallet: "efYsN7v0M4oKhU2wDx9sGz6TdQiAe8lRyBbZpLmF5H3vW0Xj1",
      },
      {
        telegramId: "900007",
        username: "grace_nft",
        firstName: "Grace",
        wallet: null,
      },
      {
        telegramId: "900008",
        username: "hank_crypto",
        firstName: "Hank",
        wallet: "efZtO8w1N5pLiV3xEy0tHA7UeRjBf9mSzCcAqMnG6I4wX1Yk2",
      },
    ];

    const userIds: string[] = [];

    for (const u of fakeUsers) {
      const result = await client.query(
        `INSERT INTO users (telegram_id, username, first_name, wallet_address, is_verified, verified_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
         RETURNING id`,
        [
          u.telegramId,
          u.username,
          u.firstName,
          u.wallet,
          !!u.wallet,
          u.wallet ? new Date(Date.now() - Math.random() * 7 * 86400000) : null,
        ],
      );
      userIds.push(result.rows[0].id);
    }

    // Add NFT rules to groups
    const rules = [
      { groupIdx: 0, collectionId: "36105", tokenId: "0", minBalance: 1 },
      { groupIdx: 0, collectionId: "36105", tokenId: "1", minBalance: 2 },
      { groupIdx: 1, collectionId: "40200", tokenId: null, minBalance: 1 },
      { groupIdx: 2, collectionId: "50100", tokenId: "5", minBalance: 1 },
    ];

    for (const r of rules) {
      await client.query(
        `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance) VALUES ($1, $2, $3, $4)`,
        [groupIds[r.groupIdx], r.collectionId, r.tokenId, r.minBalance],
      );
    }

    // Add members to groups with mixed statuses
    const memberships = [
      // Group 0: Enjin Holders VIP
      {
        groupIdx: 0,
        userIdx: 0,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 3600000),
      },
      {
        groupIdx: 0,
        userIdx: 1,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 7200000),
      },
      { groupIdx: 0, userIdx: 2, status: "PENDING", lastChecked: null },
      { groupIdx: 0, userIdx: 3, status: "PENDING", lastChecked: null },
      {
        groupIdx: 0,
        userIdx: 4,
        status: "KICKED",
        lastChecked: new Date(Date.now() - 86400000),
      },
      // Group 1: NFT Collectors Lounge
      {
        groupIdx: 1,
        userIdx: 0,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 1800000),
      },
      {
        groupIdx: 1,
        userIdx: 5,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 5400000),
      },
      { groupIdx: 1, userIdx: 6, status: "PENDING", lastChecked: null },
      {
        groupIdx: 1,
        userIdx: 7,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 10800000),
      },
      // Group 2: Bouncer Beta Testers
      {
        groupIdx: 2,
        userIdx: 1,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 600000),
      },
      {
        groupIdx: 2,
        userIdx: 2,
        status: "VERIFIED",
        lastChecked: new Date(Date.now() - 900000),
      },
      {
        groupIdx: 2,
        userIdx: 4,
        status: "LEFT",
        lastChecked: new Date(Date.now() - 172800000),
      },
    ];

    for (const m of memberships) {
      await client.query(
        `INSERT INTO members (group_id, user_id, status, last_checked)
         VALUES ($1, $2, $3::member_status, $4)
         ON CONFLICT (group_id, user_id) DO NOTHING`,
        [groupIds[m.groupIdx], userIds[m.userIdx], m.status, m.lastChecked],
      );
    }

    // Add some audit logs
    const actions = [
      {
        groupIdx: 0,
        userIdx: 0,
        action: "USER_VERIFIED",
        details: {
          walletAddress: fakeUsers[0].wallet,
          collectionId: "36105",
          tokenId: "0",
        },
        ago: 6 * 3600000,
      },
      {
        groupIdx: 0,
        userIdx: 1,
        action: "USER_VERIFIED",
        details: {
          walletAddress: fakeUsers[1].wallet,
          collectionId: "36105",
          tokenId: "0",
        },
        ago: 5 * 3600000,
      },
      {
        groupIdx: 0,
        userIdx: 4,
        action: "USER_KICKED",
        details: { reason: "NFT no longer held" },
        ago: 86400000,
      },
      {
        groupIdx: 1,
        userIdx: 0,
        action: "USER_AUTO_VERIFIED",
        details: { collectionId: "40200" },
        ago: 2 * 3600000,
      },
      {
        groupIdx: 1,
        userIdx: 5,
        action: "USER_VERIFIED",
        details: {
          walletAddress: fakeUsers[5].wallet,
          collectionId: "40200",
          tokenId: null,
        },
        ago: 4 * 3600000,
      },
      {
        groupIdx: 0,
        userIdx: null,
        action: "RULE_ADDED",
        details: { collectionId: "36105", tokenId: "0", minBalance: 1 },
        ago: 24 * 3600000,
      },
      {
        groupIdx: 1,
        userIdx: null,
        action: "RULE_ADDED",
        details: { collectionId: "40200", tokenId: null, minBalance: 1 },
        ago: 20 * 3600000,
      },
      {
        groupIdx: 2,
        userIdx: 1,
        action: "USER_VERIFIED",
        details: {
          walletAddress: fakeUsers[1].wallet,
          collectionId: "50100",
          tokenId: "5",
        },
        ago: 3600000,
      },
      {
        groupIdx: 2,
        userIdx: 4,
        action: "USER_KICKED",
        details: { reason: "Verification timeout (1h)" },
        ago: 172800000,
      },
    ];

    for (const a of actions) {
      await client.query(
        `INSERT INTO audit_logs (group_id, user_id, action, details, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          groupIds[a.groupIdx],
          a.userIdx !== null ? userIds[a.userIdx] : adminId,
          a.action,
          JSON.stringify(a.details),
          new Date(Date.now() - a.ago),
        ],
      );
    }

    await client.query("COMMIT");
    console.log("[SEED] Demo data inserted successfully!");
    console.log(`  - 3 groups`);
    console.log(`  - 8 fake users`);
    console.log(`  - 4 NFT rules`);
    console.log(`  - ${memberships.length} memberships`);
    console.log(`  - ${actions.length} audit logs`);
    console.log(`  - You (${telegramId}) are admin of all 3 groups`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[SEED] Failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

await seed();
