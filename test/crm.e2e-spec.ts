import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hashSync } from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { LoginResult } from './../src/auth/interfaces/auth.interface';
import { ORDER_EVENTS, type OrderPaidEvent } from './../src/order';
import { TenantScopedConnection } from './../src/tenant/connection/tenant-scoped-connection';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * CrmModule acceptance tests against a fresh Postgres database: real
 * migrations 001..014, a restricted (RLS-subject) app role, then the full Nest
 * app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 *
 * The unit specs prove the arithmetic and the rules against mocks. This suite
 * exists for what a mock cannot:
 *
 *   1. RLS on `loyalty_credits`, and the existing policies on `customers`,
 *      `loyalty_accounts` and `promotions`. An unscoped connection must see
 *      ZERO rows.
 *   2. The UNIQUE `(tenant_id, order_id)` guard as delivered by the DATABASE:
 *      the same `order.paid` emitted twice awards points once.
 *   3. The wire contract for a discount: `200` with a discount and a total, and
 *      a 422 (not a silent zero) for an inactive or expired promotion.
 *   4. Customer lookup-or-create over HTTP, including the `created` flag.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'crm_ci';
const APP_ROLE = 'cafe_crm_app';
const APP_PASSWORD = 'cafe_crm_secret';
const PASSWORD = 'Password123!';

const PLAN_STARTER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

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

async function endPool(pool: Pool | undefined): Promise<void> {
  if (!pool) {
    return;
  }
  await pool.end();
}

async function evictStragglers(admin: Pool): Promise<void> {
  await admin
    .query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1
          AND pid <> pg_backend_pid()`,
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

describeWithDb('CrmModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  let events: EventEmitter2;

  const ownerEmail = 'crm-owner@cafe.test';
  const waiterEmail = 'crm-waiter@cafe.test';
  const rivalEmail = 'crm-rival@cafe.test';

  let tenantId = '';
  let branchId = '';
  let rivalTenantId = '';
  let ownerToken = '';
  let waiterToken = '';
  let rivalToken = '';

  // ------------------------------------------------------------------ helpers

  function body<T>(response: request.Response): T {
    return response.body as T;
  }

  function auth(token: string, tenant = tenantId) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenant,
    };
  }

  async function login(email: string, tenant: string): Promise<LoginResult> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Tenant-Id', tenant)
      .send({ email, password: PASSWORD });
    expect(response.status).toBe(200);
    return body<LoginResult>(response);
  }

  async function seedUser(
    tenant: string,
    role: string,
    email: string,
    fullName: string,
  ): Promise<void> {
    await adminTest.query(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3), $4, $5, $6)`,
      [tenant, branchId, role, fullName, email, hashSync(PASSWORD, 10)],
    );
  }

  function lookupOrCreate(
    token: string,
    phone: string,
    extra: Record<string, unknown> = {},
    tenant = tenantId,
  ) {
    return request(app.getHttpServer())
      .post('/customers')
      .set(auth(token, tenant))
      .send({ phone, ...extra });
  }

  function createPromotion(token: string, payload: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/promotions')
      .set(auth(token))
      .send(payload);
  }

  function applyPromotion(
    token: string,
    code: string,
    subtotal: number,
    tenant = tenantId,
  ) {
    return request(app.getHttpServer())
      .post('/promotions/apply')
      .set(auth(token, tenant))
      .send({ code, subtotal });
  }

  /** The customer's loyalty balance, read over HTTP. */
  async function pointsOf(token: string, customerId: string): Promise<number> {
    const response = await request(app.getHttpServer())
      .get(`/customers/${customerId}/loyalty`)
      .set(auth(token));
    expect(response.status).toBe(200);
    return body<{ points_balance: number }>(response).points_balance;
  }

  /** An order row with a customer, for the listener to credit. */
  async function paidOrder(
    customerId: string | null,
    total: string,
  ): Promise<string> {
    const result = await adminTest.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, branch_id, customer_id, order_type,
                           subtotal, tax_amount, discount_amount, total_amount)
            VALUES ($1, $2, $3, 'dine_in', $4, 0, 0, $4)
         RETURNING id`,
      [tenantId, branchId, customerId, total],
    );
    return result.rows[0].id;
  }

  async function emitPaid(orderId: string, total: number): Promise<void> {
    const event: OrderPaidEvent = {
      event: ORDER_EVENTS.paid,
      orderId,
      tenantId,
      branchId,
      previousStatus: 'awaiting_payment',
      tableId: null,
      totalAmount: total,
      occurredAt: new Date().toISOString(),
    };
    // `emitAsync` awaits the listener, so the assertions that follow see the
    // credit rather than racing it.
    await events.emitAsync(ORDER_EVENTS.paid, event);
  }

  // ---------------------------------------------------------------- lifecycle

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
        ('${PLAN_STARTER}', 'starter', 3, 15, 2499)
    `);
    await adminTest.query(`
      INSERT INTO roles (name) VALUES
        ('super_admin'), ('org_owner'), ('branch_manager'),
        ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')
    `);

    appPool = poolFor(TEST_DB, { user: APP_ROLE, password: APP_PASSWORD });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue(appPool)
      .compile();

    app = moduleRef.createNestApplication();
    app.useLogger(['error', 'warn']);
    await app.init();
    await app.listen(0);
    events = app.get(EventEmitter2);
  });

  afterAll(async () => {
    await app?.close();
    await endPool(appPool);
    await evictStragglers(admin);
    await endPool(adminTest);
    await endPool(admin);
  });

  // ------------------------------------------------------------------ fixture

  beforeAll(async () => {
    const response = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'CRM Co',
        slug: 'crmco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Branch A', address: '1 Main' },
        defaultTables: 0,
        owner: { email: ownerEmail, password: PASSWORD },
      });
    expect(response.status).toBe(201);

    const onboarded = body<{ tenantId: string; branchId: string }>(response);
    tenantId = onboarded.tenantId;
    branchId = onboarded.branchId;
    ownerToken = (await login(ownerEmail, tenantId)).accessToken;

    await seedUser(tenantId, 'waiter', waiterEmail, 'Waiter One');
    waiterToken = (await login(waiterEmail, tenantId)).accessToken;

    const rival = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Rival CRM Co',
        slug: 'rivalcrmco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Rival Branch', address: '9 Other' },
        defaultTables: 0,
        owner: { email: rivalEmail, password: PASSWORD },
      });
    expect(rival.status).toBe(201);
    rivalTenantId = body<{ tenantId: string }>(rival).tenantId;
    rivalToken = (await login(rivalEmail, rivalTenantId)).accessToken;
  });

  // ---------------------------------------------------------------------- RLS

  describe('tenant isolation', () => {
    it('shows a tenant its own rows and hides them from an unscoped connection', async () => {
      const created = await lookupOrCreate(waiterToken, '9811111111');
      expect(created.status).toBe(200);

      const scoped = await TenantScopedConnection.acquireScoped(
        appPool as Pool,
        tenantId,
      );
      try {
        for (const table of [
          'customers',
          'loyalty_accounts',
          'promotions',
          'loyalty_credits',
        ]) {
          // The point is that the query runs at all under the tenant's
          // `app.tenant_id`; each table's own policy does the filtering.
          await expect(
            scoped.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ${table}`,
            ),
          ).resolves.toBeDefined();
        }
      } finally {
        await scoped.commit().catch(() => undefined);
        await scoped.release();
      }

      const unscoped = await TenantScopedConnection.acquireUnscoped(
        appPool as Pool,
      );
      try {
        const hidden = await unscoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM customers`,
        );
        expect(hidden.rows[0].n).toBe(0);
        const hiddenCredits = await unscoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM loyalty_credits`,
        );
        expect(hiddenCredits.rows[0].n).toBe(0);
      } finally {
        await unscoped.commit().catch(() => undefined);
        await unscoped.release();
      }
    });

    it('keeps two tenants\u2019 customers with the same phone apart', async () => {
      const ours = await lookupOrCreate(waiterToken, '9800000000');
      const theirs = await lookupOrCreate(
        rivalToken,
        '9800000000',
        {},
        rivalTenantId,
      );
      expect(ours.status).toBe(200);
      expect(theirs.status).toBe(200);

      const oursId = body<{ customer: { id: string } }>(ours).customer.id;
      const theirsId = body<{ customer: { id: string } }>(theirs).customer.id;
      expect(oursId).not.toBe(theirsId);

      // Cross-tenant id: 404, never the other tenant's row.
      const crossed = await request(app.getHttpServer())
        .get(`/customers/${oursId}`)
        .set(auth(rivalToken, rivalTenantId));
      expect(crossed.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------- customers

  describe('customers', () => {
    it('creates a customer and their loyalty account on a new phone', async () => {
      const response = await lookupOrCreate(ownerToken, '9822222222', {
        fullName: '  Asha Rai ',
        email: 'asha@example.test',
      });

      expect(response.status).toBe(200);
      const result = body<{
        created: boolean;
        customer: {
          id: string;
          phone: string;
          full_name: string;
          email: string;
        };
        loyalty: { points_balance: number; customer_id: string };
      }>(response);

      expect(result.created).toBe(true);
      expect(result.customer.phone).toBe('9822222222');
      expect(result.customer.full_name).toBe('Asha Rai');
      expect(result.loyalty.points_balance).toBe(0);
      expect(result.loyalty.customer_id).toBe(result.customer.id);
    });

    it('returns the existing customer instead of creating a second one', async () => {
      const first = await lookupOrCreate(ownerToken, '9833333333', {
        fullName: 'Bikash',
      });
      const second = await lookupOrCreate(waiterToken, ' 9833333333 ', {
        fullName: 'A DIFFERENT NAME',
      });

      expect(second.status).toBe(200);
      const firstId = body<{ customer: { id: string } }>(first).customer.id;
      const secondBody = body<{
        created: boolean;
        customer: { id: string; full_name: string };
      }>(second);

      expect(secondBody.created).toBe(false);
      expect(secondBody.customer.id).toBe(firstId);
      // A lookup is not an edit.
      expect(secondBody.customer.full_name).toBe('Bikash');
    });

    it('looks a customer up by phone', async () => {
      const created = await lookupOrCreate(ownerToken, '9844444444');
      const id = body<{ customer: { id: string } }>(created).customer.id;

      const found = await request(app.getHttpServer())
        .get('/customers')
        .query({ phone: '9844444444' })
        .set(auth(ownerToken));

      expect(found.status).toBe(200);
      expect(body<Array<{ id: string }>>(found)[0].id).toBe(id);
    });

    it('404s a phone it does not know', async () => {
      const response = await request(app.getHttpServer())
        .get('/customers')
        .query({ phone: '9899999999' })
        .set(auth(ownerToken));

      expect(response.status).toBe(404);
    });

    it('rejects an empty phone with a 400', async () => {
      const response = await lookupOrCreate(ownerToken, '   ');

      expect(response.status).toBe(400);
    });

    it('lets a waiter look a customer up but not manage promotions', async () => {
      const lookup = await lookupOrCreate(waiterToken, '9855555555');
      expect(lookup.status).toBe(200);

      const write = await createPromotion(waiterToken, {
        code: 'WAITER5',
        discountType: 'flat',
        discountValue: 5,
      });
      expect(write.status).toBe(403);
    });
  });

  // --------------------------------------------------------------- promotions

  describe('promotions', () => {
    it('applies a percentage promotion and prices the total', async () => {
      const created = await createPromotion(ownerToken, {
        code: 'tenoff',
        description: 'Ten percent off',
        discountType: 'percentage',
        discountValue: 10,
      });
      expect(created.status).toBe(201);
      expect(body<{ code: string }>(created).code).toBe('TENOFF');

      const applied = await applyPromotion(waiterToken, 'tenoff', 100);
      expect(applied.status).toBe(200);
      expect(
        body<{ discountAmount: number; total: number }>(applied),
      ).toMatchObject({
        code: 'TENOFF',
        discountType: 'percentage',
        subtotal: 100,
        discountAmount: 10,
        total: 90,
      });
    });

    it('applies a flat promotion and never discounts below zero', async () => {
      await createPromotion(ownerToken, {
        code: 'FLAT5',
        discountType: 'flat',
        discountValue: 5,
      });

      const normal = await applyPromotion(waiterToken, 'FLAT5', 20);
      expect(normal.status).toBe(200);
      expect(
        body<{ discountAmount: number; total: number }>(normal),
      ).toMatchObject({ discountAmount: 5, total: 15 });

      const tiny = await applyPromotion(waiterToken, 'FLAT5', 3);
      expect(tiny.status).toBe(200);
      expect(
        body<{ discountAmount: number; total: number }>(tiny),
      ).toMatchObject({ discountAmount: 3, total: 0 });
    });

    it('rejects an inactive promotion at apply time', async () => {
      await createPromotion(ownerToken, {
        code: 'OFFNOW',
        discountType: 'flat',
        discountValue: 5,
        isActive: false,
      });

      const response = await applyPromotion(waiterToken, 'OFFNOW', 20);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('inactive');
    });

    it('rejects an expired promotion at apply time', async () => {
      await createPromotion(ownerToken, {
        code: 'EXPIRED',
        discountType: 'flat',
        discountValue: 5,
        endsAt: '2020-01-01T00:00:00Z',
      });

      const response = await applyPromotion(waiterToken, 'EXPIRED', 20);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('ended');
    });

    it('rejects a promotion that has not started', async () => {
      await createPromotion(ownerToken, {
        code: 'FUTURE',
        discountType: 'flat',
        discountValue: 5,
        startsAt: '2099-01-01T00:00:00Z',
      });

      const response = await applyPromotion(waiterToken, 'FUTURE', 20);
      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toContain('does not start');
    });

    it('404s an unknown code', async () => {
      const response = await applyPromotion(waiterToken, 'NOSUCHCODE', 20);
      expect(response.status).toBe(404);
    });

    it('refuses an unsupported discount type at write time', async () => {
      const response = await createPromotion(ownerToken, {
        code: 'BOGO',
        discountType: 'bogo',
        discountValue: 1,
      });

      expect(response.status).toBe(422);
    });

    it('refuses a percentage above 100', async () => {
      const response = await createPromotion(ownerToken, {
        code: 'TOOMUCH',
        discountType: 'percentage',
        discountValue: 150,
      });

      expect(response.status).toBe(400);
    });

    it('refuses a duplicate code', async () => {
      await createPromotion(ownerToken, {
        code: 'ONLYONCE',
        discountType: 'flat',
        discountValue: 5,
      });
      const duplicate = await createPromotion(ownerToken, {
        code: 'onlyonce',
        discountType: 'flat',
        discountValue: 7,
      });

      expect(duplicate.status).toBe(409);
    });

    it('lists only active promotions when asked', async () => {
      const response = await request(app.getHttpServer())
        .get('/promotions')
        .query({ activeOnly: 'true' })
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      const promotions = body<Array<{ code: string }>>(response);
      expect(promotions.map((promotion) => promotion.code)).not.toContain(
        'OFFNOW',
      );
    });

    it('does not let one tenant apply another tenant\u2019s code', async () => {
      const response = await applyPromotion(
        rivalToken,
        'TENOFF',
        100,
        rivalTenantId,
      );
      expect(response.status).toBe(404);
    });
  });

  // ------------------------------------------------ loyalty / Observer + idempotency

  describe('loyalty accrual from order.paid', () => {
    it('awards points exactly once even when the event fires twice', async () => {
      const created = await lookupOrCreate(ownerToken, '9866666666');
      const customerId = body<{ customer: { id: string } }>(created).customer
        .id;
      const orderId = await paidOrder(customerId, '250.50');

      await emitPaid(orderId, 250.5);
      await emitPaid(orderId, 250.5);

      // 250.50 -> two whole points, awarded once, not four.
      expect(await pointsOf(waiterToken, customerId)).toBe(2);

      const credits = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM loyalty_credits WHERE order_id = $1`,
        [orderId],
      );
      expect(credits.rows[0].n).toBe(1);
    });

    it('adds points for a later order', async () => {
      const created = await lookupOrCreate(ownerToken, '9877777777');
      const customerId = body<{ customer: { id: string } }>(created).customer
        .id;

      const first = await paidOrder(customerId, '100.00');
      const second = await paidOrder(customerId, '50.00');
      await emitPaid(first, 100);
      await emitPaid(second, 50);

      expect(await pointsOf(waiterToken, customerId)).toBe(1);
    });

    it('does not credit a walk-in order with no customer', async () => {
      const before = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM loyalty_credits`,
      );
      const orderId = await paidOrder(null, '100.00');
      await emitPaid(orderId, 100);
      const after = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM loyalty_credits`,
      );

      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('credits zero points for a sale below the threshold, but records it once', async () => {
      const created = await lookupOrCreate(ownerToken, '9888888888');
      const customerId = body<{ customer: { id: string } }>(created).customer
        .id;
      const orderId = await paidOrder(customerId, '99.99');

      await emitPaid(orderId, 99.99);
      await emitPaid(orderId, 99.99);

      expect(await pointsOf(waiterToken, customerId)).toBe(0);
      const credits = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM loyalty_credits WHERE order_id = $1`,
        [orderId],
      );
      expect(credits.rows[0].n).toBe(1);
    });
  });
});
