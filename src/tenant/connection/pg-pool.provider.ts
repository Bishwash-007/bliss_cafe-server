import type { Provider } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../tenant.constants';

function databaseConfigFromEnv():
  { connectionString: string } | Record<string, string | number> {
  const url = process.env.DATABASE_URL;
  if (url) {
    return { connectionString: url };
  }

  return {
    host: process.env.DATABASE_HOST ?? 'localhost',
    port: Number(process.env.DATABASE_PORT ?? 5432),
    user: process.env.DATABASE_USER ?? 'cafe_admin',
    password: process.env.DATABASE_PASSWORD ?? 'cafe_pass',
    database: process.env.DATABASE_NAME ?? 'cafe_saas',
  };
}

/**
 * Provides the shared `pg.Pool`. A single role/pool is used for both
 * tenant-scoped and platform queries; tenant isolation comes from
 * `SET LOCAL app.tenant_id` at the transaction level (RLS), and platform
 * super-admins are expected to connect with `BYPASSRLS` in production.
 */
export const pgPoolProvider: Provider = {
  provide: PG_POOL,
  useFactory: (): Pool => {
    const pool = new Pool({
      ...databaseConfigFromEnv(),
      max: Number(process.env.PG_POOL_MAX ?? 10),
    });
    // Idle clients that error shouldn't crash the process.
    pool.on('error', (error) => {
      console.error('Unexpected error on idle PostgreSQL client', error);
    });
    return pool;
  },
};
