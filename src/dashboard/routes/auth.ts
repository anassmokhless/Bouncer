import { Router, Request, Response } from "express";
import { verifyTelegramLogin, upsertTelegramUser } from "../telegram-auth.js";
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