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
import type { TenantOnboardingResult } from './../src/org/tenant-onboarding.builder';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * OrgModule / BranchModule acceptance tests against a fresh Postgres database:
 * real migrations 001..011, a restricted (RLS-subject) app role, then the full
 * Nest app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'org_branch_ci';
const APP_ROLE = 'cafe_org_app';
const APP_PASSWORD = 'cafe_org_secret';
const PASSWORD = 'Password123!';

const PLAN_FREE = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const PLAN_STARTER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PLAN_PRO = '99999999-9999-4999-8999-999999999999';

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

describeWithDb('OrgModule / BranchModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let app: INestApplication<App>;
  const hash = hashSync(PASSWORD, 10);

  let ownerTenantId = '';
  let ownerBranchId = '';
  let ownerAccessToken = '';
  const ownerEmail = 'owner@cafe.test';

  async function count(query: string, values: unknown[] = []): Promise<number> {
    const result = await adminTest.query<{ n: number }>(
      `SELECT count(*)::int AS n ${query}`,
      values,
    );
    return result.rows[0]?.n ?? 0;
  }

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

  function onboard(payload: object): request.Test {
    return request(app.getHttpServer()).post('/onboarding').send(payload);
  }

  function getBranches(accessToken = ''): request.Test {
    return request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function postBranch(accessToken: string, body: object): request.Test {
    return request(app.getHttpServer())
      .post('/branches')
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  function patchBranch(
    accessToken: string,
    branchId: string,
    body: object,
  ): request.Test {
    return request(app.getHttpServer())
      .patch(`/branches/${branchId}`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
  }

  function deleteBranch(accessToken: string, branchId: string): request.Test {
    return request(app.getHttpServer())
      .delete(`/branches/${branchId}`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function getTables(accessToken: string, branchId: string): request.Test {
    return request(app.getHttpServer())
      .get(`/branches/${branchId}/tables`)
      .set('Authorization', `Bearer ${accessToken}`);
  }

  function postTable(
    accessToken: string,
    branchId: string,
    body: object,
  ): request.Test {
    return request(app.getHttpServer())
      .post(`/branches/${branchId}/tables`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send(body);
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

    await adminTest.query(`
      INSERT INTO plans (id, name, max_branches, max_staff, price_monthly) VALUES
        ('${PLAN_FREE}', 'free', 1, 5, 0),
        ('${PLAN_STARTER}', 'starter', 3, 15, 2499),
        ('${PLAN_PRO}', 'pro', 10, 50, 4999)
    `);
    await adminTest.query(`
      INSERT INTO roles (name) VALUES
        ('super_admin'), ('org_owner'), ('branch_manager'),
        ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')
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

  describe('tenant onboarding', () => {
    it('creates tenant + branch + 3 tables + owner account, all linked', async () => {
      const response = await onboard({
        orgName: 'Bean House',
        slug: 'BeanHouse',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Brunch St', address: '123 Main' },
        defaultTables: 3,
        owner: { email: ownerEmail, password: PASSWORD },
      });

      expect(response.status).toBe(201);
      const body = response.body as TenantOnboardingResult;
      expect(body.slug).toBe('beanhouse');
      expect(body.tableIds).toHaveLength(3);

      ownerTenantId = body.tenantId;
      ownerBranchId = body.branchId;

      expect(await count(`FROM tenants WHERE slug = 'beanhouse'`)).toBe(1);
      expect(
        await count(`FROM branches WHERE tenant_id = '${ownerTenantId}'`),
      ).toBe(1);
      expect(
        await count(`FROM tables WHERE tenant_id = '${ownerTenantId}'`),
      ).toBe(3);
      expect(
        await count(`FROM users WHERE tenant_id = '${ownerTenantId}'`),
      ).toBe(1);

      const owner = await adminTest.query<{
        email: string;
        full_name: string;
        password_hash: string;
        role: string;
      }>(
        `SELECT u.email, u.full_name, u.password_hash, r.name AS role
           FROM users u
           JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id = '${ownerTenantId}'`,
      );
      expect(owner.rows[0]).toMatchObject({
        email: ownerEmail,
        full_name: 'owner',
        role: 'org_owner',
      });
      expect(owner.rows[0].password_hash).toMatch(/^\$2[aby]\$/);

      const loginResult = await login(ownerTenantId, ownerEmail);
      expect(loginResult.status).toBe(200);
      expect(loginResult.body.user).toMatchObject({
        tenantId: ownerTenantId,
        role: 'org_owner',
      });
      ownerAccessToken = loginResult.body.accessToken ?? '';

      // seed a lower-privilege staff member for the RBAC tests below
      await adminTest.query(
        `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
         VALUES ('${ownerTenantId}', '${ownerBranchId}',
                 (SELECT id FROM roles WHERE name = 'receptionist'),
                 'Receptionist', 'recep@cafe.test', '${hash}')`,
      );
    });

    it('rejects a duplicate slug with 409 and leaves zero rows behind', async () => {
      const response = await onboard({
        orgName: 'Bean House Copy',
        slug: 'beanhouse',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Second' },
        owner: { email: 'copy@cafe.test', password: PASSWORD },
      });

      expect(response.status).toBe(409);
      expect((response.body as { message?: string }).message).toContain(
        'already taken',
      );
      expect(await count(`FROM tenants WHERE slug = 'beanhouse'`)).toBe(1);
    });

    it('rejects a plan that does not exist with 400 before inserting anything', async () => {
      const response = await onboard({
        orgName: 'Ghost Org',
        slug: 'ghost-org',
        planId: 'dead-beef-dead-beef-dead-beefdeadbeef',
        firstBranch: { name: 'Ghost Branch' },
        owner: { email: 'ghost@cafe.test', password: PASSWORD },
      });

      expect(response.status).toBe(400);
      expect((response.body as { message?: string }).message).toContain('Plan');
      expect(await count(`FROM tenants WHERE slug = 'ghost-org'`)).toBe(0);
      expect(
        await count(`FROM branches b
           JOIN tenants t ON t.id = b.tenant_id
          WHERE t.slug = 'ghost-org'`),
      ).toBe(0);
    });
  });

  describe('branch plan enforcement and CRUD', () => {
    let firstExtra: string;

    it('allows creating branches while under the plan limit', async () => {
      const first = await postBranch(ownerAccessToken, { name: 'West End' });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        tenant_id: ownerTenantId,
        name: 'West End',
      });
      firstExtra = (first.body as { id: string }).id;

      const second = await postBranch(ownerAccessToken, {
        name: 'Harbourside',
        address: '9 Dock Rd',
      });
      expect(second.status).toBe(201);
      expect(second.body).toMatchObject({ tenant_id: ownerTenantId });
    });

    it('blocks a further branch with the current plan limit in the error', async () => {
      const response = await postBranch(ownerAccessToken, {
        name: 'One Too Many',
      });
      expect(response.status).toBe(409);
      expect((response.body as { message?: string }).message).toContain('3');
      expect(
        await count(
          `FROM branches WHERE tenant_id = '${ownerTenantId}' AND is_active = true`,
        ),
      ).toBe(3);
    });

    it('updates and deactivates a branch by id (soft delete)', async () => {
      const patched = await patchBranch(ownerAccessToken, firstExtra, {
        name: 'West End North',
      });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ name: 'West End North' });

      const deactivated = await deleteBranch(ownerAccessToken, firstExtra);
      expect(deactivated.status).toBe(200);
      expect(deactivated.body).toMatchObject({
        id: firstExtra,
        is_active: false,
      });

      const branches = await getBranches(ownerAccessToken);
      expect(branches.status).toBe(200);
      const names = (branches.body as { name: string }[]).map((b) => b.name);
      expect(names).toContain('West End North');
      expect(names).toContain('Brunch St');
    });

    it('returns 404 when patching a missing branch', async () => {
      const patched = await patchBranch(ownerAccessToken, 'no-such-branch', {
        name: 'Nope',
      });
      expect(patched.status).toBe(404);
    });
  });

  describe('table CRUD under a branch', () => {
    it('lists the seeded default tables', async () => {
      const response = await getTables(ownerAccessToken, ownerBranchId);
      expect(response.status).toBe(200);
      const labels = (response.body as { label: string }[]).map((t) => t.label);
      expect(labels).toEqual(['T1', 'T2', 'T3']);
    });

    it('creates a new table with a default seat count', async () => {
      const response = await postTable(ownerAccessToken, ownerBranchId, {
        label: 'Patio 1',
        seats: 4,
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        branch_id: ownerBranchId,
        label: 'Patio 1',
        seats: 4,
      });
    });

    it('rejects a duplicate label in the same branch with a friendly error', async () => {
      const response = await postTable(ownerAccessToken, ownerBranchId, {
        label: 'T1',
      });
      expect(response.status).toBe(409);
      expect((response.body as { message?: string }).message).toContain(
        'already exists in this branch',
      );
    });

    it('returns 404 when listing tables of an unknown branch', async () => {
      const response = await getTables(ownerAccessToken, 'no-such-branch');
      expect(response.status).toBe(404);
    });
  });

  describe('RBAC on branch routes', () => {
    it('rejects a request with a tenant but no access token (401)', async () => {
      const response = await request(app.getHttpServer())
        .get('/branches')
        .set('X-Tenant-Id', ownerTenantId);
      expect(response.status).toBe(401);
    });

    it('rejects a request with no tenant resolution (404 before guards run)', async () => {
      const response = await request(app.getHttpServer()).get('/branches');
      expect(response.status).toBe(404);
    });

    it('lets staff read branches but not mutate them', async () => {
      const staff = await login(ownerTenantId, 'recep@cafe.test');
      expect(staff.status).toBe(200);
      const token = staff.body.accessToken ?? '';

      const list = await getBranches(token);
      expect(list.status).toBe(200);

      const create = await postBranch(token, { name: 'Staff Branch' });
      expect(create.status).toBe(403);

      const table = await postTable(token, ownerBranchId, { label: 'Staff T' });
      expect(table.status).toBe(403);
    });
  });
});
