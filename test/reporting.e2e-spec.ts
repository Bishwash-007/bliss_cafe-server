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
import { PLATFORM_POOL } from './../src/reporting/platform-pool.provider';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * ReportingModule acceptance tests against a fresh Postgres database: real
 * migrations, a restricted (RLS-subject) app role, then the full Nest app.
 *
 * The unit specs cover the template method and the exporters. This suite exists
 * for what a mock cannot prove:
 *
 *   1. the aggregation SQL returns the same revenue a manual sum of the seeded
 *      orders does;
 *   2. inventory consumption is branch-scoped and ignores purchases,
 *      adjustments and other branches;
 *   3. staff performance joins orders, shifts and attendance correctly;
 *   4. the platform report spans tenants (on a role that bypasses RLS) and is
 *      refused to every non-`super_admin` role.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'reporting_ci';
const APP_ROLE = 'cafe_reporting_app';
const APP_PASSWORD = 'cafe_reporting_secret';
const PASSWORD = 'Password123!';

const PLAN_FREE = 'f0000000-0000-4000-8000-000000000001';
const PLAN_PRO = 'f0000000-0000-4000-8000-000000000002';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const T3 = '33333333-3333-4333-8333-333333333333';

const B1 = 'b1111111-1111-4111-8111-111111111111';
const B2 = 'b2222222-2222-4222-8222-222222222222';
const B3 = 'b3333333-3333-4333-8333-333333333333';

const OWNER1 = 'a1111111-1111-4111-8111-111111111111';
const WAITER1 = 'a2222222-2222-4222-8222-222222222222';
const MANAGER1 = 'a3333333-3333-4333-8333-333333333333';
const OWNER2 = 'a4444444-4444-4444-8444-444444444444';
const ROOT = 'a5555555-5555-4555-8555-555555555555';

const M1 = 'c1111111-1111-4111-8111-111111111111';
const M2 = 'c2222222-2222-4222-8222-222222222222';

const I1 = 'd1111111-1111-4111-8111-111111111111';
const I2 = 'd2222222-2222-4222-8222-222222222222';
const I3 = 'd3333333-3333-4333-8333-333333333333';
const I4 = 'd4444444-4444-4444-8444-444444444444';

const S1 = 'e1111111-1111-4111-8111-111111111111';
const S2 = 'e2222222-2222-4222-8222-222222222222';
const S3 = 'e3333333-3333-4333-8333-333333333333';
const S4 = 'e4444444-4444-4444-8444-444444444444';
const A1 = 'e7777777-7777-4777-8777-777777777777';
const A2 = 'e8888888-8888-4888-8888-888888888888';
const A3 = 'e9999999-9999-4999-8999-999999999999';

const OWNER1_EMAIL = 'report-owner@cafe.test';
const WAITER1_EMAIL = 'report-waiter@cafe.test';
const MANAGER1_EMAIL = 'report-manager@cafe.test';
const ROOT_EMAIL = 'report-root@cafe.test';

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

interface ReportBody {
  type: string;
  title: string;
  branchId: string | null;
  range: { from: string; to: string } | null;
  summary: Record<string, number>;
  tables: Array<{
    key: string;
    rows: Array<Record<string, unknown>>;
    totals?: Record<string, unknown>;
  }>;
}

describeWithDb('ReportingModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  const hash = hashSync(PASSWORD, 10);

  let ownerToken = '';
  let waiterToken = '';
  let managerToken = '';
  let rootToken = '';

  function body<T>(response: request.Response): T {
    return response.body as T;
  }

  async function login(
    email: string,
    tenant = T1,
  ): Promise<{ status: number; body: Partial<LoginResult> }> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Tenant-Id', tenant)
      .send({ email, password: PASSWORD });
    return {
      status: response.status,
      body: body<Partial<LoginResult>>(response),
    };
  }

  function getReport(
    token: string,
    branchId: string,
    report: string,
    params: Record<string, string> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .get(`/branches/${branchId}/reports/${report}`)
      .query({ from: '2026-01-10', to: '2026-01-11', ...params })
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', T1);
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
        ('${PLAN_PRO}', 'pro', 10, 100, 99)
    `);
    await adminTest.query(`
      INSERT INTO roles (name) VALUES
        ('super_admin'), ('org_owner'), ('branch_manager'),
        ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')
    `);
    await adminTest.query(
      `INSERT INTO tenants (id, slug, name, plan_id, status) VALUES
         ('${T1}', 'report-one', 'Report One', '${PLAN_PRO}', 'active'),
         ('${T2}', 'report-two', 'Report Two', '${PLAN_FREE}', 'active'),
         ('${T3}', 'report-three', 'Report Three', '${PLAN_PRO}', 'suspended')`,
    );
    await adminTest.query(
      `INSERT INTO branches (id, tenant_id, name) VALUES
         ('${B1}', '${T1}', 'One Main'),
         ('${B2}', '${T1}', 'One Second'),
         ('${B3}', '${T2}', 'Two Main')`,
    );

    const userInsert = (
      id: string,
      tenant: string,
      branch: string | null,
      role: string,
      name: string,
      email: string,
    ) =>
      adminTest.query(
        `INSERT INTO users
           (id, tenant_id, branch_id, role_id, full_name, email, password_hash)
         VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = $4), $5, $6, $7)`,
        [id, tenant, branch, role, name, email, hash],
      );

    await userInsert(OWNER1, T1, B1, 'org_owner', 'Owner One', OWNER1_EMAIL);
    await userInsert(WAITER1, T1, B1, 'waiter', 'Waiter One', WAITER1_EMAIL);
    await userInsert(
      MANAGER1,
      T1,
      B2,
      'branch_manager',
      'Manager One',
      MANAGER1_EMAIL,
    );
    await userInsert(
      OWNER2,
      T2,
      B3,
      'org_owner',
      'Owner Two',
      'report-owner2@cafe.test',
    );
    await userInsert(ROOT, T1, null, 'super_admin', 'Root Admin', ROOT_EMAIL);

    await adminTest.query(
      `INSERT INTO menu_items (id, tenant_id, branch_id, name, price) VALUES
         ('${M1}', '${T1}', '${B1}', 'Flat White', 3.5),
         ('${M2}', '${T2}', '${B3}', 'Tea', 2)`,
    );

    const orderInsert = (
      id: string,
      tenant: string,
      branch: string,
      createdBy: string,
      orderType: string,
      status: string,
      subtotal: number,
      tax: number,
      total: number,
      createdAt: string,
    ) =>
      adminTest.query(
        `INSERT INTO orders
           (id, tenant_id, branch_id, created_by, order_type, status,
            subtotal, tax_amount, discount_amount, total_amount, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, $9, $10)`,
        [
          id,
          tenant,
          branch,
          createdBy,
          orderType,
          status,
          subtotal,
          tax,
          total,
          createdAt,
        ],
      );

    await orderInsert(
      '01000000-0000-4000-8000-000000000001',
      T1,
      B1,
      WAITER1,
      'dine_in',
      'paid',
      28,
      2,
      30,
      '2026-01-10T12:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000002',
      T1,
      B1,
      WAITER1,
      'takeaway',
      'completed',
      20.5,
      0,
      20.5,
      '2026-01-11T09:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000003',
      T1,
      B1,
      WAITER1,
      'dine_in',
      'cancelled',
      99,
      0,
      99,
      '2026-01-11T10:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000004',
      T1,
      B1,
      WAITER1,
      'dine_in',
      'paid',
      15,
      0,
      15,
      '2026-01-12T10:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000005',
      T1,
      B2,
      OWNER1,
      'dine_in',
      'paid',
      100,
      0,
      100,
      '2026-01-10T10:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000006',
      T1,
      B1,
      OWNER1,
      'dine_in',
      'paid',
      40,
      0,
      40,
      '2026-02-01T10:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000007',
      T1,
      B1,
      WAITER1,
      'dine_in',
      'served',
      12,
      0,
      12,
      '2026-01-10T15:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000008',
      T2,
      B3,
      OWNER2,
      'dine_in',
      'paid',
      50,
      0,
      50,
      '2026-01-10T11:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000009',
      T2,
      B3,
      OWNER2,
      'takeaway',
      'completed',
      25,
      0,
      25,
      '2026-01-11T11:00:00Z',
    );
    await orderInsert(
      '01000000-0000-4000-8000-000000000010',
      T2,
      B3,
      OWNER2,
      'dine_in',
      'cancelled',
      70,
      0,
      70,
      '2026-01-11T12:00:00Z',
    );

    await adminTest.query(
      `INSERT INTO order_items
         (tenant_id, order_id, menu_item_id, quantity, unit_price)
       VALUES
         ('${T1}', '01000000-0000-4000-8000-000000000001', '${M1}', 2, 14),
         ('${T1}', '01000000-0000-4000-8000-000000000002', '${M1}', 1, 20.5),
         ('${T1}', '01000000-0000-4000-8000-000000000003', '${M1}', 5, 19.8),
         ('${T1}', '01000000-0000-4000-8000-000000000007', '${M1}', 1, 12),
         ('${T2}', '01000000-0000-4000-8000-000000000008', '${M2}', 1, 50)`,
    );

    await adminTest.query(
      `INSERT INTO inventory_items (id, tenant_id, branch_id, name, unit) VALUES
         ('${I1}', '${T1}', '${B1}', 'Beans', 'kg'),
         ('${I2}', '${T1}', '${B1}', 'Milk', 'l'),
         ('${I3}', '${T1}', '${B2}', 'Tea', 'kg'),
         ('${I4}', '${T2}', '${B3}', 'Beans', 'kg')`,
    );

    const movement = (
      tenant: string,
      item: string,
      type: string,
      quantity: number,
      createdAt: string,
    ) =>
      adminTest.query(
        `INSERT INTO stock_movements
           (tenant_id, inventory_item_id, movement_type, quantity, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenant, item, type, quantity, createdAt],
      );

    await movement(T1, I1, 'purchase', 5, '2026-01-09T10:00:00Z');
    await movement(T1, I1, 'usage', -2, '2026-01-10T10:00:00Z');
    await movement(T1, I1, 'wastage', -0.5, '2026-01-11T10:00:00Z');
    await movement(T1, I2, 'usage', -3, '2026-01-10T11:00:00Z');
    await movement(T1, I2, 'adjustment', 1, '2026-01-10T12:00:00Z');
    await movement(T1, I3, 'usage', -9, '2026-01-10T10:00:00Z');
    await movement(T1, I1, 'usage', -4, '2026-01-12T10:00:00Z');
    await movement(T2, I4, 'usage', -7, '2026-01-10T10:00:00Z');

    await adminTest.query(
      `INSERT INTO shifts (id, tenant_id, branch_id, user_id, start_time, end_time)
       VALUES
         ('${S1}', '${T1}', '${B1}', '${WAITER1}',
          '2026-01-10T08:00:00Z', '2026-01-10T16:00:00Z'),
         ('${S2}', '${T1}', '${B1}', '${WAITER1}',
          '2026-01-11T08:00:00Z', '2026-01-11T12:00:00Z'),
         ('${S3}', '${T1}', '${B1}', '${WAITER1}',
          '2026-01-11T13:00:00Z', '2026-01-11T17:00:00Z'),
         ('${S4}', '${T1}', '${B2}', '${MANAGER1}',
          '2026-01-10T08:00:00Z', '2026-01-10T16:00:00Z')`,
    );
    await adminTest.query(
      `INSERT INTO attendance_records
         (id, tenant_id, shift_id, clock_in, clock_out) VALUES
         ('${A1}', '${T1}', '${S1}', '2026-01-10T08:05:00Z',
          '2026-01-10T16:05:00Z'),
         ('${A2}', '${T1}', '${S2}', '2026-01-11T08:00:00Z',
          '2026-01-11T12:00:00Z'),
         ('${A3}', '${T1}', '${S3}', '2026-01-11T13:00:00Z', NULL)`,
    );

    appPool = poolFor(TEST_DB, { user: APP_ROLE, password: APP_PASSWORD });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue(appPool)
      // The real platform pool would use a BYPASSRLS role. In this harness the
      // migration owner plays that role, so the cross-tenant query is tested
      // rather than skipped.
      .overrideProvider(PLATFORM_POOL)
      .useValue(adminTest)
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    const owner = await login(OWNER1_EMAIL);
    expect(owner.status).toBe(200);
    ownerToken = owner.body.accessToken ?? '';
    expect(owner.body.user).toMatchObject({ role: 'org_owner' });

    const waiter = await login(WAITER1_EMAIL);
    expect(waiter.status).toBe(200);
    waiterToken = waiter.body.accessToken ?? '';

    const manager = await login(MANAGER1_EMAIL);
    expect(manager.status).toBe(200);
    managerToken = manager.body.accessToken ?? '';

    const root = await login(ROOT_EMAIL);
    expect(root.status).toBe(200);
    rootToken = root.body.accessToken ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await evictStragglers(admin);
    await adminTest?.end();
    await admin.end();
  });

  describe('sales report', () => {
    it('reconciles with the manually summed paid/completed orders', async () => {
      const response = await getReport(ownerToken, B1, 'sales');

      expect(response.status).toBe(200);
      const report = body<ReportBody>(response);
      expect(report.type).toBe('sales');
      expect(report.branchId).toBe(B1);
      expect(report.range).toEqual({ from: '2026-01-10', to: '2026-01-11' });
      expect(report.summary).toMatchObject({
        orderCount: 2,
        itemCount: 3,
        subtotal: 48.5,
        tax: 2,
        revenue: 50.5,
        averageOrderValue: 25.25,
      });

      // The same figure computed independently from the seeded fixture:
      // 30.00 (O1, paid) + 20.50 (O2, completed). Cancelled and served orders,
      // the next day, and the other branch are all excluded.
      const manual = 30 + 20.5;
      expect(report.summary.revenue).toBe(manual);

      const daily = report.tables.find((table) => table.key === 'daily');
      expect(daily?.rows).toEqual([
        { date: '2026-01-10', orderCount: 1, revenue: 30 },
        { date: '2026-01-11', orderCount: 1, revenue: 20.5 },
      ]);
      expect(daily?.totals).toEqual({
        date: 'TOTAL',
        orderCount: 2,
        revenue: 50.5,
      });

      const types = report.tables.find((table) => table.key === 'order-types');
      expect(types?.rows).toEqual([
        { orderType: 'dine_in', orderCount: 1, revenue: 30 },
        { orderType: 'takeaway', orderCount: 1, revenue: 20.5 },
      ]);
    });

    it('exports the same report as CSV and PDF', async () => {
      const csv = await getReport(ownerToken, B1, 'sales', { format: 'csv' });
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toContain('text/csv');
      expect(csv.headers['content-disposition']).toContain('.csv');
      expect(csv.text).toContain('Revenue by day');
      expect(csv.text).toContain('TOTAL,2,50.5');

      const pdf = await getReport(ownerToken, B1, 'sales', { format: 'pdf' });
      expect(pdf.status).toBe(200);
      expect(pdf.headers['content-type']).toContain('application/pdf');
      expect(pdf.headers['content-disposition']).toContain('.pdf');
      expect(Buffer.from(pdf.body).subarray(0, 5).toString()).toBe('%PDF-');
    });

    it('rejects a missing or malformed date range', async () => {
      const missing = await request(app.getHttpServer())
        .get(`/branches/${B1}/reports/sales`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', T1);
      expect(missing.status).toBe(400);

      const bad = await getReport(ownerToken, B1, 'sales', {
        to: '2026-02-31',
      });
      expect(bad.status).toBe(400);
    });
  });

  describe('inventory consumption report', () => {
    it('aggregates usage and wastage for the branch only', async () => {
      const response = await getReport(ownerToken, B1, 'inventory-consumption');

      expect(response.status).toBe(200);
      const report = body<ReportBody>(response);
      expect(report.summary).toMatchObject({
        itemCount: 2,
        usageQuantity: 5,
        wastageQuantity: 0.5,
        consumedQuantity: 5.5,
        movementCount: 3,
      });

      const items = report.tables.find((table) => table.key === 'items');
      expect(items?.rows).toEqual([
        {
          inventoryItemId: I1,
          name: 'Beans',
          unit: 'kg',
          usageQuantity: 2,
          wastageQuantity: 0.5,
          consumedQuantity: 2.5,
          movementCount: 2,
        },
        {
          inventoryItemId: I2,
          name: 'Milk',
          unit: 'l',
          usageQuantity: 3,
          wastageQuantity: 0,
          consumedQuantity: 3,
          movementCount: 1,
        },
      ]);
    });
  });

  describe('staff performance report', () => {
    it('joins sales and attendance per staff member', async () => {
      const response = await getReport(ownerToken, B1, 'staff-performance');

      expect(response.status).toBe(200);
      const report = body<ReportBody>(response);
      expect(report.summary).toMatchObject({
        staffCount: 2,
        orderCount: 2,
        revenue: 50.5,
        shiftsScheduled: 3,
        shiftsAttended: 3,
        hoursWorked: 12,
        openShifts: 1,
        salesPerHour: 4.21,
      });

      const staff = report.tables.find((table) => table.key === 'staff');
      const waiter = staff?.rows.find((row) => row.userId === WAITER1);
      expect(waiter).toMatchObject({
        fullName: 'Waiter One',
        role: 'waiter',
        orderCount: 2,
        revenue: 50.5,
        shiftsScheduled: 3,
        shiftsAttended: 3,
        hoursWorked: 12,
        salesPerHour: 4.21,
        openShifts: 1,
      });

      const owner = staff?.rows.find((row) => row.userId === OWNER1);
      expect(owner).toMatchObject({
        orderCount: 0,
        revenue: 0,
        shiftsScheduled: 0,
        hoursWorked: 0,
      });
    });
  });

  describe('authorization', () => {
    it('lets a branch manager read only their own branch', async () => {
      const own = await getReport(managerToken, B2, 'sales');
      expect(own.status).toBe(200);

      const other = await getReport(managerToken, B1, 'sales');
      expect(other.status).toBe(403);
    });

    it('refuses report access to a waiter', async () => {
      const response = await getReport(waiterToken, B1, 'sales');
      expect(response.status).toBe(403);
    });
  });

  describe('platform report', () => {
    async function platformOverview(
      token: string,
      params: Record<string, string> = {},
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .get('/platform/reports/overview')
        .query(params)
        .set('Authorization', `Bearer ${token}`);
    }

    it('aggregates every tenant, including suspended tenant counts', async () => {
      const response = await platformOverview(rootToken);

      expect(response.status).toBe(200);
      const report = body<ReportBody>(response);
      expect(report.type).toBe('platform-overview');
      expect(report.summary).toEqual({
        activeTenantCount: 2,
        tenantCount: 3,
        planTierCount: 2,
        totalOrderVolume: 8,
        totalRevenue: 280.5,
      });

      const tiers = report.tables.find((table) => table.key === 'plan-tiers');
      expect(tiers?.rows).toEqual([
        {
          planTier: 'free',
          tenantCount: 1,
          activeTenantCount: 1,
          orderCount: 2,
          revenue: 75,
        },
        {
          planTier: 'pro',
          tenantCount: 2,
          activeTenantCount: 1,
          orderCount: 6,
          revenue: 205.5,
        },
      ]);
    });

    it('honours an optional date range', async () => {
      const response = await platformOverview(rootToken, {
        from: '2026-01-10',
        to: '2026-01-11',
      });

      expect(response.status).toBe(200);
      const report = body<ReportBody>(response);
      expect(report.range).toEqual({ from: '2026-01-10', to: '2026-01-11' });
      expect(report.summary.totalOrderVolume).toBe(6);
      expect(report.summary.totalRevenue).toBe(225.5);
    });

    it('is inaccessible to non-super-admin roles', async () => {
      for (const token of [ownerToken, managerToken, waiterToken]) {
        const response = await platformOverview(token);
        expect(response.status).toBe(403);
      }
    });
  });
});
