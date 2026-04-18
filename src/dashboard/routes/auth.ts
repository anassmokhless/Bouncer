import { Router, Request, Response } from "express";
import { verifyTelegramLogin, upsertTelegramUser } from "../telegram-auth.js";
import { query } from "../../shared/db.js";

const router = Router();

router.get("/telegram/callback", async (req: Request, res: Response) => {
  const { id, first_name, last_name, username, photo_url, auth_date, hash } = req.query as Record<string, string>;

  if (!id || !hash) {
    res.status(400).send("Missing Telegram auth data");
    return;
  }

  // last_name must be forwarded into verifyTelegramLogin even though we don't
  // persist it — the widget includes it in the HMAC check-string whenever the
  // user has one on their Telegram profile. Dropping it here is what caused
  // the "Invalid Telegram login" bug for every user with a last name.
  const data = { id, first_name, last_name, username, photo_url, auth_date, hash };

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

router.post("/logout", (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

export default router;