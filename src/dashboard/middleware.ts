import { Request, Response, NextFunction } from "express";
import { query } from "../shared/db.js";
import { checkBouncerAccess } from "../bot/helpers.js";

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

// Gate for dashboard mutation routes: require the pass on POSTs so an admin who
// transferred their pass can't keep making changes. Tri-state: true continues,
// false is 403, null (Enjin error) is 503. POSTs only — never gate reads.
// Replies with a JSON error to fetch callers, else redirects with ?accessError=.
export async function requireBouncerPass(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  const user = req.session.user!;
  const access = await checkBouncerAccess(user.telegramId);

  if (access === true) {
    next();
    return;
  }

  const msg =
    access === null
      ? "Couldn't verify your Bouncer Pass right now — try again in a moment."
      : "You need a Bouncer Pass to make changes to your groups.";
  const httpStatus = access === null ? 503 : 403;

  // Group-scoped URLs go back to the group page; others to the dashboard root.
  const groupId = req.params.id;
  const redirectTarget = groupId
    ? `/dashboard/${groupId}?accessError=${encodeURIComponent(msg)}`
    : `/dashboard?accessError=${encodeURIComponent(msg)}`;

  // The recheck button POSTs JSON; form submits are urlencoded.
  if (req.is("application/json")) {
    res.status(httpStatus).json({ error: msg });
    return;
  }
  res.redirect(redirectTarget);
}