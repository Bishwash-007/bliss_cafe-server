import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import { TenantScopedConnection } from '../src/tenant/connection/tenant-scoped-connection';

/**
 * Proves the RLS enforcement mechanism from
 * `db/migrations/010_row_level_security.sql` end-to-end:
 *
 *  - a query without `app.tenant_id` set returns ZERO rows (fail-safe),
 *  - a tenant-scoped connection sees only its own rows (isolation).
 *
 * Requires a running Postgres. Connection details come from the same
 * `DATABASE_*` environment variables the CI workflow provides. When the env
 * vars are absent (e.g. local `npm run test:e2e` with no DB), the suite is
 * skipped.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = `tenant_rls_ci`;
const APP_ROLE = 'cafe_rls_app';
const APP_PASSWORD = 'cafe_rls_secret';

// Tenant ids: valid uuids, distinct tenants.
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
// Valid-format uuid that does NOT exist in the tenants table.
const UNKNOWN = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';

const configProvided = Boolean(
  process.env.DATABASE_URL || process.env.DATABASE_HOST,
);

function poolFor(database: string, overrides: Partial<PoolConfig> = {}): Pool {
  const base: PoolConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.DATABASE_HOST ?? 'localhost',
        port: Number(process.env.DATABASE_PORT ?? 5432),
        user: process.env.DATABASE_USER ?? 'cafe_admin',
        password: process.env.DATABASE_PASSWORD ?? 'cafe_pass',
      };
  const pool = new Pool({ ...base, database, ...overrides });
  pool.on('error', () => {
    // idle-client errors must not crash the test runner
  });
  return pool;
}

/** Connects on behalf of the admin and kills sessions in the test database. */
async function terminateBackends(pool: Pool): Promise<void> {
  await pool
    ?.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
      [TEST_DB],
    )
    .catch(() => undefined);
}

/** Ends a pool, fully awaiting shutdown so Jest exits cleanly. */
async function endPool(pool: Pool | undefined): Promise<void> {
  if (!pool) {
    return;
  }
  await pool.end();
}

function describeWithDb(
  label: string,
  fn: () => void,
): ReturnType<typeof describe> {
  return configProvided ? describe(label, fn) : describe.skip(label, fn);
}

describeWithDb('TenantModule RLS enforcement (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool;

  beforeAll(async () => {
    // Fresh throwaway database each run so the tests never collide.
    await admin.query('SELECT 1');
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);

    adminTest = poolFor(TEST_DB);

    // Apply the real migrations (001..010) in order.
    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await adminTest.query(sql);
    }

    // Restricted app role: no BYPASSRLS, not the table owner, so RLS applies.
    await adminTest.query(`DROP ROLE IF EXISTS ${APP_ROLE}`);
    await adminTest.query(
      `CREATE ROLE ${APP_ROLE} LOGIN PASSWORD '${APP_PASSWORD}'`,
    );
    await adminTest.query(
      `GRANT CONNECT ON DATABASE ${TEST_DB} TO ${APP_ROLE}`,
    );
    await adminTest.query(`GRANT USAGE ON SCHEMA public TO ${APP_ROLE}`);
    await adminTest.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROLE}`,
    );
    await adminTest.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROLE}`,
    );

    // Seed two tenants, each with one branch.
    await adminTest.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES
         ('${T1}', 'beanhouse', 'Bean House', 'active'),
         ('${T2}', 'roastery', 'Roastery', 'active'),
         ('${UNKNOWN}', 'phantom', 'Phantom Co', 'suspended')`,
    );
    await adminTest.query(
      `INSERT INTO branches (id, tenant_id, name) VALUES
         ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', '${T1}', 'Brunch St'),
         ('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2', '${T2}', 'Nightside')`,
    );

    // Queries run as the restricted app role, which is subject to RLS.
    appPool = poolFor(TEST_DB, {
      user: APP_ROLE,
      password: APP_PASSWORD,
    });
  });

  afterAll(async () => {
    // Kill any leftover sessions (a failed test mid-transaction would
    // otherwise block DROP ROLE / DROP DATABASE indefinitely).
    await terminateBackends(admin);
    await endPool(appPool);
    await terminateBackends(admin);
    await adminTest
      ?.query(`DROP ROLE IF EXISTS ${APP_ROLE}`)
      .catch(() => undefined);
    await endPool(adminTest);
    await terminateBackends(admin);
    await admin
      ?.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      .catch(() => undefined);
    await endPool(admin);
  });

  describe('RLS fail-safe', () => {
    it('returns zero rows when app.tenant_id is never set', async () => {
      const result = await appPool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM branches',
      );
      expect(result.rows[0]?.count).toBe(0);
    });

    it('returns zero rows through an unscoped TenantScopedConnection', async () => {
      const connection = await TenantScopedConnection.acquireUnscoped(appPool);
      const result = await connection.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM branches',
      );
      expect(result.rows[0]?.count).toBe(0);
      await connection.release();
    });

    it('does not leak data when lacking a scope', async () => {
      const result = await appPool.query<{ id: string; name: string }>(
        'SELECT id, name FROM branches ORDER BY name',
      );
      expect(result.rows).toHaveLength(0);
    });
  });

  describe('tenant-scoped isolation', () => {
    it('sees only its own tenant rows when scoped', async () => {
      const connection = await TenantScopedConnection.acquireScoped(
        appPool,
        T1,
      );
      const result = await connection.query<{ name: string }>(
        'SELECT name FROM branches ORDER BY name',
      );
      expect(result.rows.map((row) => row.name)).toEqual(['Brunch St']);
      await connection.release();
    });

    it('keeps tenants fully separated', async () => {
      const t1 = await TenantScopedConnection.acquireScoped(appPool, T1);
      try {
        const foreign = await t1.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM branches WHERE id = $1',
          ['eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2'],
        );
        expect(foreign.rows[0]?.count).toBe(0);

        const own = await t1.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM branches WHERE id = $1',
          ['dddddddd-dddd-4ddd-8ddd-ddddddddddd1'],
        );
        expect(own.rows[0]?.count).toBe(1);
      } finally {
        await t1.commit();
      }
    });

    it('returns zero rows (not an error) for a tenant that owns no rows', async () => {
      const connection = await TenantScopedConnection.acquireScoped(
        appPool,
        UNKNOWN,
      );
      try {
        const result = await connection.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM branches',
        );
        expect(result.rows[0]?.count).toBe(0);
      } finally {
        await connection.release();
      }
    });
  });
});
