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

// Gate for dashboard mutation routes. The Telegram bot re-checks Bouncer Pass
// on every admin command; without this middleware, the dashboard would NOT —
// an admin who acquired the pass once and later transferred it would retain
// full dashboard powers. checkBouncerAccess is tri-state:
//   true  → continue
//   false → user has no wallet or wallet definitively lacks the pass (403)
//   null  → Enjin API error; we can't decide, tell the user to retry (503)
// Never gate read-only routes with this — denying visibility hurts admins who
// need to audit what they lost. Gate POSTs only.
//
// Response style: redirect back with ?accessError= for form submits (rendered
// as a banner by the target view); JSON for fetch/AJAX callers (the manual
// recheck button). Sniffed via req.accepts.
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

  // Pick redirect target: group-scoped URLs go back to the group page so the
  // banner renders in context; unscoped URLs go to the dashboard root.
  const groupId = req.params.id;
  const redirectTarget = groupId
    ? `/dashboard/${groupId}?accessError=${encodeURIComponent(msg)}`
    : `/dashboard?accessError=${encodeURIComponent(msg)}`;

  // Detect fetch/AJAX callers via Content-Type: the only JSON-POSTing route is
  // the recheck button (sends an empty JSON body); form submits use
  // application/x-www-form-urlencoded. Content-Type is more reliable than
  // Accept here because the existing client fetch doesn't set Accept.
  if (req.is("application/json")) {
    res.status(httpStatus).json({ error: msg });
    return;
  }
  res.redirect(redirectTarget);
}