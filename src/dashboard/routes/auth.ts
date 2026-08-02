import { Router, Request, Response } from "express";
import { verifyTelegramLogin, upsertTelegramUser } from "../telegram-auth.js";
import { query } from "../../shared/db.js";
import { authLimiter } from "../rate-limits.js";

const router = Router();

// POST (not GET) so the signed auth blob rides in the request body, never a URL
// — a GET callback leaked id/hash/auth_date into nginx logs, history, and
// Referer, where it was replayable within the freshness window. The login page
// fetch()es this and navigates on the 204; the global CSRF middleware guards
// the POST (the page echoes the token in X-CSRF-Token).
router.post("/telegram/callback", authLimiter, async (req: Request, res: Response) => {
  // Accept only JSON scalars, and normalize to string. The widget sends id and
  // auth_date as *numbers*, so a strings-only guard here rejected every real
  // login; anything non-scalar still has to go, because a JSON array like
  // ["123"] stringifies identically in the HMAC check-string but would reach
  // the DB as a Postgres array literal. Safe-integer only, so a number always
  // round-trips to the digits Telegram signed (1e21 would become "1e+21").
  const body = (req.body ?? {}) as Record<string, unknown>;
  const str = (v: unknown) =>
    typeof v === "string"
      ? v
      : typeof v === "number" && Number.isSafeInteger(v)
        ? String(v)
        : undefined;
  const id = str(body.id);
  const first_name = str(body.first_name);
  const last_name = str(body.last_name);
  const username = str(body.username);
  const photo_url = str(body.photo_url);
  const auth_date = str(body.auth_date);
  const hash = str(body.hash);

  if (!id || !hash || !auth_date) {
    res.status(400).send("Missing Telegram auth data");
    return;
  }

  // The widget includes last_name in the HMAC check-string whenever the user
  // has one — forward it even though it isn't persisted.
  const data = { id, first_name, last_name, username, photo_url, auth_date, hash };

  if (!verifyTelegramLogin(data)) {
    res.status(401).send("Invalid Telegram login");
    return;
  }

  const user = await upsertTelegramUser(data);

  // Regenerate the session id on the anonymous → authenticated transition.
  // Without this, a session id planted in the victim's browser before login
  // (session fixation) would get silently upgraded to their identity, leaving
  // the attacker's copy of the cookie authenticated too.
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );

  req.session.user = {
    id: user.id,
    telegramId: user.telegram_id,
    firstName: user.first_name,
    username: user.username,
  };

  // 204, not a redirect: the caller is a fetch(), which would follow a 302 as a
  // fetch (pulling /dashboard's HTML into the response) rather than navigating.
  // The client navigates to /dashboard on this 204.
  res.status(204).end();
});

// Dev-only bypass — requires BOTH an explicit ENABLE_DEV_LOGIN=true opt-in and
// a non-production NODE_ENV. Default is off: an operator who configures nothing
// never exposes a passwordless impersonation endpoint, and even a stray
// ENABLE_DEV_LOGIN in a production .env stays inert.
router.get("/dev", async (req: Request, res: Response) => {
  const devLoginEnabled =
    process.env.ENABLE_DEV_LOGIN === "true" && process.env.NODE_ENV !== "production";
  if (!devLoginEnabled) {
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

  // Same fixation defense as the real login above — the dev login creates an
  // authenticated session too, so it regenerates the id the same way.
  await new Promise<void>((resolve, reject) =>
    req.session.regenerate((err) => (err ? reject(err) : resolve())),
  );

  req.session.user = {
    id: user.id,
    telegramId: user.telegram_id,
    firstName: user.first_name,
    username: user.username,
  };

  res.redirect("/dashboard");
});

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

export default router;