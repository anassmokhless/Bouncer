import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";

// Rate limiters for the dashboard. Same conventions as the contact-form
// limiter (draft-7 standard headers, no legacy X-RateLimit-*). All limits are
// keyed per IP — TRUST_PROXY is configured in server.ts, so req.ip is the
// real client address behind nginx, not the proxy.

// App-wide limiter for anonymous traffic. The public pages are the concern:
// the landing page runs three COUNT queries per hit, and /auth touches the DB
// too — on metered Postgres an unthrottled flood costs real money. Logged-in
// users are exempt: the recheck UI polls its status endpoint every 2 seconds
// for the duration of a job, which would blow through any budget sized for
// anonymous visitors.
export const publicLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req: Request) => Boolean(req.session?.user),
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many requests from this address. Please try again in a few minutes.");
  },
});

// Stricter limit on the Telegram login callback — the most expensive
// anonymous endpoint (HMAC verify + user upsert + session write). Legitimate
// use is one or two logins; anything beyond this is scripted.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many login attempts. Please try again in a few minutes.");
  },
});

// Dashboard mutations (manual recheck, rule add/delete). Authenticated, but
// anyone with a Telegram account can log in, so authenticated ≠ trusted.
// Applied before the auth middleware so the per-request DB lookups in
// requireGroupAdmin are covered too. 30 per 10 minutes is far above real
// admin usage.
export const mutationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many actions. Please slow down and try again in a few minutes.");
  },
});

// Read limiter for the DB-heavy authenticated GETs (dashboard list, group
// detail, audit search). publicLimiter exempts logged-in users so its
// recheck-status poll isn't throttled, but "logged in" is not "trusted" —
// anyone with a Telegram account can log in — so these routes need their own
// budget. Keyed by session user id, not IP: a logged-in attacker can't rotate
// identity the way they can rotate IPs, and it won't punish honest users
// behind a shared NAT. The `?? ipKeyGenerator(...)` fallback is unreachable in
// practice (requireLogin runs first and guarantees a user), but express-rate-
// limit v8 flags any raw `req.ip` in a keyGenerator, and the helper normalizes
// IPv6 to a subnet so the fallback can't be bypassed by address rotation if a
// route is ever mounted without requireLogin. 120/min is far above real
// browsing and leaves the 2s recheck poll (a different route) untouched.
export const readLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.session?.user?.id ?? ipKeyGenerator(req.ip ?? "unknown"),
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many requests. Please slow down and try again in a minute.");
  },
});
