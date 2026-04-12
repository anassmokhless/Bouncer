import { Request, Response, NextFunction } from "express";

export function requireLogin(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    res.redirect("/login");
    return;
  }
  next();
}