import type { Provider } from '@nestjs/common';
import { Pool } from 'pg';

/** DI token for the platform-reporting pool. */
export const PLATFORM_POOL = 'PLATFORM_POOL';

function platformPoolConfig():
  { connectionString: string } | Record<string, string | number> {
  const url = process.env.PLATFORM_DATABASE_URL;
  if (url) {
    return { connectionString: url };
  }

  return {
    host:
      process.env.PLATFORM_DATABASE_HOST ??
      process.env.DATABASE_HOST ??
      'localhost',
    port: Number(
      process.env.PLATFORM_DATABASE_PORT ?? process.env.DATABASE_PORT ?? 5432,
    ),
    user:
      process.env.PLATFORM_DATABASE_USER ??
      process.env.DATABASE_USER ??
      'cafe_admin',
    password:
      process.env.PLATFORM_DATABASE_PASSWORD ??
      process.env.DATABASE_PASSWORD ??
      'cafe_pass',
    database:
      process.env.PLATFORM_DATABASE_NAME ??
      process.env.DATABASE_NAME ??
      'cafe_saas',
  };
}

/**
 * Platform reports span every tenant, so they cannot run through the ordinary
 * request connection: that connection is deliberately pinned to one tenant (or
 * to a tenant that cannot exist, for `/platform/*`), and RLS then returns zero
 * rows from `orders`.
 *
 * This pool is the explicit exception. In production `PLATFORM_DATABASE_USER`
 * should name a role with `BYPASSRLS` (or own the tables), and it should be
 * used only by the platform reporting repository. Falling back to the normal
 * `DATABASE_*` settings keeps local development working; a fallback role that
 * is still RLS-subject will make the platform report visibly empty rather than
 * leak tenant data, which is the safe failure direction.
 */
export const platformPoolProvider: Provider = {
  provide: PLATFORM_POOL,
  useFactory: (): Pool => {
    const pool = new Pool({
      ...platformPoolConfig(),
      max: Number(process.env.PLATFORM_PG_POOL_MAX ?? 5),
    });
    pool.on('error', (error) => {
      console.error(
        'Unexpected error on idle platform PostgreSQL client',
        error,
      );
    });
    return pool;
  },
};
