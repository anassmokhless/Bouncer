import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request, Response } from "express";

// Dashboard rate limiters. Keyed per IP (TRUST_PROXY makes req.ip the real
// client behind nginx) unless noted otherwise.

// Anonymous traffic. Logged-in users are exempt so the 2s recheck-status poll
// isn't throttled.
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

// Telegram login callback — real use is one or two logins.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 15,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many login attempts. Please try again in a few minutes.");
  },
});

// Dashboard mutations. Anyone can log in, so authenticated ≠ trusted. Mounted
// before requireGroupAdmin so its DB lookup is covered too.
export const mutationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req: Request, res: Response) => {
    res.status(429).send("Too many actions. Please slow down and try again in a few minutes.");
  },
});

// DB-heavy authenticated GETs (dashboard list, group detail, audit search),
// which publicLimiter skips. Keyed by session user id — a logged-in attacker
// can't rotate identity like an IP, and it's NAT-safe. The ipKeyGenerator
// fallback is unreachable (requireLogin runs first) but keeps v8 from flagging
// a raw req.ip and normalizes IPv6 if a route is ever mounted without login.
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
