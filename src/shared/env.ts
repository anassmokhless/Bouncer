// Centralized required-env-var list. Entry points (bot/index.ts, dashboard/server.ts)
// call validateEnv() immediately after dotenv.config() so misconfiguration is caught
// at startup rather than surfacing later as broken t.me/undefined URLs, weak session
// secrets, or connections to the wrong database. To add a new required variable, append
// its name to REQUIRED_VARS — no call sites need to change; they keep reading
// process.env.X as before.
const REQUIRED_VARS = [
  "BOT_TOKEN",
  "BOT_USERNAME",
  "DATABASE_URL",
  "ENJIN_API_URL",
  "SESSION_SECRET",
  // Contact form SMTP — fail fast so /contact doesn't 500 silently on first submit.
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

  // NODE_ENV is not required (local dev works without it), but a wrong or
  // missing value on a deployed instance silently disables production behavior
  // — most importantly the Secure flag on session/CSRF cookies. Warn loudly so
  // misconfiguration shows up in the boot logs instead of staying invisible.
  const nodeEnv = process.env.NODE_ENV;
  if (nodeEnv !== "production" && nodeEnv !== "development" && nodeEnv !== "test") {
    console.warn(
      `[ENV] WARNING: NODE_ENV is ${nodeEnv ? `"${nodeEnv}"` : "not set"} — ` +
        `expected "production" on deployed instances. Running with development behavior (insecure cookies).`,
    );
  }
}
