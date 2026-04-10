# NFT-Gated Telegram Bot — Complete Build Guide

> Single bot, multi-tenant. Each Telegram group has its own NFT rules.
> Stack: Grammy + node-cron | Express + EJS + Tailwind CSS | PostgreSQL + pg
> Dev environment: DevContainer (Docker)

---

# PHASE 0 — PREREQUISITES

## 0.1 Software You Need on Your Host Machine

You need exactly three things installed on your Windows machine:

1. **Docker Desktop** — runs the devcontainer + PostgreSQL
2. **VS Code** — your editor
3. **Dev Containers extension** — connects VS Code to the container

### Install Docker Desktop

Download from https://www.docker.com/products/docker-desktop/
- Run the installer
- Restart your computer when prompted
- Open Docker Desktop and wait until it says "Docker Desktop is running"
- Verify in a terminal:

```bash
docker --version
# Docker version 27.x.x or similar
```

> If you're on Windows 11 Home, Docker Desktop uses WSL2 automatically.
> Make sure WSL2 is enabled: open PowerShell as admin and run:
> `wsl --install` (if not already installed)

### Install VS Code

Download from https://code.visualstudio.com/ (skip if already installed).

### Install Dev Containers Extension

Open VS Code, press `Ctrl+Shift+X`, search for "Dev Containers" by Microsoft, click Install.

## 0.2 Create Telegram Bot Token

1. Open Telegram on your phone or desktop
2. Search for `@BotFather` and open a chat
3. Send `/newbot`
4. BotFather asks for a name — type anything (e.g., `NFT Gate Bot`)
5. BotFather asks for a username — must end in `bot` (e.g., `my_nftgate_bot`)
6. BotFather replies with your **bot token** — looks like `7123456789:AAH...`
7. **Save this token.** You'll need it later.

Now configure the bot:

```
/setprivacy → select your bot → Disable
```
(This lets the bot read messages in groups.)

```
/setjoingroup → select your bot → Enable
```
(This lets the bot be added to groups.)

```
/setdomain → select your bot → yourdomain.com
```
(For the Telegram login widget. Set to your real domain when deploying. Skip for now if you don't have one yet.)

## 0.3 Enjin Platform API

The Enjin Platform GraphQL endpoint is:
```
https://platform.enjin.io/graphql
```

You need an API token from the Enjin Platform dashboard. Sign in at https://platform.enjin.io, navigate to your API settings, and generate a token.

Visit `https://platform.enjin.io/graphql` in your browser to explore the schema in the GraphQL playground — you'll need this to verify the query fields match your Enjin Platform version.

## 0.4 Create Neon Database

Neon is a free serverless PostgreSQL host. You'll use the same database for development and can upgrade to a paid plan later.

1. Go to https://neon.tech and sign up (GitHub login works)
2. Click **"New Project"**
3. Project name: `tgbot`
4. PostgreSQL version: **16**
5. Region: pick the closest to you
6. Click **"Create Project"**
7. Neon shows your connection string — it looks like:
   ```
   postgresql://username:password@ep-something-123456.region.aws.neon.tech/neondb?sslmode=require
   ```
8. **Copy and save this connection string.** You'll need it for the `.env` file.

> **Tip:** You can always find your connection string later in the Neon dashboard under **Connection Details**.

## 0.5 Generate SESSION_SECRET

You'll need a random secret for Express session signing. Generate one later inside the devcontainer:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

**Save the output.** You'll need it for the `.env` file.

---

# PHASE 1 — PROJECT SCAFFOLDING

## 1.1 Create the Project Folder

```bash
cd C:/Users/anass/Documents
mkdir tgbot
cd tgbot
```

## 1.2 Create the DevContainer

Create the `.devcontainer` folder:

```bash
mkdir .devcontainer
```

Create `.devcontainer/devcontainer.json`:

```json
{
  "name": "NFT Gate Bot",
  "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20-bullseye",
  "forwardPorts": [3000],
  "customizations": {
    "vscode": {
      "extensions": ["esbenp.prettier-vscode"],
      "settings": {
        "editor.formatOnSave": true,
        "editor.defaultFormatter": "esbenp.prettier-vscode",
        "explorer.compactFolders": false,
        "[ejs]": {
          "editor.formatOnSave": false
        }
      }
    }
  },
  "postCreateCommand": "npm install -g ts-node typescript nodemon prettier"
}
```

## 1.3 Open in DevContainer

1. Open VS Code
2. Press `Ctrl+Shift+P` → type "Dev Containers: Open Folder in Container"
3. Select `C:\Users\anass\Documents\tgbot`
4. VS Code will:
   - Build the Docker container (first time takes 2-5 minutes)
   - Run `npm install -g ts-node typescript nodemon prettier` (from postCreateCommand)
5. When the terminal appears at the bottom, you're inside the container.

**From this point on, ALL commands run inside the devcontainer terminal.**

Verify everything works:

```bash
node -v          # v20.x.x
npm -v           # 10.x.x
```

## 1.4 Create the Directory Structure

From `/workspace`:

```bash
mkdir -p src/bot/commands
mkdir -p src/bot/handlers
mkdir -p src/dashboard/routes
mkdir -p src/shared
mkdir -p views/partials
mkdir -p public/css
mkdir -p migrations
```

Your tree should look like:

```
tgbot/
├── .devcontainer/
│   └── devcontainer.json
├── migrations/
├── public/
│   └── css/
├── src/
│   ├── bot/
│   │   ├── commands/
│   │   └── handlers/
│   ├── dashboard/
│   │   └── routes/
│   └── shared/
└── views/
    └── partials/
```

## 1.5 Initialize the Project

```bash
cd /workspace
npm init -y
```

Edit `package.json` — replace its contents with:

```json
{
  "name": "tgbot",
  "private": true,
  "type": "module",
  "scripts": {
    "dev:bot": "nodemon --exec tsx src/bot/index.ts",
    "dev:dashboard": "nodemon --exec tsx src/dashboard/server.ts",
    "build": "tsc",
    "start:bot": "node dist/bot/index.js",
    "start:dashboard": "node dist/dashboard/server.js",
    "db:migrate": "tsx src/shared/migrate.ts",
    "css:build": "tailwindcss -i ./public/css/input.css -o ./public/css/output.css",
    "css:watch": "tailwindcss -i ./public/css/input.css -o ./public/css/output.css --watch",
    "dev": "concurrently \"npm:dev:bot\" \"npm:dev:dashboard\" \"npm:css:watch\""
  }
}
```

## 1.6 Install Dependencies

```bash
# Bot
npm install grammy dotenv node-cron graphql-request graphql

# Dashboard
npm install express ejs express-session connect-pg-simple pg

# Dev
npm install -D typescript tsx @types/node @types/express @types/ejs @types/express-session @types/connect-pg-simple @types/pg @types/node-cron tailwindcss @tailwindcss/cli concurrently
```

## 1.7 TypeScript Configuration

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "declaration": true,
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

## 1.8 Tailwind CSS Setup

Create `public/css/input.css`:

```css
@import "tailwindcss";
```

Build the CSS:

```bash
npm run css:build
```

> Tailwind v4 auto-detects your EJS files — no config file needed.

## 1.9 Environment File

Create `.env`:

```env
# Database (Neon connection string from Phase 0.4)
DATABASE_URL="PASTE_YOUR_NEON_CONNECTION_STRING_HERE"

# Telegram
BOT_TOKEN="PASTE_YOUR_BOT_TOKEN_HERE"

# Enjin
ENJIN_API_URL="https://platform.enjin.io/graphql"
ENJIN_API_TOKEN="PASTE_YOUR_ENJIN_TOKEN_HERE"

# Dashboard
SESSION_SECRET="PASTE_YOUR_GENERATED_SECRET_HERE"
DASHBOARD_URL="http://localhost:3000"
BOT_USERNAME="your_bot_username_without_at"
```

## 1.10 Git Setup

Create `.gitignore`:

```
node_modules/
dist/
.env
public/css/output.css
*.tsbuildinfo
```

Create `.prettierrc`:

```json
{
  "semi": true,
  "singleQuote": false,
  "trailingComma": "all",
  "printWidth": 100,
  "tabWidth": 2
}
```

```bash
git init
git add .
git commit -m "chore: initial project scaffolding"
```

---

# PHASE 2 — DATABASE

## 2.1 Create the Migration

Create `migrations/001_init.sql`:

```sql
-- ─────────────────────────────────────────────────────────
-- Enum: member status
-- ─────────────────────────────────────────────────────────
CREATE TYPE member_status AS ENUM ('PENDING', 'VERIFIED', 'KICKED', 'LEFT');

-- ─────────────────────────────────────────────────────────
-- Groups
-- ─────────────────────────────────────────────────────────
CREATE TABLE groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id TEXT UNIQUE NOT NULL,
  title       TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- Users
-- ─────────────────────────────────────────────────────────
CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  telegram_id    TEXT UNIQUE NOT NULL,
  username       TEXT,
  first_name     TEXT,
  wallet_address TEXT,
  is_verified    BOOLEAN NOT NULL DEFAULT false,
  verified_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- NFT Rules
-- ─────────────────────────────────────────────────────────
CREATE TABLE nft_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id        UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  collection_id   TEXT NOT NULL,
  token_id        TEXT,
  min_balance     INT NOT NULL DEFAULT 1,
  check_interval  INT NOT NULL DEFAULT 3600,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- Members (join table: groups <-> users)
-- ─────────────────────────────────────────────────────────
CREATE TABLE members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id     UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       member_status NOT NULL DEFAULT 'PENDING',
  last_checked TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- ─────────────────────────────────────────────────────────
-- Group Admins
-- ─────────────────────────────────────────────────────────
CREATE TABLE group_admins (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- ─────────────────────────────────────────────────────────
-- Audit Logs
-- ─────────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id   UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id    UUID REFERENCES users(id),
  action     TEXT NOT NULL,
  details    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────
-- Pending Verifications (QR code polling)
-- ─────────────────────────────────────────────────────────
CREATE TABLE pending_verifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verification_id  TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT now() + interval '5 minutes',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pending_verifications_expires ON pending_verifications (expires_at);

-- ─────────────────────────────────────────────────────────
-- Session store (for express-session + connect-pg-simple)
-- ─────────────────────────────────────────────────────────
CREATE TABLE session (
  sid    VARCHAR NOT NULL COLLATE "default",
  sess   JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  PRIMARY KEY (sid)
);

-- ─────────────────────────────────────────────────────────
-- Performance indexes
-- ─────────────────────────────────────────────────────────
CREATE INDEX idx_session_expire ON session (expire);
CREATE INDEX idx_members_last_checked ON members (last_checked);
CREATE INDEX idx_members_status ON members (status);
CREATE INDEX idx_audit_logs_created_at ON audit_logs (created_at);
CREATE INDEX idx_nft_rules_group_id ON nft_rules (group_id);
```

## 2.2 Create the Database Client

Create `src/shared/db.ts`:

```typescript
import pg from "pg";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: any[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export { pool };
```

> **Note:** `ssl: { rejectUnauthorized: false }` is required for Neon connections.

## 2.3 Create the Migration Runner

Since we're using Neon (no local `psql`), we run migrations through Node.js.

Create `src/shared/migrate.ts`:

```typescript
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import pg from "pg";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function migrate() {
  const sql = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../migrations/001_init.sql"),
    "utf-8",
  );

  try {
    await pool.query(sql);
    console.log("[MIGRATE] Migration complete.");
  } catch (err) {
    console.error("[MIGRATE] Migration failed:", err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

migrate();
```

## 2.4 Run the Migration

```bash
npm run db:migrate
```

You should see: `[MIGRATE] Migration complete.`

## 2.4 Commit

```bash
git add .
git commit -m "feat: add database schema and pg client"
```

---

# PHASE 3 — ENJIN API CLIENT

## 3.1 Create the Enjin Client

Create `src/shared/enjin.ts`:

```typescript
import { GraphQLClient, gql } from "graphql-request";

let _client: GraphQLClient | null = null;

function getClient() {
  if (!_client) {
    _client = new GraphQLClient(process.env.ENJIN_API_URL!, {
      headers: process.env.ENJIN_API_TOKEN
        ? { Authorization: `Bearer ${process.env.ENJIN_API_TOKEN}` }
        : {},
    });
  }
  return _client;
}

// ─── Types ─────────────────────────────────────────────

interface TokenAccountNode {
  balance: number;
  collection: { collectionId: string };
  token: { tokenId: string };
}

interface GetWalletResponse {
  GetWallet: {
    tokenAccounts: {
      edges: Array<{ node: TokenAccountNode }>;
    };
  } | null;
}

interface RequestAccountResponse {
  RequestAccount: {
    qrCode: string;
    verificationId: string;
  };
}

interface GetWalletByVerificationResponse {
  GetWallet: {
    account: {
      address: string;
    };
  } | null;
}

// ─── Request Account Verification (QR Code) ──────────
//
// Generates a QR code that the user scans with their Enjin Wallet.
// Returns the QR code URL and a verificationId to poll later.

export async function requestAccountVerification(): Promise<{
  qrCode: string;
  verificationId: string;
}> {
  const query = gql`
    query RequestAccount {
      RequestAccount {
        qrCode
        verificationId
      }
    }
  `;

  const data = await getClient().request<RequestAccountResponse>(query);
  return data.RequestAccount;
}

// ─── Check Verification Status ───────────────────────
//
// After the user scans the QR code, poll this to get their wallet address.
// Returns the wallet address if verified, or null if still pending.

export async function getVerifiedWallet(
  verificationId: string,
): Promise<string | null> {
  const query = gql`
    query GetVerifiedWallet($verificationId: String!) {
      GetWallet(verificationId: $verificationId) {
        account {
          address
        }
      }
    }
  `;

  try {
    const data = await getClient().request<GetWalletByVerificationResponse>(
      query,
      { verificationId },
    );
    return data.GetWallet?.account?.address || null;
  } catch {
    return null;
  }
}

// ─── Check NFT Ownership ──────────────────────────────
//
// Returns true if the wallet holds at least `minBalance` of the
// specified token. If tokenId is null, any token in the collection counts.

export async function checkNftOwnership(
  walletAddress: string,
  collectionId: string,
  tokenId: string | null,
  minBalance: number = 1,
): Promise<boolean> {
  const query = gql`
    query GetWallet($address: String!) {
      GetWallet(account: $address) {
        tokenAccounts(first: 100) {
          edges {
            node {
              balance
              collection { collectionId }
              token { tokenId }
            }
          }
        }
      }
    }
  `;

  try {
    const data = await getClient().request<GetWalletResponse>(query, {
      address: walletAddress,
    });

    if (!data.GetWallet) return false;

    const tokens = data.GetWallet.tokenAccounts.edges.map((e) => e.node);

    return tokens.some((t) => {
      const matchesCollection = t.collection.collectionId === collectionId;
      const matchesToken = tokenId ? t.token.tokenId === tokenId : true;
      const matchesBalance = t.balance >= minBalance;
      return matchesCollection && matchesToken && matchesBalance;
    });
  } catch (error) {
    console.error("[ENJIN] NFT check failed:", error);
    return false;
  }
}
```

> **IMPORTANT**: The exact GraphQL fields depend on your Enjin Platform version.
> Open `https://platform.enjin.io/graphql` in a browser and run the queries
> against a real address to verify the response shape matches these types.

## 3.2 Commit

```bash
git add .
git commit -m "feat: add enjin graphql client with QR verification and NFT check"
```

---

# PHASE 4 — BOT IMPLEMENTATION

## 4.1 Helper: Get or Create Group/User

Create `src/bot/helpers.ts`:

```typescript
import { query } from "../shared/db.js";

export async function getOrCreateGroup(telegramId: string, title: string) {
  const result = await query(
    `INSERT INTO groups (telegram_id, title)
     VALUES ($1, $2)
     ON CONFLICT (telegram_id) DO UPDATE SET title = $2, updated_at = now()
     RETURNING *`,
    [telegramId, title],
  );
  return result.rows[0];
}

export async function getOrCreateUser(
  telegramId: string,
  username?: string,
  firstName?: string,
) {
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE($2, users.username),
       first_name = COALESCE($3, users.first_name),
       updated_at = now()
     RETURNING *`,
    [telegramId, username || null, firstName || null],
  );
  return result.rows[0];
}
```

## 4.2 /verify Command (QR Code Flow)

The user runs `/verify`, gets a QR code, and the bot stores the verification in the database. A cron job polls Enjin every 15 seconds for pending verifications — no blocking loop.

Create `src/bot/commands/verify.ts`:

```typescript
import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { requestAccountVerification } from "../../shared/enjin.js";
import { getOrCreateUser } from "../helpers.js";

export async function verifyCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();
  const user = await getOrCreateUser(telegramId, from.username, from.first_name);

  // Check if already verified
  if (user.wallet_address) {
    await ctx.reply(
      `You already have a wallet linked: \`${user.wallet_address}\`\n\nUse /unlink to remove it first.`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Check for existing pending verification
  const pending = await query(
    `SELECT id FROM pending_verifications WHERE user_id = $1 AND expires_at > now()`,
    [user.id],
  );

  if (pending.rows.length > 0) {
    await ctx.reply("You already have a pending verification. Please scan the QR code sent earlier, or wait for it to expire (5 minutes).");
    return;
  }

  // Request QR code from Enjin
  let qrCode: string;
  let verificationId: string;

  try {
    const result = await requestAccountVerification();
    qrCode = result.qrCode;
    verificationId = result.verificationId;
  } catch (error) {
    console.error("[VERIFY] Failed to request account verification:", error);
    await ctx.reply("Failed to generate QR code. Please try again later.");
    return;
  }

  // Store in DB — cron job will poll for completion
  await query(
    `INSERT INTO pending_verifications (user_id, verification_id, telegram_chat_id)
     VALUES ($1, $2, $3)`,
    [user.id, verificationId, ctx.chat!.id.toString()],
  );

  await ctx.replyWithPhoto(qrCode, {
    caption: [
      "Scan this QR code with your **Enjin Wallet** app to verify your wallet.",
      "",
      "I'll notify you once the verification is confirmed (up to 5 minutes).",
    ].join("\n"),
    parse_mode: "Markdown",
  });
}
```

## 4.3 /unlink Command

Create `src/bot/commands/unlink.ts`:

```typescript
import { Context } from "grammy";
import { query } from "../../shared/db.js";

export async function unlinkCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;

  const telegramId = from.id.toString();

  const result = await query(
    `SELECT id, wallet_address FROM users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (result.rows.length === 0 || !result.rows[0].wallet_address) {
    await ctx.reply("You don't have a wallet linked. Use /verify to link one.");
    return;
  }

  const user = result.rows[0];

  await query(
    `UPDATE users SET wallet_address = NULL, is_verified = false, verified_at = NULL, updated_at = now()
     WHERE id = $1`,
    [user.id],
  );

  await query(
    `UPDATE members SET status = 'PENDING', updated_at = now()
     WHERE user_id = $1 AND status = 'VERIFIED'`,
    [user.id],
  );

  await ctx.reply(
    "Wallet unlinked. Your group memberships have been reset to pending.\n\nUse /verify to link a new wallet.",
  );
}
```

## 4.4 /status Command

Create `src/bot/commands/status.ts`:

```typescript
import { Context } from "grammy";
import { query } from "../../shared/db.js";

export async function statusCommand(ctx: Context) {
  const from = ctx.from;
  if (!from) return;

  const result = await query(`SELECT * FROM users WHERE telegram_id = $1`, [
    from.id.toString(),
  ]);

  if (result.rows.length === 0) {
    await ctx.reply("You haven't started verification yet. Use /verify to begin.");
    return;
  }

  const user = result.rows[0];

  if (!user.wallet_address) {
    await ctx.reply("You haven't linked a wallet yet. Use /verify to link one.");
    return;
  }

  const lines = [
    `*Wallet:* \`${user.wallet_address}\``,
    `*Verified:* ${user.is_verified ? "Yes" : "No"}`,
  ];

  if (user.verified_at) {
    lines.push(`*Verified at:* ${new Date(user.verified_at).toLocaleString()}`);
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
}
```

## 4.5 Admin Setup Commands

Create `src/bot/commands/setup.ts`:

```typescript
import { Bot, Context } from "grammy";
import { query } from "../../shared/db.js";
import { getOrCreateGroup, getOrCreateUser } from "../helpers.js";

async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === "private") return false;

  try {
    const member = await ctx.api.getChatMember(ctx.chat.id, ctx.from.id);
    return member.status === "administrator" || member.status === "creator";
  } catch {
    return false;
  }
}

async function syncAdmin(ctx: Context, groupId: string) {
  const user = await getOrCreateUser(
    ctx.from!.id.toString(),
    ctx.from?.username,
    ctx.from?.first_name,
  );

  await query(
    `INSERT INTO group_admins (group_id, user_id)
     VALUES ($1, $2)
     ON CONFLICT (group_id, user_id) DO NOTHING`,
    [groupId, user.id],
  );

  return user;
}

export function registerSetupCommands(bot: Bot) {
  bot.command("setup", async (ctx) => {
    if (ctx.chat?.type === "private") {
      await ctx.reply("This command only works in groups.");
      return;
    }
    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply("Only group admins can configure the bot.");
      return;
    }

    await ctx.reply(
      [
        "Bot Setup Commands:",
        "",
        "/addrule <collection_id> [token_id] [min_balance]",
        "  Add an NFT requirement",
        "",
        "/removerule <rule_number>",
        "  Remove an NFT requirement",
        "",
        "/rules",
        "  View current NFT requirements",
        "",
        "/setinterval <seconds>",
        "  Set re-check interval (minimum 600 = 10min)",
      ].join("\n"),
    );
  });

  bot.command("addrule", async (ctx) => {
    if (ctx.chat?.type === "private") return;
    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply("Only group admins can add rules.");
      return;
    }

    const text = ctx.message?.text || "";
    const parts = text.split(" ").slice(1);

    if (parts.length < 1) {
      await ctx.reply(
        [
          "Usage: /addrule <collection_id> [token_id] [min_balance]",
          "",
          "Examples:",
          "  /addrule 1234             — Any token in collection 1234",
          "  /addrule 1234 5678        — Token 5678 in collection 1234",
          "  /addrule 1234 5678 3      — At least 3 of token 5678",
        ].join("\n"),
      );
      return;
    }

    const collectionId = parts[0];
    const tokenId = parts[1] || null;
    const minBalance = parseInt(parts[2]) || 1;
    const chatId = ctx.chat!.id.toString();

    const group = await getOrCreateGroup(chatId, ctx.chat!.title || "Unknown");

    await query(
      `INSERT INTO nft_rules (group_id, collection_id, token_id, min_balance)
       VALUES ($1, $2, $3, $4)`,
      [group.id, collectionId, tokenId, minBalance],
    );

    const admin = await syncAdmin(ctx, group.id);

    await query(
      `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [group.id, admin.id, "RULE_ADDED", JSON.stringify({ collectionId, tokenId, minBalance })],
    );

    await ctx.reply(
      [
        "NFT rule added!",
        `  Collection: ${collectionId}`,
        `  Token: ${tokenId || "Any"}`,
        `  Min balance: ${minBalance}`,
      ].join("\n"),
    );
  });

  bot.command("rules", async (ctx) => {
    if (ctx.chat?.type === "private") return;

    const chatId = ctx.chat!.id.toString();
    const result = await query(
      `SELECT r.* FROM nft_rules r
       JOIN groups g ON g.id = r.group_id
       WHERE g.telegram_id = $1 AND r.is_active = true
       ORDER BY r.created_at`,
      [chatId],
    );

    if (result.rows.length === 0) {
      await ctx.reply("No NFT rules configured. Use /addrule to add one.");
      return;
    }

    const lines = result.rows.map(
      (r: any, i: number) =>
        `${i + 1}. Collection: ${r.collection_id} | Token: ${r.token_id || "Any"} | Min: ${r.min_balance} | Check: ${r.check_interval}s`,
    );

    await ctx.reply("Current NFT Rules:\n\n" + lines.join("\n"));
  });

  bot.command("removerule", async (ctx) => {
    if (ctx.chat?.type === "private") return;
    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply("Only group admins can remove rules.");
      return;
    }

    const text = ctx.message?.text || "";
    const ruleNumber = parseInt(text.split(" ")[1]);

    if (!ruleNumber || ruleNumber < 1) {
      await ctx.reply("Usage: /removerule <rule_number>\nUse /rules to see the list.");
      return;
    }

    const chatId = ctx.chat!.id.toString();
    const result = await query(
      `SELECT r.id, r.collection_id, r.token_id FROM nft_rules r
       JOIN groups g ON g.id = r.group_id
       WHERE g.telegram_id = $1 AND r.is_active = true
       ORDER BY r.created_at`,
      [chatId],
    );

    if (result.rows.length === 0 || ruleNumber > result.rows.length) {
      await ctx.reply("Invalid rule number. Use /rules to see the list.");
      return;
    }

    const rule = result.rows[ruleNumber - 1];

    await query(
      `UPDATE nft_rules SET is_active = false, updated_at = now() WHERE id = $1`,
      [rule.id],
    );

    const group = await getOrCreateGroup(chatId, ctx.chat!.title || "Unknown");
    const admin = await syncAdmin(ctx, group.id);

    await query(
      `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [
        group.id,
        admin.id,
        "RULE_REMOVED",
        JSON.stringify({ collectionId: rule.collection_id, tokenId: rule.token_id }),
      ],
    );

    await ctx.reply(`Rule ${ruleNumber} removed.`);
  });

  bot.command("setinterval", async (ctx) => {
    if (ctx.chat?.type === "private") return;
    if (!(await isGroupAdmin(ctx))) {
      await ctx.reply("Only group admins can change settings.");
      return;
    }

    const text = ctx.message?.text || "";
    const seconds = parseInt(text.split(" ")[1]);

    if (!seconds || seconds < 600) {
      await ctx.reply("Usage: /setinterval <seconds>\nMinimum: 600 (10 minutes)");
      return;
    }

    const chatId = ctx.chat!.id.toString();

    await query(
      `UPDATE nft_rules SET check_interval = $1, updated_at = now()
       WHERE group_id = (SELECT id FROM groups WHERE telegram_id = $2) AND is_active = true`,
      [seconds, chatId],
    );

    await ctx.reply(`Re-check interval updated to ${seconds} seconds for all rules.`);
  });
}
```

## 4.6 New Member Handler

Create `src/bot/handlers/new-member.ts`:

```typescript
import { Context } from "grammy";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";
import { getOrCreateGroup, getOrCreateUser } from "../helpers.js";

export async function handleNewMembers(ctx: Context) {
  const newMembers = ctx.message?.new_chat_members;
  if (!newMembers || !ctx.chat) return;

  const chatId = ctx.chat.id.toString();
  const group = await getOrCreateGroup(chatId, ctx.chat.title || "Unknown");

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
    [group.id],
  );

  for (const member of newMembers) {
    if (member.is_bot) continue;

    const telegramId = member.id.toString();
    const user = await getOrCreateUser(telegramId, member.username, member.first_name);

    // No rules — allow freely
    if (rules.rows.length === 0) {
      await query(
        `INSERT INTO members (group_id, user_id, status)
         VALUES ($1, $2, 'VERIFIED')
         ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED', updated_at = now()`,
        [group.id, user.id],
      );
      continue;
    }

    // If user has a wallet, check NFT immediately
    if (user.wallet_address) {
      let verified = false;

      for (const rule of rules.rows) {
        const hasNft = await checkNftOwnership(
          user.wallet_address,
          rule.collection_id,
          rule.token_id,
          rule.min_balance,
        );

        if (hasNft) {
          verified = true;

          await query(
            `INSERT INTO members (group_id, user_id, status, last_checked)
             VALUES ($1, $2, 'VERIFIED', now())
             ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'VERIFIED', last_checked = now(), updated_at = now()`,
            [group.id, user.id],
          );

          await query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [group.id, user.id, "USER_AUTO_VERIFIED", JSON.stringify({ collectionId: rule.collection_id })],
          );

          break;
        }
      }

      if (verified) continue;
    }

    // Not verified — set as pending
    await query(
      `INSERT INTO members (group_id, user_id, status)
       VALUES ($1, $2, 'PENDING')
       ON CONFLICT (group_id, user_id) DO UPDATE SET status = 'PENDING', updated_at = now()`,
      [group.id, user.id],
    );

    try {
      await ctx.api.sendMessage(ctx.chat!.id, [
        `Welcome ${member.first_name}! This group requires Enjin NFT ownership.`,
        "",
        "To verify, DM me with: /verify",
        "I'll send you a QR code to scan with your Enjin Wallet.",
        "",
        "You have 24 hours to verify or you'll be removed.",
      ].join("\n"));
    } catch (err) {
      console.error("[BOT] Failed to send welcome message:", err);
    }
  }
}
```

## 4.7 Cron Jobs

Create `src/bot/cron.ts`:

```typescript
import cron from "node-cron";
import { Bot } from "grammy";
import { query } from "../shared/db.js";
import { getVerifiedWallet, checkNftOwnership } from "../shared/enjin.js";

export function startCronJobs(bot: Bot) {
  // Poll pending QR verifications every 15 seconds
  cron.schedule("*/15 * * * * *", async () => {
    try {
      await pollPendingVerifications(bot);
    } catch (err) {
      console.error("[CRON] Verification poll failed:", err);
    }
  });

  cron.schedule("*/10 * * * *", async () => {
    console.log("[CRON] Running NFT ownership re-check...");
    try {
      await recheckVerifiedMembers(bot);
    } catch (err) {
      console.error("[CRON] Re-check failed:", err);
    }
  });

  cron.schedule("0 * * * *", async () => {
    console.log("[CRON] Checking for expired pending members...");
    try {
      await kickExpiredPendingMembers(bot);
    } catch (err) {
      console.error("[CRON] Kick expired failed:", err);
    }
  });

  console.log("[CRON] Jobs scheduled: verify-poll (*/15s), re-check (*/10min), kick-expired (hourly)");
}

async function pollPendingVerifications(bot: Bot) {
  // Get all non-expired pending verifications
  const pending = await query(
    `SELECT pv.id, pv.verification_id, pv.telegram_chat_id, pv.user_id,
            u.telegram_id AS user_telegram_id
     FROM pending_verifications pv
     JOIN users u ON u.id = pv.user_id
     WHERE pv.expires_at > now()`,
  );

  if (pending.rows.length === 0) return;

  for (const row of pending.rows) {
    const walletAddress = await getVerifiedWallet(row.verification_id);
    if (!walletAddress) continue;

    // Check wallet isn't already claimed
    const existing = await query(
      `SELECT id FROM users WHERE wallet_address = $1 AND id != $2`,
      [walletAddress, row.user_id],
    );

    if (existing.rows.length > 0) {
      await bot.api.sendMessage(parseInt(row.telegram_chat_id),
        "This wallet is already linked to another Telegram account.");
      await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);
      continue;
    }

    // Link wallet
    await query(
      `UPDATE users SET wallet_address = $1, is_verified = true, verified_at = now(), updated_at = now()
       WHERE id = $2`,
      [walletAddress, row.user_id],
    );

    // Remove pending verification
    await query(`DELETE FROM pending_verifications WHERE id = $1`, [row.id]);

    // Check NFT ownership for all group memberships
    const memberships = await query(
      `SELECT m.id AS member_id, m.group_id, g.title AS group_title,
              r.collection_id, r.token_id, r.min_balance
       FROM members m
       JOIN groups g ON g.id = m.group_id
       LEFT JOIN nft_rules r ON r.group_id = m.group_id AND r.is_active = true
       WHERE m.user_id = $1`,
      [row.user_id],
    );

    const groupMap = new Map<
      string,
      { groupId: string; title: string; memberId: string; rules: any[] }
    >();

    for (const m of memberships.rows) {
      if (!groupMap.has(m.group_id)) {
        groupMap.set(m.group_id, {
          groupId: m.group_id,
          title: m.group_title,
          memberId: m.member_id,
          rules: [],
        });
      }
      if (m.collection_id) {
        groupMap.get(m.group_id)!.rules.push({
          collectionId: m.collection_id,
          tokenId: m.token_id,
          minBalance: m.min_balance,
        });
      }
    }

    let verifiedGroupCount = 0;

    for (const [, group] of groupMap) {
      if (group.rules.length === 0) continue;

      for (const rule of group.rules) {
        const hasNft = await checkNftOwnership(
          walletAddress,
          rule.collectionId,
          rule.tokenId,
          rule.minBalance,
        );

        if (hasNft) {
          verifiedGroupCount++;
          await query(
            `UPDATE members SET status = 'VERIFIED', last_checked = now(), updated_at = now()
             WHERE id = $1`,
            [group.memberId],
          );
          await query(
            `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
            [group.groupId, row.user_id, "USER_VERIFIED",
             JSON.stringify({ walletAddress, collectionId: rule.collectionId, tokenId: rule.tokenId })],
          );
          break;
        }
      }
    }

    // Notify the user
    let message: string;
    if (verifiedGroupCount > 0) {
      message = `Wallet \`${walletAddress}\` verified! You have access to ${verifiedGroupCount} group(s).`;
    } else if (groupMap.size === 0) {
      message = `Wallet \`${walletAddress}\` verified and linked!\n\nJoin an NFT-gated group and I'll automatically check your holdings.`;
    } else {
      message = `Wallet \`${walletAddress}\` verified and linked, but you don't hold the required NFTs for your current groups. You may be removed after the grace period.`;
    }

    try {
      await bot.api.sendMessage(parseInt(row.telegram_chat_id), message, { parse_mode: "Markdown" });
    } catch (err) {
      console.error(`[CRON] Failed to notify user ${row.user_telegram_id}:`, err);
    }
  }

  // Clean up expired verifications
  await query(`DELETE FROM pending_verifications WHERE expires_at <= now()`);
}

async function recheckVerifiedMembers(bot: Bot) {
  const result = await query(
    `SELECT g.id AS group_id, g.telegram_id AS group_telegram_id,
            m.id AS member_id, m.last_checked,
            u.id AS user_id, u.telegram_id AS user_telegram_id, u.wallet_address,
            r.collection_id, r.token_id, r.min_balance, r.check_interval
     FROM groups g
     JOIN members m ON m.group_id = g.id AND m.status = 'VERIFIED'
     JOIN users u ON u.id = m.user_id
     JOIN nft_rules r ON r.group_id = g.id AND r.is_active = true
     WHERE g.is_active = true AND u.wallet_address IS NOT NULL`,
  );

  const memberChecks = new Map<string, {
    memberId: string;
    groupId: string;
    groupTelegramId: string;
    userId: string;
    userTelegramId: string;
    walletAddress: string;
    lastChecked: Date | null;
    rules: Array<{ collectionId: string; tokenId: string | null; minBalance: number; checkInterval: number }>;
  }>();

  for (const row of result.rows) {
    if (!memberChecks.has(row.member_id)) {
      memberChecks.set(row.member_id, {
        memberId: row.member_id,
        groupId: row.group_id,
        groupTelegramId: row.group_telegram_id,
        userId: row.user_id,
        userTelegramId: row.user_telegram_id,
        walletAddress: row.wallet_address,
        lastChecked: row.last_checked,
        rules: [],
      });
    }
    memberChecks.get(row.member_id)!.rules.push({
      collectionId: row.collection_id,
      tokenId: row.token_id,
      minBalance: row.min_balance,
      checkInterval: row.check_interval,
    });
  }

  let checkedCount = 0;
  let kickedCount = 0;

  for (const [, member] of memberChecks) {
    const minInterval = Math.min(...member.rules.map((r) => r.checkInterval));
    if (member.lastChecked) {
      const secondsSinceCheck = (Date.now() - new Date(member.lastChecked).getTime()) / 1000;
      if (secondsSinceCheck < minInterval) continue;
    }

    checkedCount++;
    let stillHoldsNft = false;

    for (const rule of member.rules) {
      if (await checkNftOwnership(member.walletAddress, rule.collectionId, rule.tokenId, rule.minBalance)) {
        stillHoldsNft = true;
        break;
      }
    }

    if (stillHoldsNft) {
      await query(`UPDATE members SET last_checked = now(), updated_at = now() WHERE id = $1`, [member.memberId]);
    } else {
      try {
        await bot.api.banChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId));
        await bot.api.unbanChatMember(parseInt(member.groupTelegramId), parseInt(member.userTelegramId));
      } catch (err) {
        console.error(`[CRON] Failed to kick ${member.userTelegramId}:`, err);
      }

      await query(`UPDATE members SET status = 'KICKED', last_checked = now(), updated_at = now() WHERE id = $1`, [member.memberId]);
      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [member.groupId, member.userId, "USER_KICKED", JSON.stringify({ reason: "NFT no longer held" })],
      );

      kickedCount++;
    }
  }

  console.log(`[CRON] Re-check done. Checked: ${checkedCount}, Kicked: ${kickedCount}`);
}

async function kickExpiredPendingMembers(bot: Bot) {
  const result = await query(
    `SELECT m.id, m.group_id, g.telegram_id AS group_telegram_id,
            m.user_id, u.telegram_id AS user_telegram_id
     FROM members m
     JOIN groups g ON g.id = m.group_id
     JOIN users u ON u.id = m.user_id
     WHERE m.status = 'PENDING' AND m.created_at < now() - interval '24 hours'`,
  );

  for (const row of result.rows) {
    try {
      await bot.api.banChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id));
      await bot.api.unbanChatMember(parseInt(row.group_telegram_id), parseInt(row.user_telegram_id));
    } catch (err) {
      console.error(`[CRON] Failed to kick expired member:`, err);
    }

    await query(`UPDATE members SET status = 'KICKED', updated_at = now() WHERE id = $1`, [row.id]);
    await query(
      `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
      [row.group_id, row.user_id, "USER_KICKED", JSON.stringify({ reason: "Verification timeout (24h)" })],
    );

    console.log(`[CRON] Kicked expired: ${row.user_telegram_id} from ${row.group_telegram_id}`);
  }
}
```

## 4.8 Bot Entry Point

Create `src/bot/index.ts`:

```typescript
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import { Bot, GrammyError, HttpError } from "grammy";
import { pool } from "../shared/db.js";
import { verifyCommand } from "./commands/verify.js";
import { unlinkCommand } from "./commands/unlink.js";
import { statusCommand } from "./commands/status.js";
import { registerSetupCommands } from "./commands/setup.js";
import { handleNewMembers } from "./handlers/new-member.js";
import { startCronJobs } from "./cron.js";

const bot = new Bot(process.env.BOT_TOKEN!);

bot.command("start", async (ctx) => {
  await ctx.reply(
    [
      "Welcome! I gate Telegram groups based on Enjin NFT ownership.",
      "",
      "Commands:",
      "/verify — Link your Enjin wallet (QR code)",
      "/unlink — Remove linked wallet",
      "/status — Check your verification status",
      "/setup — (Admins only) Configure NFT rules",
    ].join("\n"),
  );
});

bot.command("verify", verifyCommand);
bot.command("unlink", unlinkCommand);
bot.command("status", statusCommand);
registerSetupCommands(bot);
bot.on(":new_chat_members", handleNewMembers);

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(`[BOT] Error handling update ${ctx.update.update_id}:`);
  const e = err.error;
  if (e instanceof GrammyError) console.error("[BOT] Grammy error:", e.description);
  else if (e instanceof HttpError) console.error("[BOT] HTTP error:", e);
  else console.error("[BOT] Unknown error:", e);
});

// Graceful shutdown
function shutdown() {
  console.log("[BOT] Shutting down...");
  bot.stop();
  pool.end().then(() => {
    console.log("[BOT] Stopped.");
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

async function main() {
  console.log("[BOT] Starting...");
  startCronJobs(bot);
  await bot.start({
    onStart: () => console.log("[BOT] Running! Listening for messages..."),
    allowed_updates: ["message", "chat_member", "callback_query"],
  });
}

main().catch((err) => {
  console.error("[BOT] Fatal error:", err);
  process.exit(1);
});
```

## 4.9 Test the Bot

```bash
npm run dev:bot
```

Expected output:

```
[CRON] Jobs scheduled: re-check (*/10min), kick-expired (hourly)
[BOT] Starting...
[BOT] Running! Listening for messages...
```

Test in Telegram:
1. DM your bot → send `/start` → should get the welcome message
2. Send `/verify` → should get a QR code
3. Create a test group → add the bot → make the bot admin
4. In the group send `/setup` → should show setup commands
5. Send `/addrule 12345` → should confirm the rule was added
6. Send `/rules` → should show the rule

Press `Ctrl+C` to stop.

## 4.10 Commit

```bash
git add .
git commit -m "feat: implement telegram bot with verify, setup, and cron jobs"
```

---

# PHASE 5 — DASHBOARD

## 5.1 Dashboard Auth (Telegram Login)

Create `src/dashboard/auth.ts`:

```typescript
import crypto from "crypto";
import { query } from "../shared/db.js";

interface TelegramLoginData {
  id: string;
  first_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: string;
  hash: string;
}

export function verifyTelegramLogin(data: TelegramLoginData): boolean {
  const { hash, ...rest } = data;

  const secret = crypto
    .createHash("sha256")
    .update(process.env.BOT_TOKEN!)
    .digest();

  const checkString = Object.keys(rest)
    .sort()
    .filter((key) => rest[key as keyof typeof rest])
    .map((key) => `${key}=${rest[key as keyof typeof rest]}`)
    .join("\n");

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(checkString)
    .digest("hex");

  if (hmac !== hash) return false;

  const authDate = parseInt(data.auth_date);
  if (Date.now() / 1000 - authDate > 86400) return false;

  return true;
}

export async function upsertTelegramUser(data: TelegramLoginData) {
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       username = COALESCE($2, users.username),
       first_name = COALESCE($3, users.first_name),
       updated_at = now()
     RETURNING *`,
    [data.id, data.username || null, data.first_name || null],
  );
  return result.rows[0];
}
```

## 5.2 Dashboard Routes — Auth

Create `src/dashboard/routes/auth.ts`:

```typescript
import { Router, Request, Response } from "express";
import { verifyTelegramLogin, upsertTelegramUser } from "../auth.js";
import { query } from "../../shared/db.js";

const router = Router();

router.get("/telegram/callback", async (req: Request, res: Response) => {
  const data = req.query as any;

  if (!data.id || !data.hash) {
    res.status(400).send("Missing Telegram auth data");
    return;
  }

  if (!verifyTelegramLogin(data)) {
    res.status(401).send("Invalid Telegram login");
    return;
  }

  const user = await upsertTelegramUser(data);

  req.session.user = {
    id: user.id,
    telegramId: user.telegram_id,
    firstName: user.first_name,
    username: user.username,
  };

  res.redirect("/dashboard");
});

// Dev-only bypass
router.get("/dev", async (req: Request, res: Response) => {
  if (process.env.NODE_ENV === "production") {
    res.status(404).send("Not found");
    return;
  }

  const telegramId = req.query.telegramId as string;
  if (!telegramId) {
    res.status(400).send("Missing telegramId parameter");
    return;
  }

  const result = await query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);

  if (result.rows.length === 0) {
    res.status(404).send("User not found. Interact with the bot first.");
    return;
  }

  const user = result.rows[0];

  req.session.user = {
    id: user.id,
    telegramId: user.telegram_id,
    firstName: user.first_name,
    username: user.username,
  };

  res.redirect("/dashboard");
});

router.get("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

export default router;
```

## 5.3 Dashboard Routes — Main

Create `src/dashboard/routes/dashboard.ts`:

```typescript
import { Router, Request, Response } from "express";
import { query } from "../../shared/db.js";
import { checkNftOwnership } from "../../shared/enjin.js";

const router = Router();

// Require login
router.use((req: Request, res: Response, next) => {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  next();
});

// Groups list
router.get("/", async (req: Request, res: Response) => {
  const user = req.session.user!;

  const result = await query(
    `SELECT g.*,
       (SELECT COUNT(*) FROM members m WHERE m.group_id = g.id AND m.status = 'VERIFIED') AS verified_count,
       (SELECT COUNT(*) FROM nft_rules r WHERE r.group_id = g.id AND r.is_active = true) AS rule_count
     FROM groups g
     JOIN group_admins ga ON ga.group_id = g.id
     JOIN users u ON u.id = ga.user_id
     WHERE u.telegram_id = $1
     ORDER BY g.created_at DESC`,
    [user.telegramId],
  );

  res.render("dashboard", { user, groups: result.rows });
});

// Group detail
router.get("/groups/:id", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.redirect("/dashboard");
    return;
  }

  const groupResult = await query(`SELECT * FROM groups WHERE id = $1`, [groupId]);
  if (groupResult.rows.length === 0) {
    res.status(404).send("Group not found");
    return;
  }

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true ORDER BY created_at`,
    [groupId],
  );

  const members = await query(
    `SELECT m.*, u.telegram_id AS user_telegram_id, u.username, u.first_name, u.wallet_address
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 ORDER BY m.created_at DESC`,
    [groupId],
  );

  res.render("group", { user, group: groupResult.rows[0], rules: rules.rows, members: members.rows });
});

// Manual re-check
router.post("/groups/:id/recheck", async (req: Request, res: Response) => {
  const user = req.session.user!;
  const groupId = req.params.id;

  const adminCheck = await query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  );

  if (adminCheck.rows.length === 0) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const rules = await query(
    `SELECT * FROM nft_rules WHERE group_id = $1 AND is_active = true`,
    [groupId],
  );

  const members = await query(
    `SELECT m.id, u.wallet_address, u.id AS user_id
     FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.group_id = $1 AND m.status = 'VERIFIED'`,
    [groupId],
  );

  let checked = 0;
  let kicked = 0;

  for (const member of members.rows) {
    if (!member.wallet_address) continue;
    checked++;

    let stillHolds = false;
    for (const rule of rules.rows) {
      if (await checkNftOwnership(member.wallet_address, rule.collection_id, rule.token_id, rule.min_balance)) {
        stillHolds = true;
        break;
      }
    }

    if (!stillHolds) {
      await query(`UPDATE members SET status = 'KICKED', last_checked = now(), updated_at = now() WHERE id = $1`, [member.id]);
      await query(
        `INSERT INTO audit_logs (group_id, user_id, action, details) VALUES ($1, $2, $3, $4)`,
        [groupId, member.user_id, "USER_KICKED_MANUAL", JSON.stringify({ triggeredBy: user.telegramId })],
      );
      kicked++;
    } else {
      await query(`UPDATE members SET last_checked = now(), updated_at = now() WHERE id = $1`, [member.id]);
    }
  }

  res.json({ checked, kicked });
});

// Audit logs
router.get("/audit", async (req: Request, res: Response) => {
  const user = req.session.user!;

  const logs = await query(
    `SELECT al.*, g.title AS group_title,
            u.first_name AS user_first_name, u.username AS user_username
     FROM audit_logs al
     JOIN groups g ON g.id = al.group_id
     LEFT JOIN users u ON u.id = al.user_id
     WHERE al.group_id IN (
       SELECT ga.group_id FROM group_admins ga
       JOIN users u2 ON u2.id = ga.user_id
       WHERE u2.telegram_id = $1
     )
     ORDER BY al.created_at DESC LIMIT 200`,
    [user.telegramId],
  );

  res.render("audit", { user, logs: logs.rows });
});

export default router;
```

## 5.4 Session Type Augmentation

Create `src/types.ts`:

```typescript
import "express-session";

declare module "express-session" {
  interface SessionData {
    user: {
      id: string;
      telegramId: string;
      firstName: string | null;
      username: string | null;
    };
  }
}
```

## 5.5 Express Server

Create `src/dashboard/server.ts`:

```typescript
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import "../types.js";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../shared/db.js";
import authRoutes from "./routes/auth.js";
import dashboardRoutes from "./routes/dashboard.js";

const app = express();
const PgStore = connectPgSimple(session);

app.set("view engine", "ejs");
app.set("views", path.resolve(import.meta.dirname, "../../views"));

app.use(express.static(path.resolve(import.meta.dirname, "../../public")));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgStore({ pool, tableName: "session" }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: "lax",
    },
  }),
);

// Login page
app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.render("login", { botUsername: process.env.BOT_USERNAME });
});

// Root redirect
app.get("/", (req, res) => res.redirect("/dashboard"));

// Routes
app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);

// Start
const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DASHBOARD] Running at http://localhost:${PORT}`);
});

// Graceful shutdown
function shutdown() {
  console.log("[DASHBOARD] Shutting down...");
  server.close(() => {
    pool.end().then(() => {
      console.log("[DASHBOARD] Stopped.");
      process.exit(0);
    });
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
```

## 5.6 EJS Templates

Create `views/partials/head.ejs`:

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title><%= typeof title !== 'undefined' ? title : 'NFT Gate' %></title>
  <link rel="stylesheet" href="/css/output.css">
</head>
<body class="bg-gray-50 min-h-screen">
```

Create `views/partials/nav.ejs`:

```html
<nav class="bg-white border-b">
  <div class="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
    <div class="flex items-center gap-6">
      <a href="/dashboard" class="text-lg font-bold text-gray-900">NFT Gate</a>
      <a href="/dashboard" class="text-sm text-gray-600 hover:text-gray-900">Groups</a>
      <a href="/dashboard/audit" class="text-sm text-gray-600 hover:text-gray-900">Audit Logs</a>
    </div>
    <div class="flex items-center gap-4">
      <span class="text-sm text-gray-500"><%= user.firstName || user.username %></span>
      <a href="/auth/logout" class="text-sm text-red-600 hover:underline">Sign Out</a>
    </div>
  </div>
</nav>
```

Create `views/partials/footer.ejs`:

```html
</body>
</html>
```

Create `views/login.ejs`:

```html
<%- include('partials/head', { title: 'Login — NFT Gate' }) %>

<div class="flex items-center justify-center min-h-screen">
  <div class="bg-white rounded-lg shadow-md p-8 w-full max-w-sm text-center">
    <h1 class="text-xl font-bold mb-2">NFT Gate Admin</h1>
    <p class="text-sm text-gray-500 mb-6">Sign in with your Telegram account to manage your groups.</p>

    <div id="telegram-login" class="flex justify-center mb-4"></div>

    <% if (process.env.NODE_ENV !== 'production') { %>
      <hr class="my-4">
      <p class="text-xs text-gray-400 mb-2">Dev Login (development only)</p>
      <form action="/auth/dev" method="get" class="flex gap-2">
        <input type="text" name="telegramId" placeholder="Telegram ID"
               class="flex-1 border rounded px-3 py-2 text-sm">
        <button type="submit"
                class="bg-gray-800 text-white px-4 py-2 rounded text-sm hover:bg-gray-700">
          Login
        </button>
      </form>
    <% } %>
  </div>
</div>

<script>
  const script = document.createElement('script');
  script.src = 'https://telegram.org/js/telegram-widget.js?22';
  script.setAttribute('data-telegram-login', '<%= botUsername %>');
  script.setAttribute('data-size', 'large');
  script.setAttribute('data-auth-url', window.location.origin + '/auth/telegram/callback');
  script.setAttribute('data-request-access', 'write');
  script.async = true;
  document.getElementById('telegram-login').appendChild(script);
</script>

<%- include('partials/footer') %>
```

Create `views/dashboard.ejs`:

```html
<%- include('partials/head', { title: 'Dashboard — NFT Gate' }) %>
<%- include('partials/nav') %>

<div class="max-w-6xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold mb-6">Your Groups</h1>

  <% if (groups.length === 0) { %>
    <div class="bg-white rounded-lg shadow p-6 text-gray-500">
      No groups found. Add the bot to a Telegram group and use /addrule to get started.
    </div>
  <% } else { %>
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      <% groups.forEach(group => { %>
        <a href="/dashboard/groups/<%= group.id %>" class="block">
          <div class="bg-white rounded-lg shadow p-5 hover:shadow-md transition-shadow">
            <h2 class="font-semibold text-lg mb-3"><%= group.title %></h2>
            <div class="flex gap-2 flex-wrap">
              <span class="bg-blue-100 text-blue-800 text-xs px-2 py-1 rounded-full">
                <%= group.verified_count %> verified
              </span>
              <span class="bg-gray-100 text-gray-700 text-xs px-2 py-1 rounded-full">
                <%= group.rule_count %> rules
              </span>
              <span class="<%= group.is_active ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800' %> text-xs px-2 py-1 rounded-full">
                <%= group.is_active ? 'Active' : 'Inactive' %>
              </span>
            </div>
          </div>
        </a>
      <% }) %>
    </div>
  <% } %>
</div>

<%- include('partials/footer') %>
```

Create `views/group.ejs`:

```html
<%- include('partials/head', { title: group.title + ' — NFT Gate' }) %>
<%- include('partials/nav') %>

<div class="max-w-6xl mx-auto px-4 py-8">
  <div class="flex items-center justify-between mb-6">
    <div>
      <a href="/dashboard" class="text-sm text-gray-500 hover:underline">&larr; Back to Groups</a>
      <h1 class="text-2xl font-bold mt-1"><%= group.title %></h1>
      <p class="text-sm text-gray-500">Telegram ID: <%= group.telegram_id %></p>
    </div>
    <div class="flex items-center gap-3">
      <span id="recheck-result" class="text-sm text-gray-500"></span>
      <button onclick="recheckAll()" id="recheck-btn"
              class="bg-gray-800 text-white px-4 py-2 rounded text-sm hover:bg-gray-700">
        Re-check NFTs
      </button>
    </div>
  </div>

  <div class="grid gap-4 md:grid-cols-3 mb-8">
    <div class="bg-white rounded-lg shadow p-5">
      <p class="text-sm text-gray-500">Verified Members</p>
      <p class="text-2xl font-bold"><%= members.filter(m => m.status === 'VERIFIED').length %></p>
    </div>
    <div class="bg-white rounded-lg shadow p-5">
      <p class="text-sm text-gray-500">Pending Members</p>
      <p class="text-2xl font-bold"><%= members.filter(m => m.status === 'PENDING').length %></p>
    </div>
    <div class="bg-white rounded-lg shadow p-5">
      <p class="text-sm text-gray-500">Active Rules</p>
      <p class="text-2xl font-bold"><%= rules.length %></p>
    </div>
  </div>

  <div class="bg-white rounded-lg shadow mb-8">
    <div class="px-5 py-4 border-b"><h2 class="font-semibold">NFT Rules</h2></div>
    <% if (rules.length === 0) { %>
      <p class="p-5 text-gray-500">No rules configured. Use /addrule in the Telegram group.</p>
    <% } else { %>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left">
              <th class="px-5 py-3 font-medium">Collection ID</th>
              <th class="px-5 py-3 font-medium">Token ID</th>
              <th class="px-5 py-3 font-medium">Min Balance</th>
              <th class="px-5 py-3 font-medium">Check Interval</th>
            </tr>
          </thead>
          <tbody>
            <% rules.forEach(rule => { %>
              <tr class="border-b">
                <td class="px-5 py-3 font-mono text-xs"><%= rule.collection_id %></td>
                <td class="px-5 py-3"><%= rule.token_id || 'Any' %></td>
                <td class="px-5 py-3"><%= rule.min_balance %></td>
                <td class="px-5 py-3"><%= rule.check_interval %>s</td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    <% } %>
  </div>

  <div class="bg-white rounded-lg shadow">
    <div class="px-5 py-4 border-b"><h2 class="font-semibold">Members (<%= members.length %>)</h2></div>
    <% if (members.length === 0) { %>
      <p class="p-5 text-gray-500">No members yet.</p>
    <% } else { %>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left">
              <th class="px-5 py-3 font-medium">User</th>
              <th class="px-5 py-3 font-medium">Wallet</th>
              <th class="px-5 py-3 font-medium">Status</th>
              <th class="px-5 py-3 font-medium">Last Checked</th>
              <th class="px-5 py-3 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            <% const statusColors = { VERIFIED: 'bg-green-100 text-green-800', PENDING: 'bg-yellow-100 text-yellow-800', KICKED: 'bg-red-100 text-red-800', LEFT: 'bg-gray-100 text-gray-700' }; %>
            <% members.forEach(member => { %>
              <tr class="border-b">
                <td class="px-5 py-3">
                  <p class="font-medium"><%= member.first_name || member.username || 'Unknown' %></p>
                  <% if (member.username) { %><p class="text-xs text-gray-500">@<%= member.username %></p><% } %>
                </td>
                <td class="px-5 py-3 font-mono text-xs"><%= member.wallet_address || 'Not linked' %></td>
                <td class="px-5 py-3">
                  <span class="<%= statusColors[member.status] || 'bg-gray-100 text-gray-700' %> text-xs px-2 py-1 rounded-full">
                    <%= member.status %>
                  </span>
                </td>
                <td class="px-5 py-3 text-gray-500"><%= member.last_checked ? new Date(member.last_checked).toLocaleString() : 'Never' %></td>
                <td class="px-5 py-3 text-gray-500"><%= new Date(member.created_at).toLocaleString() %></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    <% } %>
  </div>
</div>

<script>
async function recheckAll() {
  const btn = document.getElementById('recheck-btn');
  const result = document.getElementById('recheck-result');
  btn.disabled = true;
  btn.textContent = 'Checking...';
  result.textContent = '';
  try {
    const res = await fetch('/dashboard/groups/<%= group.id %>/recheck', { method: 'POST' });
    const data = await res.json();
    if (res.ok) {
      result.textContent = 'Checked ' + data.checked + ', kicked ' + data.kicked + '.';
      setTimeout(() => location.reload(), 2000);
    } else {
      result.textContent = data.error || 'Re-check failed';
    }
  } catch {
    result.textContent = 'Network error';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-check NFTs';
  }
}
</script>

<%- include('partials/footer') %>
```

Create `views/audit.ejs`:

```html
<%- include('partials/head', { title: 'Audit Logs — NFT Gate' }) %>
<%- include('partials/nav') %>

<div class="max-w-6xl mx-auto px-4 py-8">
  <h1 class="text-2xl font-bold mb-6">Audit Logs</h1>

  <div class="bg-white rounded-lg shadow">
    <% if (logs.length === 0) { %>
      <p class="p-6 text-gray-500">No audit logs yet.</p>
    <% } else { %>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b text-left">
              <th class="px-5 py-3 font-medium">Time</th>
              <th class="px-5 py-3 font-medium">Group</th>
              <th class="px-5 py-3 font-medium">Action</th>
              <th class="px-5 py-3 font-medium">User</th>
              <th class="px-5 py-3 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            <% const actionColors = { USER_VERIFIED: 'bg-green-100 text-green-800', USER_AUTO_VERIFIED: 'bg-green-100 text-green-800', USER_KICKED: 'bg-red-100 text-red-800', USER_KICKED_MANUAL: 'bg-red-100 text-red-800', RULE_ADDED: 'bg-blue-100 text-blue-800', RULE_REMOVED: 'bg-gray-100 text-gray-700' }; %>
            <% logs.forEach(log => { %>
              <tr class="border-b">
                <td class="px-5 py-3 text-gray-500 whitespace-nowrap"><%= new Date(log.created_at).toLocaleString() %></td>
                <td class="px-5 py-3 font-medium"><%= log.group_title %></td>
                <td class="px-5 py-3">
                  <span class="<%= actionColors[log.action] || 'bg-gray-100 text-gray-700' %> text-xs px-2 py-1 rounded-full">
                    <%= log.action %>
                  </span>
                </td>
                <td class="px-5 py-3"><%= log.user_first_name || log.user_username || 'System' %></td>
                <td class="px-5 py-3 text-xs text-gray-500 max-w-xs truncate"><%= log.details ? JSON.stringify(log.details) : '—' %></td>
              </tr>
            <% }) %>
          </tbody>
        </table>
      </div>
    <% } %>
  </div>
</div>

<%- include('partials/footer') %>
```

## 5.7 Test the Dashboard

Build the CSS first:

```bash
npm run css:build
```

Then start the dashboard:

```bash
npm run dev:dashboard
```

Open `http://localhost:3000` in your browser.
- You should see the login page
- Use the Dev Login (enter a Telegram ID of a user that's interacted with the bot)
- After logging in, you should see your groups

## 5.8 Commit

```bash
git add .
git commit -m "feat: implement dashboard with express, ejs, and tailwind"
```

---

# PHASE 6 — LOCAL TESTING (FULL FLOW)

## 6.1 Run All Services

```bash
npm run dev
```

This starts the bot, dashboard, and CSS watcher in a single terminal using `concurrently`.

## 6.2 End-to-End Test Checklist

### Bot commands

| Step | Action | Expected Result |
|------|--------|-----------------|
| 1 | DM the bot: `/start` | Welcome message with command list |
| 2 | DM: `/status` | "You haven't started verification yet" |
| 3 | DM: `/verify` | QR code image sent |
| 4 | Scan QR with Enjin Wallet | Wallet linked, confirmation message |
| 5 | DM: `/status` | Shows linked wallet |
| 6 | DM: `/unlink` | Wallet removed |

### Group setup

| Step | Action | Expected Result |
|------|--------|-----------------|
| 7 | Create a Telegram group | Group created |
| 8 | Add bot + make it admin | Bot joins |
| 9 | In group: `/setup` | Bot shows setup commands |
| 10 | `/addrule 12345` | Rule added |
| 11 | `/rules` | Shows rule |
| 12 | `/removerule 1` | Rule removed |

### Dashboard

| Step | Action | Expected Result |
|------|--------|-----------------|
| 13 | Open `http://localhost:3000` | Login page |
| 14 | Dev login with your Telegram ID | Redirected to dashboard |
| 15 | See your group | Group card with counts |
| 16 | Click group | Detail page with rules and members |
| 17 | Click "Re-check NFTs" | Shows result |
| 18 | Click "Audit Logs" | Log entries |

### Verify the database

```bash
psql -h db -U postgres -d tgbot_dev
```

Check that `groups`, `users`, `nft_rules`, `group_admins`, `members`, and `audit_logs` have data.

## 6.3 Commit

```bash
git add .
git commit -m "chore: complete local testing"
```

---

# PHASE 7 — DEPLOYMENT (VPS)

## 7.1 Provision a Server

- DigitalOcean Droplet (Ubuntu 24.04, $6/mo) or Hetzner CX22 ($4/mo)
- Minimum: 1 vCPU, 1GB RAM, 25GB disk

## 7.2 Initial Server Setup

```bash
ssh root@YOUR_SERVER_IP

adduser deploy
usermod -aG sudo deploy

ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw enable

su - deploy
```

## 7.3 Install Dependencies

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx certbot python3-certbot-nginx
sudo npm install -g pm2 typescript
```

## 7.4 Create Production Database

In the Neon dashboard:

1. Go to your `tgbot` project → **Branches**
2. Create a new branch called `production` (this gives you a separate database from development)
3. Copy the connection string for the `production` branch

> Alternatively, create a separate Neon project for production. Either way, you get a dedicated connection string.

## 7.5 Clone and Build

```bash
cd /home/deploy
git clone https://github.com/YOUR_USERNAME/tgbot.git
cd tgbot

cat > .env << 'EOF'
DATABASE_URL="PASTE_YOUR_NEON_PRODUCTION_CONNECTION_STRING_HERE"
BOT_TOKEN="your_bot_token"
ENJIN_API_URL="https://platform.enjin.io/graphql"
ENJIN_API_TOKEN="your_enjin_token"
SESSION_SECRET="your_generated_secret"
DASHBOARD_URL="https://yourdomain.com"
BOT_USERNAME="your_bot_username"
NODE_ENV="production"
EOF

npm install
npm run build
npm run css:build
npm run db:migrate
```

## 7.6 Start with PM2

```bash
pm2 start dist/bot/index.js --name "tgbot-bot"
pm2 start dist/dashboard/server.js --name "tgbot-dashboard"
pm2 save
pm2 startup
```

## 7.7 Configure Nginx

```bash
sudo nano /etc/nginx/sites-available/tgbot
```

```nginx
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tgbot /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

## 7.8 SSL Certificate

```bash
sudo certbot --nginx -d yourdomain.com
```

## 7.9 Update BotFather Domain

```
/setdomain → select your bot → yourdomain.com
```

---

## Post-Deployment Checklist

```
[ ] Bot responds to /start
[ ] /verify sends QR code and links wallet
[ ] /unlink removes wallet
[ ] /setup, /addrule, /rules work
[ ] New members get welcome message
[ ] Cron re-checks run (pm2 logs)
[ ] Dashboard loads with HTTPS
[ ] Telegram login widget works
[ ] Groups list shows admin's groups
[ ] Group detail shows rules and members
[ ] Re-check button works
[ ] Audit logs show all actions
```

---

## Useful Commands

```bash
# Development
npm run dev:bot              # Start bot (watch mode)
npm run dev:dashboard        # Start dashboard (watch mode)
npm run css:watch            # Watch Tailwind changes
npm run css:build            # Build Tailwind CSS
npm run db:migrate           # Run SQL migration

# Production
pm2 status                   # Check processes
pm2 logs                     # View all logs
pm2 logs tgbot-bot           # Bot logs only
pm2 restart all              # Restart everything

# Database (Neon)
npm run db:migrate           # Run SQL migration against Neon
```
