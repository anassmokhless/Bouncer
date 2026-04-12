import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(import.meta.dirname, "../../.env") });

import "../types.js";
import express from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { pool } from "../shared/db.js";
import authRoutes from "./routes/auth.js";
import groupsRoutes from "./routes/groups.js";
import auditRoutes from "./routes/audit.js";

const app = express();
const PgStore = connectPgSimple(session);

app.set("trust proxy", 1);
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
app.use("/dashboard/audit", auditRoutes);
app.use("/dashboard", groupsRoutes);

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