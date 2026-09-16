import { Router, Request, Response } from "express";
import nodemailer from "nodemailer";
import rateLimit from "express-rate-limit";

const router = Router();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Throttle the public SMTP-wired form so a bot can't spam the inbox. POST only.
const contactLimiter = rateLimit({
  windowMs: 10 * 60 * 1000, // 10 minutes
  limit: 5, // 5 submissions per IP per window
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).render("contact", {
      success: false,
      error: "Too many messages sent from this address. Please try again in a few minutes.",
    });
  },
});

router.get("/", (_req: Request, res: Response) => {
  res.render("contact", { success: false, error: null });
});

router.post("/", contactLimiter, async (req: Request, res: Response) => {
  const { telegram, email, role, message } = req.body;

  // Validate required fields
  if (!telegram || !email || !role || !message) {
    res.render("contact", { success: false, error: "All fields are required." });
    return;
  }

  // Validate role
  if (!["admin", "user"].includes(role)) {
    res.render("contact", { success: false, error: "Invalid role selected." });
    return;
  }

  // Basic email format check. Length is capped *before* the test: the pattern is
  // ambiguous (`[^\s@]+` also matches the dot), so it backtracks quadratically —
  // the 100kb urlencoded default lets one request block the event loop for
  // seconds. 254 is the RFC 5321 maximum address length.
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.render("contact", { success: false, error: "Please enter a valid email address." });
    return;
  }

  // Optional @, 5–32 word chars. Also blocks CR/LF header injection into the subject.
  if (!/^@?[a-zA-Z0-9_]{5,32}$/.test(telegram)) {
    res.render("contact", {
      success: false,
      error: "Please enter a valid Telegram username (5–32 letters, digits, or underscores).",
    });
    return;
  }

  try {
    await transporter.sendMail({
      from: `"Bouncer Contact Form" <${process.env.SMTP_USER}>`,
      to: process.env.CONTACT_EMAIL,
      subject: `[Bouncer] New message from ${telegram} (${role})`,
      text: [
        `Telegram: ${telegram}`,
        `Email: ${email}`,
        `Role: ${role}`,
        ``,
        `Message:`,
        message,
      ].join("\n"),
      html: `
        <h2>New Bouncer Contact Form Submission</h2>
        <table style="border-collapse:collapse;">
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Telegram</td><td>${escapeHtml(telegram)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Email</td><td>${escapeHtml(email)}</td></tr>
          <tr><td style="padding:4px 12px 4px 0;font-weight:bold;">Role</td><td>${escapeHtml(role)}</td></tr>
        </table>
        <h3>Message</h3>
        <p style="white-space:pre-wrap;">${escapeHtml(message)}</p>
      `,
    });

    res.render("contact", { success: true, error: null });
  } catch (err) {
    console.error("[CONTACT] Failed to send email:", err);
    res.render("contact", { success: false, error: "Failed to send message. Please try again later." });
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default router;
