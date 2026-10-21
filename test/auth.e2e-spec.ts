import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { LoginResult } from './../src/auth/interfaces/auth.interface';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * AuthModule acceptance tests against a fresh Postgres database: real
 * migrations 001..011, a restricted (RLS-subject) app role, then the full
 * Nest app booted with that pool. Requires a running Postgres; skipped when
 * no `DATABASE_*` env vars are present.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'auth_ci';
const APP_ROLE = 'cafe_auth_app';
const APP_PASSWORD = 'cafe_auth_secret';
const PASSWORD = 'Password123!';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const B1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const B2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2';

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

describeWithDb('AuthModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let app: INestApplication<App>;
  const hash = hashSync(PASSWORD, 10);

  async function login(
    tenantId: string,
    email: string,
    password = PASSWORD,
  ): Promise<{ status: number; body: Partial<LoginResult> }> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Tenant-Id', tenantId)
      .send({ email, password });
    return {
      status: response.status,
      body: response.body as Partial<LoginResult>,
    };
  }

  async function refresh(
    tenantId: string,
    refreshToken: string,
  ): Promise<{ status: number; body: Partial<LoginResult> }> {
    const response = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('X-Tenant-Id', tenantId)
      .send({ refreshToken });
    return {
      status: response.status,
      body: response.body as Partial<LoginResult>,
    };
  }

  function postCheckout(accessToken: string): request.Test {
    return request(app.getHttpServer())
      .post('/checkout')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function getMe(accessToken: string): request.Test {
    return request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  beforeAll(async () => {
    await admin.query('SELECT 1');
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);

    adminTest = poolFor(TEST_DB);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await adminTest.query(sql);
    }

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

    await adminTest.query(
      `INSERT INTO tenants (id, slug, name, status) VALUES
         ('${T1}', 'beanhouse', 'Bean House', 'active'),
         ('${T2}', 'roastery', 'Roastery', 'active')`,
    );
    await adminTest.query(
      `INSERT INTO branches (id, tenant_id, name) VALUES
         ('${B1}', '${T1}', 'Brunch St'),
         ('${B2}', '${T2}', 'Nightside')`,
    );
    await adminTest.query(
      `INSERT INTO roles (name) VALUES
         ('super_admin'), ('org_owner'), ('branch_manager'),
         ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')`,
    );

    const userInsert = (
      email: string,
      fullName: string,
      role: string,
      tenantId: string,
      branchId: string | null,
    ) =>
      `('${tenantId}', ${branchId ? `'${branchId}'` : 'NULL'}, ` +
      `(SELECT id FROM roles WHERE name = '${role}'), '${fullName}', '${email}', '${hash}')`;
    await adminTest.query(`
      INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
      VALUES
        ${userInsert('same@cafe.test', 'T1 Branch Manager', 'branch_manager', T1, B1)},
        ${userInsert('recep@cafe.test', 'Receptionist', 'receptionist', T1, B1)},
        ${userInsert('waiter@cafe.test', 'Waiter', 'waiter', T1, B1)},
        ${userInsert('kitchen@cafe.test', 'Kitchen Staff', 'kitchen_staff', T1, B1)},
        ${userInsert('customer@cafe.test', 'Customer', 'customer', T1, B1)},
        ${userInsert('owner@cafe.test', 'Org Owner', 'org_owner', T1, B1)},
        ${userInsert('root@cafe.test', 'Root Admin', 'super_admin', T1, null)},
        ${userInsert('same@cafe.test', 'T2 Customer', 'customer', T2, B2)}
    `);

    const testPool = poolFor(TEST_DB, {
      user: APP_ROLE,
      password: APP_PASSWORD,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PG_POOL)
      .useValue(testPool)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    // Listen on a real (ephemeral) port once. Leaving the server unlistened
    // makes supertest spin up and tear down a throwaway server per request,
    // which intermittently resets in-flight sockets ("read ECONNRESET") on
    // newer Node — a transport flake, never a product one.
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
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

  describe('tenant-scoped login', () => {
    it('rejects login without a resolvable tenant', async () => {
      const response = await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'same@cafe.test', password: PASSWORD });
      expect(response.status).toBe(404);
    });

    it('logs in successfully inside a tenant', async () => {
      const { status, body } = await login(T1, 'recep@cafe.test');
      expect(status).toBe(200);
      expect(typeof body.accessToken).toBe('string');
      expect((body.accessToken ?? '').length).toBeGreaterThan(0);
      expect(typeof body.refreshToken).toBe('string');
      expect(body.user).toMatchObject({
        tenantId: T1,
        role: 'receptionist',
        email: 'recep@cafe.test',
      });
    });

    it('keeps the same email distinct across tenants (UNIQUE tenant_id+email)', async () => {
      const t1 = await login(T1, 'same@cafe.test');
      const t2 = await login(T2, 'same@cafe.test');

      expect(t1.status).toBe(200);
      expect(t2.status).toBe(200);
      expect(t1.body.user).toMatchObject({
        tenantId: T1,
        role: 'branch_manager',
      });
      expect(t2.body.user).toMatchObject({ tenantId: T2, role: 'customer' });
      expect(t1.body.user?.userId).not.toBe(t2.body.user?.userId);
    });

    it('rejects credentials that exist only in another tenant', async () => {
      const { status } = await login(T2, 'recep@cafe.test', PASSWORD);
      expect(status).toBe(401);
    });

    it('rejects a wrong password', async () => {
      const { status } = await login(T1, 'recep@cafe.test', 'NotThePassword');
      expect(status).toBe(401);
    });
  });

  describe('JWT-protected endpoints', () => {
    it('rejects /auth/me without a token (no tenant to resolve -> 404)', async () => {
      const response = await request(app.getHttpServer()).get('/auth/me');
      expect(response.status).toBe(404);
    });

    it('returns the authenticated user from the access token', async () => {
      const { body } = await login(T1, 'recep@cafe.test');
      const response = await getMe(body.accessToken ?? '');
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        userId: body.user?.userId,
        tenantId: T1,
        role: 'receptionist',
      });
    });
  });

  describe('checkout RBAC (RolesGuard + @Roles)', () => {
    it.each([
      ['same@cafe.test', 202],
      ['recep@cafe.test', 202],
      ['owner@cafe.test', 403],
      ['waiter@cafe.test', 403],
      ['kitchen@cafe.test', 403],
      ['customer@cafe.test', 403],
      ['root@cafe.test', 403],
    ])(
      'allows %s strictly per branch_manager/receptionist ',
      async (email, expected) => {
        const { body } = await login(T1, email);
        const response = await postCheckout(body.accessToken ?? '');
        expect(response.status).toBe(expected);
      },
    );

    it('rejects POST /checkout without a token (no tenant to resolve -> 404)', async () => {
      const response = await request(app.getHttpServer()).post('/checkout');
      expect(response.status).toBe(404);
    });
  });

  describe('a customer token reads no staff data', () => {
    // A `customer` account is a real credential: it logs in, it holds a valid
    // JWT, and the JWT alone used to be enough to read the café's tickets and
    // its branch list. The staff surfaces are role-restricted now.
    it.each([
      ['GET', '/branches'],
      ['GET', `/branches/${B1}/tables`],
      ['GET', `/orders/branches/${B1}/active`],
      ['GET', `/orders/branches/${B1}`],
      ['GET', `/menu/branches/${B1}`],
    ])('refuses %s %s to a customer', async (method, path) => {
      const { body } = await login(T1, 'customer@cafe.test');
      const response = await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${body.accessToken ?? ''}`)
        .set('X-Tenant-Id', T1);

      expect(response.status).toBe(403);
    });

    it('still lets a waiter read the branch list', async () => {
      const { body } = await login(T1, 'waiter@cafe.test');
      const response = await request(app.getHttpServer())
        .get('/branches')
        .set('Authorization', `Bearer ${body.accessToken ?? ''}`)
        .set('X-Tenant-Id', T1);

      expect(response.status).toBe(200);
    });
  });

  describe('refresh token rotation', () => {
    it('rotates to a new token and invalidates the previous one', async () => {
      const { body: loginBody } = await login(T1, 'waiter@cafe.test');
      const rt1 = loginBody.refreshToken ?? '';

      const first = await refresh(T1, rt1);
      expect(first.status).toBe(200);
      const rt2 = first.body.refreshToken ?? '';
      expect(rt2).not.toBe(rt1);

      const second = await refresh(T1, rt2);
      expect(second.status).toBe(200);
    });

    it('detects reuse of a rotated token and revokes the whole session family', async () => {
      const { body: loginBody } = await login(T1, 'customer@cafe.test');
      const rt1 = loginBody.refreshToken ?? '';

      const rotated = await refresh(T1, rt1);
      expect(rotated.status).toBe(200);
      const rt2 = rotated.body.refreshToken ?? '';

      const reused = await refresh(T1, rt1);
      expect(reused.status).toBe(401);

      const family = await refresh(T1, rt2);
      expect(family.status).toBe(401);
    });
  });

  describe('logout', () => {
    it('revokes the presented refresh token', async () => {
      const { body: loginBody } = await login(T1, 'kitchen@cafe.test');
      const accessToken = loginBody.accessToken ?? '';
      const refreshToken = loginBody.refreshToken ?? '';

      const logout = await request(app.getHttpServer())
        .post('/auth/logout')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ refreshToken });
      expect(logout.status).toBe(200);

      const refreshed = await refresh(T1, refreshToken);
      expect(refreshed.status).toBe(401);
    });
  });
});
