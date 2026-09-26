export const ROLES_KEY = 'roles';

export const AUTH_CONFIG = {
  jwtSecret: process.env.JWT_SECRET ?? 'dev-only-secret-change-me',
  accessTtl: process.env.JWT_ACCESS_TTL ?? '15m',
  refreshTtlDays: Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30),
} as const;
