import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import { validateEnv } from "../shared/env.js";
validateEnv();

import helmet from "helmet";
import "../types.js";
import crypto from "crypto";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../shared/db.js";
import authRoutes from "./routes/auth.js";
import groupsRoutes from "./routes/groups.js";
import auditRoutes from "./routes/audit.js";

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
        scriptSrc: ["'self'", "'unsafe-inline'", "https://telegram.org"],
        scriptSrcAttr: ["'unsafe-inline'"],
        frameSrc: ["'self'", "https://oauth.telegram.org"],
        imgSrc: ["'self'", "data:"],
      },
    },
  }),
);
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

// CSRF protection
app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (req.method === "POST") {
    const token = req.body._csrf || req.headers["x-csrf-token"];
    if (token !== req.session.csrfToken) {
      res.status(403).send("Invalid CSRF token");
      return;
    }
  }
  next();
});

// Login page
app.get("/login", (req, res) => {
  if (req.session.user) {
    res.redirect("/dashboard");
    return;
  }
  res.render("login", { botUsername: process.env.BOT_USERNAME, isDev: process.env.NODE_ENV !== "production" });
});

// Root redirect
app.get("/", (req, res) => res.redirect("/dashboard"));

// Routes
app.use("/auth", authRoutes);
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