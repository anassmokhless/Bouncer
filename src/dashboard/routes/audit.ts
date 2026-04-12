import { Router, Request, Response } from "express";
import { query } from "../../shared/db.js";
import { requireLogin } from "../middleware.js";

const router = Router();
router.use(requireLogin);

router.get("/", async (req: Request, res: Response) => {
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