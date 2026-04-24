import { Router, Request, Response } from "express";
import { query } from "../../shared/db.js";
import { requireLogin } from "../middleware.js";

const router = Router();
router.use(requireLogin);

router.get("/", async (req: Request, res: Response) => {
  const user = req.session.user!;

  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const pageSize = 50;
  const search = ((req.query.search as string) || "").trim();
  const offset = (page - 1) * pageSize;

  const adminGroupFilter = `al.group_id IN (
    SELECT ga.group_id FROM group_admins ga
    JOIN users u2 ON u2.id = ga.user_id
    WHERE u2.telegram_id = $1
  )`;

  // ILIKE op wallet_address werkt ook met NULL (geeft NULL → falsy), dus
  // audit entries van verwijderde users of RULE_ADDED/RULE_REMOVED entries
  // (zonder user_id) matchen simpelweg niet op wallet-zoektermen.
  const searchFilter = search
    ? ` AND (u.username ILIKE $2 OR u.first_name ILIKE $2 OR u.wallet_address ILIKE $2)`
    : "";

  const countParams: string[] = search ? [user.telegramId, `%${search}%`] : [user.telegramId];

  const totalResult = await query(
    `SELECT COUNT(*) FROM audit_logs al
     LEFT JOIN users u ON u.id = al.user_id
     WHERE ${adminGroupFilter}${searchFilter}`,
    countParams,
  );
  const totalLogs = parseInt(totalResult.rows[0].count);
  const totalPages = Math.max(1, Math.ceil(totalLogs / pageSize));

  const logParams: (string | number)[] = search
    ? [user.telegramId, `%${search}%`, pageSize, offset]
    : [user.telegramId, pageSize, offset];
  const limitClause = search ? `LIMIT $3 OFFSET $4` : `LIMIT $2 OFFSET $3`;

  const logs = await query(
    `SELECT al.*, g.title AS group_title,
            u.first_name AS user_first_name, u.username AS user_username
     FROM audit_logs al
     JOIN groups g ON g.id = al.group_id
     LEFT JOIN users u ON u.id = al.user_id
     WHERE ${adminGroupFilter}${searchFilter}
     ORDER BY al.created_at DESC ${limitClause}`,
    logParams,
  );

  res.render("audit", { user, logs: logs.rows, page, totalPages, totalLogs, search });
});

export default router;