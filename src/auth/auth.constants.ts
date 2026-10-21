export const ROLES_KEY = 'roles';

/** The secret used when nothing is configured. It is refused in production. */
const DEVELOPMENT_FALLBACK_SECRET = 'dev-only-secret-change-me';

/**
 * Resolves the signing secret.
 *
 * The development fallback is convenient locally and fatal in production: a
 * deployment that ships the fallback would let anybody mint a token for any
 * tenant, because the secret is in the repository.
 */
function resolveJwtSecret(): string {
  const configured = process.env.JWT_SECRET?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!configured) {
    if (isProduction) {
      throw new Error(
        'JWT_SECRET must be set in production. Refusing to start with the ' +
          'development fallback secret.',
      );
    }
    return DEVELOPMENT_FALLBACK_SECRET;
  }

  if (isProduction) {
    if (configured === DEVELOPMENT_FALLBACK_SECRET) {
      throw new Error(
        'JWT_SECRET must not be the development fallback secret in production.',
      );
    }
    if (configured.length < 32) {
      throw new Error(
        'JWT_SECRET must be at least 32 characters long in production.',
      );
    }
  }

  return configured;
}

/** The refresh-token lifetime, in days, with a safe fallback. */
function resolveRefreshTtlDays(): number {
  const configured = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);
  if (!Number.isFinite(configured) || configured <= 0) {
    return 30;
  }
  return Math.floor(configured);
}

export const AUTH_CONFIG = {
  jwtSecret: resolveJwtSecret(),
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshTtlDays: resolveRefreshTtlDays(),
} as const;
