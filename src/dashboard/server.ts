import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import { validateEnv } from "../shared/env.js";
validateEnv();

import helmet from "helmet";
import "../types.js";
import crypto from "crypto";
import express from "express";
import cookieParser from "cookie-parser";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../shared/db.js";
import { query } from "../shared/db.js";
import authRoutes from "./routes/auth.js";
import groupsRoutes from "./routes/groups.js";
import auditRoutes from "./routes/audit.js";
import contactRoutes from "./routes/contact.js";
import { publicLimiter, readLimiter } from "./rate-limits.js";

const app = express();
const PgStore = connectPgSimple(session);

// Reverse-proxy hop count (default 1). A number sets hop count; a non-numeric
// value passes through so Express keywords like "loopback" still work.
const trustProxyRaw = process.env.TRUST_PROXY ?? "1";
const trustProxyNum = Number(trustProxyRaw);
app.set("trust proxy", Number.isFinite(trustProxyNum) && trustProxyRaw.trim() !== "" ? trustProxyNum : trustProxyRaw);
app.set("view engine", "ejs");
app.set("views", path.resolve(import.meta.dirname, "../../views"));

// Per-request CSP nonce, set before helmet (its script-src reads it) and exposed
// on res.locals for <script nonce="...">. Lets script-src drop 'unsafe-inline'.
app.use((_req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // No 'unsafe-inline' — inline scripts use the nonce. 'unsafe-eval' stays:
        // the Telegram Login Widget compiles data-onauth via Function().
        scriptSrc: [
          "'self'",
          "'unsafe-eval'",
          "https://telegram.org",
          (_req, res) => `'nonce-${(res as express.Response).locals.cspNonce}'`,
        ],
        // No inline event-handler attributes (all moved to addEventListener).
        scriptSrcAttr: ["'none'"],
        frameSrc: ["'self'", "https://oauth.telegram.org"],
        imgSrc: ["'self'", "data:"],
      },
    },
    // Let the Telegram widget's oauth.telegram.org popup postMessage back to us.
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
  }),
);
app.use(express.static(path.resolve(import.meta.dirname, "../../public")));
app.use(cookieParser());
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

// After session so its skip() can read req.session.user.
app.use(publicLimiter);

// CSRF via double-submit cookie: the token lives in its own cookie (not the
// session, so anonymous visits don't create session rows) and must match the
// _csrf field / X-CSRF-Token header on POST.
const CSRF_COOKIE_NAME = "csrf-token";

app.use((req, res, next) => {
  let token = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;

  // Mint one on first request.
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE_NAME, token, {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true, // tokens flow via server-rendered form field / header, not JS
    });
  }

  res.locals.csrfToken = token; // for <%= csrfToken %> in templates

  if (req.method === "POST") {
    const submitted = req.body?._csrf || req.headers["x-csrf-token"];
    if (submitted !== token) {
      res.status(403).send("Invalid CSRF token");
      return;
    }
  }
  next();
});

app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.render("login", {
    botUsername: process.env.BOT_USERNAME,
    // Same guard as the /auth/dev route — only offer the form when it's enabled.
    isDev: process.env.ENABLE_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production",
  });
});

// Landing page. readLimiter covers logged-in visitors, who are exempt from
// publicLimiter. The counts are cached for 60s — the audit_logs COUNT is a
// full scan (no index on action), so per-request queries would let anonymous
// traffic grind the DB.
let landingCounts: { verifiedUsers: number; verifiedGroups: number; membersProcessed: number } | null = null;
let landingCountsExpiry = 0;

app.get("/", readLimiter, async (_req, res, next) => {
  try {
    if (!landingCounts || Date.now() >= landingCountsExpiry) {
      const [usersResult, groupsResult, processedResult] = await Promise.all([
        query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM users
           WHERE is_verified = true AND wallet_address IS NOT NULL`,
        ),
        query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM groups WHERE is_active = true`,
        ),
        query<{ c: number }>(
          `SELECT COUNT(*)::int AS c FROM audit_logs
           WHERE action IN ('USER_VERIFIED', 'USER_AUTO_VERIFIED',
                            'USER_KICKED', 'USER_BANNED', 'USER_KICKED_MANUAL')`,
        ),
      ]);
      landingCounts = {
        verifiedUsers: usersResult.rows[0].c,
        verifiedGroups: groupsResult.rows[0].c,
        membersProcessed: processedResult.rows[0].c,
      };
      landingCountsExpiry = Date.now() + 60_000;
    }
    res.render("landing", {
      botUsername: process.env.BOT_USERNAME,
      ...landingCounts,
    });
  } catch (err) {
    next(err);
  }
});

// Legal page (privacy policy + terms of use)
app.get("/legal", (_req, res) => {
  res.render("legal");
});

// Routes
app.use("/auth", authRoutes);
app.use("/contact", contactRoutes);
app.use("/dashboard/audit", auditRoutes);
app.use("/dashboard", groupsRoutes);

// Global error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[DASHBOARD] Unhandled error:", err);
  res.status(500).send("Something went wrong");
});

// Start
const PORT = parseInt(process.env.PORT || "3000");
const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`[DASHBOARD] Running at http://localhost:${PORT}`);
});

// Graceful shutdown
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) process.exit(0);
  shuttingDown = true;
  console.log("[DASHBOARD] Shutting down...");
  server.close(() => {
    pool.end().then(() => {
      console.log("[DASHBOARD] Stopped.");
      process.exit(0);
    });
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);