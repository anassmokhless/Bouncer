import { Request, Response, NextFunction } from "express";
import { query } from "../shared/db.js";

export function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  next();
}

export function requireGroupAdmin(req: Request, res: Response, next: NextFunction) {
  const user = req.session.user!;
  const groupId = req.params.id;

  query(
    `SELECT 1 FROM group_admins ga JOIN users u ON u.id = ga.user_id
     WHERE ga.group_id = $1 AND u.telegram_id = $2`,
    [groupId, user.telegramId],
  ).then((result) => {
    if (result.rows.length === 0) {
      res.status(403).send("Forbidden");
      return;
    }
    next();
  }).catch(next);
}