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
import { SubscriptionService } from './../src/billing';
import { PaymentProviderFactory } from './../src/payment';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * BillingModule acceptance tests against a fresh Postgres database: real
 * migrations, an RLS-subject app role, and the real Nest app with the payment
 * factory replaced by a recording fake.
 *
 * The fake is at the PaymentModule boundary on purpose. Everything below it —
 * the state machine, proration, renewal and SQL — is production code; no Stripe
 * or eSewa client is instantiated anywhere in this module, which is exactly what
 * the acceptance criterion asks us to prove.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'billing_ci';
const APP_ROLE = 'cafe_billing_app';
const APP_PASSWORD = 'cafe_billing_secret';
const PASSWORD = 'Password123!';

const PLAN_FREE = 'f0000000-0000-4000-8000-000000000001';
const PLAN_STARTER = 'f0000000-0000-4000-8000-000000000002';
const PLAN_PRO = 'f0000000-0000-4000-8000-000000000003';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';
const T4 = '44444444-4444-4444-8444-444444444444';

const OWNER1 = 'a1111111-1111-4111-8111-111111111111';
const WAITER1 = 'a2222222-2222-4222-8222-222222222222';
const OWNER2 = 'a3333333-3333-4333-8333-333333333333';

const SUB1 = 'b1111111-1111-4111-8111-111111111111';
const SUB2 = 'b2222222-2222-4222-8222-222222222222';
const SUB3 = 'b3333333-3333-4333-8333-333333333333';
const SUB4 = 'b4444444-4444-4444-8444-444444444444';

const OWNER1_EMAIL = 'billing-owner@cafe.test';
const WAITER1_EMAIL = 'billing-waiter@cafe.test';
const OWNER2_EMAIL = 'billing-owner2@cafe.test';

const configProvided = Boolean(
  process.env.DATABASE_URL || process.env.DATABASE_HOST,
);

interface BillingCharge {
  tenantId: string;
  amount: number;
  reference: string;
}

const charges: BillingCharge[] = [];
const failingTenants = new Set<string>();

const providerFor = (tenantId: string) => ({
  name: 'stripe' as const,
  charge: jest.fn((amount: number, reference: string) => {
    charges.push({ tenantId, amount, reference });
    if (failingTenants.has(tenantId)) {
      return Promise.reject(new Error('card declined by issuer'));
    }
    return Promise.resolve({
      provider: 'stripe' as const,
      providerReference: `pi_billing_${charges.length}`,
      status: 'succeeded' as const,
      amount,
    });
  }),
  refund: jest.fn(),
  generateQr: jest.fn(),
  verifyWebhookSignature: jest.fn(),
});

const fakeFactory = {
  getProvider: jest.fn((tenantId: string) =>
    Promise.resolve(providerFor(tenantId)),
  ),
  getProviderByName: jest.fn((tenantId: string) =>
    Promise.resolve(providerFor(tenantId)),
  ),
};

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

async function evictStragglers(admin: Pool): Promise<void> {
  await admin
    .query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [TEST_DB],
    )
    .catch(() => undefined);
  await admin
    .query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    .catch(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${APP_ROLE}`).catch(() => undefined);
}

function describeWithDb(
  label: string,
  fn: () => void,
): ReturnType<typeof describe> {
  return configProvided ? describe(label, fn) : describe.skip(label, fn);
}

describeWithDb('BillingModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  const hash = hashSync(PASSWORD, 10);

  let ownerToken = '';
  let waiterToken = '';
  let owner2Token = '';

  async function login(email: string, tenant = T1): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Tenant-Id', tenant)
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return (response.body as LoginResult).accessToken;
  }

  function action(
    token: string,
    tenant: string,
    body: Record<string, unknown>,
  ): request.Test {
    return request(app.getHttpServer())
      .post('/billing/subscription/actions')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenant)
      .send(body);
  }

  beforeAll(async () => {
    await admin.query('SELECT 1');
    await evictStragglers(admin);
    await admin.query(`CREATE DATABASE ${TEST_DB}`);
    adminTest = poolFor(TEST_DB);

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((file) => file.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await adminTest.query(sql);
    }

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
        ('${PLAN_STARTER}', 'starter', 3, 20, 20),
        ('${PLAN_PRO}', 'pro', 10, 100, 50)
    `);
    await adminTest.query(`
      INSERT INTO roles (name) VALUES
        ('super_admin'), ('org_owner'), ('branch_manager'),
        ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')
    `);
    await adminTest.query(`
      INSERT INTO tenants (id, slug, name, plan_id, status) VALUES
        ('${T1}', 'billing-one', 'Billing One', '${PLAN_STARTER}', 'active'),
        ('${T2}', 'billing-two', 'Billing Two', '${PLAN_STARTER}', 'active'),
        ('${T3}', 'billing-three', 'Billing Three', '${PLAN_STARTER}', 'active'),
        ('${T4}', 'billing-four', 'Billing Four', '${PLAN_STARTER}', 'active')
    `);

    const userInsert = (
      id: string,
      tenant: string,
      role: string,
      name: string,
      email: string,
    ) =>
      adminTest.query(
        `INSERT INTO users
           (id, tenant_id, branch_id, role_id, full_name, email, password_hash)
         VALUES ($1, $2, NULL, (SELECT id FROM roles WHERE name = $3), $4, $5, $6)`,
        [id, tenant, role, name, email, hash],
      );

    await userInsert(OWNER1, T1, 'org_owner', 'Owner One', OWNER1_EMAIL);
    await userInsert(WAITER1, T1, 'waiter', 'Waiter One', WAITER1_EMAIL);
    await userInsert(OWNER2, T2, 'org_owner', 'Owner Two', OWNER2_EMAIL);

    await adminTest.query(
      `INSERT INTO tenant_subscriptions
         (id, tenant_id, plan_id, status, ends_at) VALUES
         ('${SUB1}', '${T1}', '${PLAN_STARTER}', 'active',
          now() + interval '15 days'),
         ('${SUB2}', '${T2}', '${PLAN_STARTER}', 'past_due',
          now() - interval '2 days'),
         ('${SUB3}', '${T3}', '${PLAN_STARTER}', 'active',
          now() - interval '1 day'),
         ('${SUB4}', '${T4}', '${PLAN_STARTER}', 'active',
          now() - interval '1 day')`,
    );

    appPool = poolFor(TEST_DB, { user: APP_ROLE, password: APP_PASSWORD });
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue(appPool)
      .overrideProvider(PaymentProviderFactory)
      .useValue(fakeFactory)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    ownerToken = await login(OWNER1_EMAIL);
    waiterToken = await login(WAITER1_EMAIL);
    owner2Token = await login(OWNER2_EMAIL, T2);
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await adminTest
      ?.query(`DROP ROLE IF EXISTS ${APP_ROLE}`)
      .catch(() => undefined);
    await adminTest?.end();
    await admin
      ?.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
      .catch(() => undefined);
    await admin.end();
  });

  beforeEach(() => {
    charges.length = 0;
    failingTenants.clear();
    fakeFactory.getProvider.mockClear();
  });

  it('returns the tenant subscription with its plan and period', async () => {
    const response = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Tenant-Id', T1);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      id: SUB1,
      tenantId: T1,
      status: 'active',
      plan: {
        id: PLAN_STARTER,
        name: 'starter',
        priceMonthly: 20,
      },
    });
  });

  it('refuses a waiter access to billing', async () => {
    const response = await request(app.getHttpServer())
      .get('/billing/subscription')
      .set('Authorization', `Bearer ${waiterToken}`)
      .set('X-Tenant-Id', T1);

    expect(response.status).toBe(403);
  });

  it('rejects an upgrade while past_due without charging', async () => {
    const response = await action(owner2Token, T2, {
      action: 'upgrade',
      planId: PLAN_PRO,
    });

    expect(response.status).toBe(400);
    expect(charges).toHaveLength(0);
    expect(fakeFactory.getProvider).not.toHaveBeenCalled();
  });

  it('upgrades mid-cycle, charges the prorated difference and mirrors tenants.plan_id', async () => {
    const response = await action(ownerToken, T1, {
      action: 'upgrade',
      planId: PLAN_PRO,
    });

    expect(response.status).toBe(200);
    // 15 days remain of a 30-day cycle: (50 - 20) * 15 / 30 = 15.
    expect(charges).toEqual([
      expect.objectContaining({ tenantId: T1, amount: 15 }),
    ]);
    expect(response.body).toMatchObject({
      action: 'upgrade',
      chargedAmount: 15,
      creditedAmount: 0,
      subscription: { plan: { id: PLAN_PRO } },
    });

    const tenant = await adminTest.query<{ plan_id: string }>(
      'SELECT plan_id FROM tenants WHERE id = $1',
      [T1],
    );
    expect(tenant.rows[0]?.plan_id).toBe(PLAN_PRO);

    const subscription = await adminTest.query<{ plan_id: string }>(
      'SELECT plan_id FROM tenant_subscriptions WHERE id = $1',
      [SUB1],
    );
    expect(subscription.rows[0]?.plan_id).toBe(PLAN_PRO);
  });

  it('renews due subscriptions, extending the successful one and marking the failed one past_due', async () => {
    failingTenants.add(T4);
    const before = await adminTest.query<{
      ends_at: Date;
      status: string;
    }>('SELECT ends_at, status FROM tenant_subscriptions WHERE id = $1', [
      SUB3,
    ]);

    const service = app.get(SubscriptionService);
    const summary = await service.renewDueSubscriptions(new Date());

    expect(summary.checked).toBe(4);
    expect(summary.renewed).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(2);
    expect(charges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tenantId: T3, amount: 20 }),
        expect.objectContaining({ tenantId: T4, amount: 20 }),
      ]),
    );

    const renewed = await adminTest.query<{
      ends_at: Date;
      status: string;
    }>('SELECT ends_at, status FROM tenant_subscriptions WHERE id = $1', [
      SUB3,
    ]);
    expect(renewed.rows[0]?.status).toBe('active');
    expect(renewed.rows[0]?.ends_at.getTime()).toBeGreaterThan(
      before.rows[0].ends_at.getTime(),
    );

    const failed = await adminTest.query<{ status: string }>(
      'SELECT status FROM tenant_subscriptions WHERE id = $1',
      [SUB4],
    );
    expect(failed.rows[0]?.status).toBe('past_due');
  });

  it('reports the plan catalogue cheapest first', async () => {
    const response = await request(app.getHttpServer())
      .get('/billing/plans')
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Tenant-Id', T1);

    expect(response.status).toBe(200);
    expect(
      (response.body as Array<{ name: string }>).map((plan) => plan.name),
    ).toEqual(['free', 'starter', 'pro']);
  });
});
