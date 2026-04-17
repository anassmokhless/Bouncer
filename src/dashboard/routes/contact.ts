import { Router, Request, Response } from "express";
import nodemailer from "nodemailer";

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

router.get("/", (_req: Request, res: Response) => {
  res.render("contact", { success: false, error: null });
});

router.post("/", async (req: Request, res: Response) => {
  const { telegram, email, role, message, _csrf } = req.body;

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

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.render("contact", { success: false, error: "Please enter a valid email address." });
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
