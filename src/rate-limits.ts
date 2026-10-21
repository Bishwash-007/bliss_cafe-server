/**
 * Rate limits, in one place.
 *
 * The numbers are the DEFAULTS, not the law: every one of them can be
 * overridden through an environment variable, because the right limit depends
 * on the deployment (a café behind a NAT shares one public IP, so a limit
 * tuned for a single user can lock out a whole shop).
 *
 * They are read per request rather than captured at import time, so a
 * configuration change does not need a restart of the decorator metadata —
 * and so the e2e suite can raise the limits for its own process.
 */

/** Reads a positive whole number from the environment, or falls back. */
function limitFromEnv(variable: string, fallback: number): number {
  const raw = process.env[variable];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.floor(parsed);
}

/** One minute, in milliseconds. */
export const MINUTE = 60_000;

/**
 * `POST /auth/login`.
 *
 * The tightest limit in the app: it is the one route where an unlimited
 * number of attempts buys an attacker something (a password guess, or a
 * credential-stuffing run).
 */
export const LOGIN_LIMIT = (): number =>
  limitFromEnv('AUTH_LOGIN_RATE_LIMIT', 20);

/** `POST /auth/refresh` — a token rotation, not a credential check. */
export const REFRESH_LIMIT = (): number =>
  limitFromEnv('AUTH_REFRESH_RATE_LIMIT', 30);

/**
 * `POST /onboarding` — creating a tenant writes to the platform tables, so it
 * is limited harder than a normal business write.
 */
export const ONBOARDING_LIMIT = (): number =>
  limitFromEnv('ONBOARDING_RATE_LIMIT', 10);
