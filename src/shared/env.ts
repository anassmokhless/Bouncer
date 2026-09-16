// Required env vars, validated at startup so misconfiguration fails fast.
const REQUIRED_VARS = [
  "BOT_TOKEN",
  "BOT_USERNAME",
  "DATABASE_URL",
  "ENJIN_API_URL",
  // The platform rejects unauthenticated queries, so this is no longer optional.
  "ENJIN_API_TOKEN",
  "SESSION_SECRET",
  // Contact-form SMTP.
  "SMTP_HOST",
  "SMTP_USER",
  "SMTP_PASS",
  "CONTACT_EMAIL",
] as const;

export function validateEnv() {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    console.error(`[ENV] FATAL: missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }

  // NODE_ENV isn't required, but a wrong value silently drops production behavior
  // (Secure cookies), so warn about it at boot.
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== "production" && nodeEnv !== "development" && nodeEnv !== "test") {
    console.warn(
      `[ENV] WARNING: NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : "not set"} — ` +
        `expected "production" on deployed instances. Running with development behavior (insecure cookies).`,
    );
  }
}
