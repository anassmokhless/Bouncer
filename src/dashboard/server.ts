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
import authRoutes from "./routes/auth.js";
import groupsRoutes from "./routes/groups.js";
import auditRoutes from "./routes/audit.js";
import contactRoutes from "./routes/contact.js";

const app = express();
const PgStore = connectPgSimple(session);

// Trust proxy — env-configurable so multi-hop deployments (e.g. Cloudflare → nginx → app)
// can set TRUST_PROXY=2. Defaults to 1 (single reverse-proxy hop), which matches the
// documented nginx setup. Numeric strings are parsed as hop counts; non-numeric values
// pass through so Express keywords like "loopback" or "uniquelocal" still work.
const trustProxyRaw = process.env.TRUST_PROXY ?? "1";
const trustProxyNum = Number(trustProxyRaw);
app.set("trust proxy", Number.isFinite(trustProxyNum) && trustProxyRaw.trim() !== "" ? trustProxyNum : trustProxyRaw);
app.set("view engine", "ejs");
app.set("views", path.resolve(import.meta.dirname, "../../views"));

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // 'unsafe-eval' is required for the Telegram Login Widget's data-onauth
        // mechanism: the widget compiles the onauth attribute string into a
        // Function() to invoke with the auth blob. Without it, the widget
        // fails to render at all.
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://telegram.org"],
        scriptSrcAttr: ["'unsafe-inline'"],
        frameSrc: ["'self'", "https://oauth.telegram.org"],
        imgSrc: ["'self'", "data:"],
      },
    },
    // Helmet's default COOP is "same-origin", which breaks cross-origin popup
    // postMessage — specifically, the Telegram Login Widget's popup on
    // oauth.telegram.org can't send auth data back to the parent window here.
    // "same-origin-allow-popups" keeps opener isolation for non-popup pages but
    // allows popups we open to communicate back. Required for the widget.
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

// CSRF protection via the double-submit cookie pattern. The token is stored in
// a dedicated cookie (NOT the session) and mirrored in form bodies / X-CSRF-Token
// headers. On POST we just verify the two match. A cross-origin attacker can't
// read our cookie from their page, so they can't forge a request whose body
// token matches our cookie — that's what makes it CSRF-safe.
//
// Why not store it on req.session like before? Anonymous visitors (including
// bot scanners) would trigger session row creation just by loading a page,
// polluting the `session` table with empty rows. Moving CSRF out of the session
// means sessions are only ever created for users who actually log in.
const CSRF_COOKIE_NAME = "csrf-token";

app.use((req, res, next) => {
  let token = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;

  // First request without a token — mint one and set it as a cookie.
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    res.cookie(CSRF_COOKIE_NAME, token, {
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true, // tokens flow via server-rendered form field / header, not JS
    });
  }

  // Expose to EJS templates under the same name so existing `<%= csrfToken %>`
  // usages keep working unchanged.
  res.locals.csrfToken = token;

  if (req.method === "POST") {
    const submitted = req.body?._csrf || req.headers["x-csrf-token"];
    if (submitted !== token) {
      res.status(403).send("Invalid CSRF token");
      return;
    }
  }
  next();
});

// Login page. Telegram widget uses data-onauth (JS callback) instead of
// data-auth-url — the widget calls a JS function with the auth blob, which
// we then redirect to /auth/telegram/callback with the params in the query
// string. Avoids the popup-redirect quirk that was causing 499s in nginx.
app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.render("login", {
    botUsername: process.env.BOT_USERNAME,
    isDev: process.env.NODE_ENV !== "production",
  });
});

// Landing page
app.get("/", (req, res) => {
  res.render("landing", { botUsername: process.env.BOT_USERNAME });
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