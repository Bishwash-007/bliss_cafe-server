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
import { TenantScopedConnection } from './../src/tenant/connection/tenant-scoped-connection';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * StaffModule acceptance tests against a fresh Postgres database: real
 * migrations 001..013, a restricted (RLS-subject) app role, then the full Nest
 * app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 *
 * The unit specs cover the decision rules against mocks. This one exists for
 * what a mock cannot prove:
 *
 *   1. RLS on the three new tables — `shifts`, `attendance_records` and
 *      `staff_wage_rates`. A query without `app.tenant_id` must return ZERO
 *      rows, not everybody's.
 *   2. the clock-in window as an HTTP contract — a 400, and the message names
 *      the shift, the clock-in and the window.
 *   3. the database CHECK that stops a clock-out before its clock-in, as the
 *      backstop behind the service's own refusal.
 *   4. the UNIQUE index that makes "one attendance record per shift" a fact
 *      rather than a convention.
 *   5. the CSV export — real rows, and a total that adds up.
 *   6. the cascade: deleting a shift deletes the hours recorded against it.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'staff_ci';
const APP_ROLE = 'cafe_staff_app';
const APP_PASSWORD = 'cafe_staff_secret';
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

/** Today in UTC, `YYYY-MM-DD`. */
function day(offsetDays = 0): string {
  return new Date(Date.now() + offsetDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * A pay period that certainly contains "now".
 *
 * Yesterday to tomorrow, rather than today to today: a suite that runs across
 * UTC midnight would otherwise put the attendance record outside its own pay
 * period and the payroll would come back empty.
 */
function period(): { from: string; to: string } {
  return { from: day(-1), to: day(1) };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describeWithDb('StaffModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;

  const ownerEmail = 'staff-owner@cafe.test';
  const managerAEmail = 'staff-manager-a@cafe.test';
  const managerBEmail = 'staff-manager-b@cafe.test';
  const waiterAEmail = 'staff-waiter-a@cafe.test';
  const waiterBEmail = 'staff-waiter-b@cafe.test';
  const rivalEmail = 'staff-rival@cafe.test';

  let tenantId = '';
  let branchA = '';
  let branchB = '';
  let rivalTenantId = '';

  let ownerToken = '';
  let managerAToken = '';
  let managerBToken = '';
  let waiterAToken = '';
  let waiterBToken = '';

  let waiterAId = '';
  let waiterBId = '';

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

  /** Seeds a staff member. There is no HTTP route to create one — see the module barrel. */
  async function seedUser(
    tenant: string,
    branchId: string | null,
    role: string,
    email: string,
    fullName: string,
  ): Promise<string> {
    const result = await adminTest.query<{ id: string }>(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3), $4, $5, $6)
       RETURNING id`,
      [tenant, branchId, role, fullName, email, hashSync(PASSWORD, 10)],
    );
    return result.rows[0].id;
  }

  /**
   * A shift for `userId` at `branchId`.
   *
   * Starts `startOffsetMs` from now. The default is ten minutes ago: inside
   * the ±30 minute clock-in window, which is where a positive clock-in test
   * needs it.
   */
  async function createShift(
    token: string,
    branchId: string,
    userId: string,
    startOffsetMs = -10 * MINUTE,
    lengthMs = 8 * HOUR,
  ) {
    const start = Date.now() + startOffsetMs;
    return request(app.getHttpServer())
      .post(`/branches/${branchId}/shifts`)
      .set(auth(token))
      .send({
        userId,
        startTime: new Date(start).toISOString(),
        endTime: new Date(start + lengthMs).toISOString(),
      });
  }

  /** A shift for waiter A at branch A, created by the owner. */
  async function shiftForWaiterA(
    startOffsetMs = -10 * MINUTE,
    lengthMs = 8 * HOUR,
  ): Promise<string> {
    const response = await createShift(
      ownerToken,
      branchA,
      waiterAId,
      startOffsetMs,
      lengthMs,
    );
    expect({
      status: response.status,
      ...(response.status === 201
        ? {}
        : { error: JSON.stringify(response.body) }),
    }).toEqual({ status: 201 });
    return body<{ id: string }>(response).id;
  }

  function clockIn(token: string, branchId: string, shiftId: string) {
    return request(app.getHttpServer())
      .post(`/branches/${branchId}/attendance/clock-in`)
      .set(auth(token))
      .send({ shiftId });
  }

  function clockOut(token: string, branchId: string, shiftId: string) {
    return request(app.getHttpServer())
      .post(`/branches/${branchId}/attendance/clock-out`)
      .set(auth(token))
      .send({ shiftId });
  }

  async function payroll(token: string, branchId: string) {
    const range = period();
    return request(app.getHttpServer())
      .get(`/branches/${branchId}/payroll`)
      .query(range)
      .set(auth(token));
  }

  /** The second row of a CSV, i.e. the first staff member. */
  function csvRows(csv: string): string[] {
    return csv.trim().split('\r\n');
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
        orgName: 'Staff Co',
        slug: 'staffco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Branch A', address: '1 Main' },
        defaultTables: 0,
        owner: { email: ownerEmail, password: PASSWORD },
      });
    expect(response.status).toBe(201);

    const onboarded = body<{ tenantId: string; branchId: string }>(response);
    tenantId = onboarded.tenantId;
    branchA = onboarded.branchId;
    ownerToken = (await login(ownerEmail, tenantId)).accessToken;

    const second = await request(app.getHttpServer())
      .post('/branches')
      .set(auth(ownerToken))
      .send({ name: 'Branch B' });
    expect(second.status).toBe(201);
    branchB = body<{ id: string }>(second).id;

    waiterAId = await seedUser(
      tenantId,
      branchA,
      'waiter',
      waiterAEmail,
      'Asha Rai',
    );
    waiterBId = await seedUser(
      tenantId,
      branchB,
      'waiter',
      waiterBEmail,
      'Bikash Shrestha',
    );
    await seedUser(
      tenantId,
      branchA,
      'branch_manager',
      managerAEmail,
      'Manager A',
    );
    await seedUser(
      tenantId,
      branchB,
      'branch_manager',
      managerBEmail,
      'Manager B',
    );

    waiterAToken = (await login(waiterAEmail, tenantId)).accessToken;
    waiterBToken = (await login(waiterBEmail, tenantId)).accessToken;
    managerAToken = (await login(managerAEmail, tenantId)).accessToken;
    managerBToken = (await login(managerBEmail, tenantId)).accessToken;

    // A second tenant, to prove the RLS boundary is real and not a
    // `WHERE tenant_id = $1` that happens to be right.
    const rival = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Rival Co',
        slug: 'rivalstaffco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Rival Branch', address: '9 Other' },
        defaultTables: 0,
        owner: { email: rivalEmail, password: PASSWORD },
      });
    expect(rival.status).toBe(201);
    rivalTenantId = body<{ tenantId: string }>(rival).tenantId;
  });

  // ---------------------------------------------------------------------- RLS

  describe('tenant isolation', () => {
    it('hides the new tables from a tenant that has not pinned itself', async () => {
      await shiftForWaiterA();

      // A tenant-scoped connection sees its own rows.
      const scoped = await TenantScopedConnection.acquireScoped(
        appPool as Pool,
        tenantId,
      );
      try {
        const visible = await scoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM shifts`,
        );
        expect(visible.rows[0].n).toBeGreaterThan(0);
      } finally {
        await scoped.commit().catch(() => undefined);
        await scoped.release();
      }

      // No tenant pinned: RLS returns ZERO rows rather than everybody's.
      const unscoped = await TenantScopedConnection.acquireUnscoped(
        appPool as Pool,
      );
      try {
        const hidden = await unscoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM shifts`,
        );
        expect(hidden.rows[0].n).toBe(0);
      } finally {
        await unscoped.commit().catch(() => undefined);
        await unscoped.release();
      }

      // The row really is there — the admin connection bypasses RLS.
      const all = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM shifts`,
      );
      expect(all.rows[0].n).toBeGreaterThan(0);
    });

    it("hides another tenant's shifts from a scoped connection", async () => {
      await shiftForWaiterA();

      const rival = await TenantScopedConnection.acquireScoped(
        appPool as Pool,
        rivalTenantId,
      );
      try {
        const result = await rival.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM shifts`,
        );
        expect(result.rows[0].n).toBe(0);
      } finally {
        await rival.commit().catch(() => undefined);
        await rival.release();
      }
    });

    it("answers 404 for another tenant's branch", async () => {
      const rivalToken = (await login(rivalEmail, rivalTenantId)).accessToken;

      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/roster`)
        .set(auth(rivalToken, rivalTenantId));

      // Cross-tenant is a 404: the branch does not exist for that tenant, and
      // saying so leaks nothing.
      expect(response.status).toBe(404);
    });
  });

  // ------------------------------------------------------------------- shifts

  describe('shifts', () => {
    it('schedules a shift', async () => {
      const response = await createShift(ownerToken, branchA, waiterAId);
      expect(response.status).toBe(201);

      const shift = body<{ user_id: string; branch_id: string }>(response);
      expect(shift.user_id).toBe(waiterAId);
      expect(shift.branch_id).toBe(branchA);
    });

    it('refuses a shift that ends before it starts', async () => {
      const start = Date.now();
      const response = await request(app.getHttpServer())
        .post(`/branches/${branchA}/shifts`)
        .set(auth(ownerToken))
        .send({
          userId: waiterAId,
          startTime: new Date(start).toISOString(),
          endTime: new Date(start - HOUR).toISOString(),
        });

      expect(response.status).toBe(400);
    });

    it('refuses a start time with no UTC offset', async () => {
      const response = await request(app.getHttpServer())
        .post(`/branches/${branchA}/shifts`)
        .set(auth(ownerToken))
        .send({
          userId: waiterAId,
          startTime: '2026-10-21T09:00:00',
          endTime: '2026-10-21T17:00:00Z',
        });

      expect(response.status).toBe(400);
    });

    it('refuses a staff member who does not exist', async () => {
      const response = await createShift(
        ownerToken,
        branchA,
        '00000000-0000-4000-8000-000000000000',
      );

      expect(response.status).toBe(404);
    });

    it('refuses to schedule somebody who works at another branch', async () => {
      // Manager A is confined to branch A, and waiter B works at branch B.
      const response = await createShift(managerAToken, branchA, waiterBId);

      expect(response.status).toBe(403);
    });

    it('refuses a branch manager reaching another branch', async () => {
      const response = await createShift(managerBToken, branchA, waiterAId);

      expect(response.status).toBe(403);
    });
  });

  // --------------------------------------------------------------- attendance

  describe('attendance', () => {
    it('records a clock-in inside the window', async () => {
      const shiftId = await shiftForWaiterA();

      const response = await clockIn(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(201);
      expect(body<{ clock_in: string }>(response).clock_in).toBeDefined();
    });

    it('refuses a clock-in far before the shift starts', async () => {
      // The shift starts in three hours; the window is ±30 minutes.
      const shiftId = await shiftForWaiterA(3 * HOUR);

      const response = await clockIn(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toMatch(/window/i);
    });

    it('refuses a clock-in far after the shift starts', async () => {
      // The shift started three hours ago and lasts eight: still on, but the
      // clock-in is far too late to be believable.
      const shiftId = await shiftForWaiterA(-3 * HOUR);

      const response = await clockIn(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(400);
    });

    it("refuses a clock-in to somebody else's shift", async () => {
      const shiftId = await shiftForWaiterA();

      // Waiter B is on branch B and can reach branch A's branch id, but the
      // shift is not theirs.
      const response = await clockIn(waiterBToken, branchB, shiftId);

      // The shift is not at branch B, so it is not found there.
      expect(response.status).toBe(404);
    });

    it('refuses a second clock-in to the same shift', async () => {
      const shiftId = await shiftForWaiterA();

      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);
      const second = await clockIn(waiterAToken, branchA, shiftId);

      expect(second.status).toBe(409);
    });

    it('refuses a clock-out with no clock-in', async () => {
      const shiftId = await shiftForWaiterA();

      const response = await clockOut(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(409);
    });

    it('records a clock-out after a clock-in', async () => {
      const shiftId = await shiftForWaiterA();

      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);
      const response = await clockOut(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(201);
      expect(body<{ clock_out: string }>(response).clock_out).toBeDefined();
    });

    it('refuses a clock-out before the clock-in', async () => {
      const shiftId = await shiftForWaiterA();
      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);

      // The HTTP path cannot produce this on its own — the clock only moves
      // forwards — so the record is moved into the future to put the service's
      // guard in front of a real row.
      await adminTest.query(
        `UPDATE attendance_records
            SET clock_in = now() + interval '1 hour', clock_out = NULL
          WHERE shift_id = $1`,
        [shiftId],
      );

      const response = await clockOut(waiterAToken, branchA, shiftId);

      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toMatch(/not after/i);
    });

    it('cannot store a clock-out before the clock-in at the database level', async () => {
      const shiftId = await shiftForWaiterA();
      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);

      // The CHECK behind the service's refusal. Without it a future code path
      // that forgot the guard would write an unpayable row.
      await expect(
        adminTest.query(
          `UPDATE attendance_records
              SET clock_out = clock_in - interval '1 hour'
            WHERE shift_id = $1`,
          [shiftId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('keeps one attendance record per shift at the database level', async () => {
      const shiftId = await shiftForWaiterA();
      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);

      await expect(
        adminTest.query(
          `INSERT INTO attendance_records (tenant_id, shift_id, clock_in)
           VALUES ($1, $2, now())`,
          [tenantId, shiftId],
        ),
      ).rejects.toMatchObject({ code: '23505' });
    });
  });

  // ------------------------------------------------------------------ roster

  describe('roster', () => {
    it("shows a branch's shifts grouped by staff member", async () => {
      await shiftForWaiterA();

      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/roster`)
        .query({ week: day() })
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      const roster = body<{
        weekStart: string;
        weekEnd: string;
        staff: Array<{
          userId: string;
          fullName: string;
          shifts: Array<{ scheduledHours: number }>;
        }>;
      }>(response);

      const entry = roster.staff.find((member) => member.userId === waiterAId);
      expect(entry?.fullName).toBe('Asha Rai');
      expect(entry?.shifts.length).toBeGreaterThan(0);
      expect(entry?.shifts[0].scheduledHours).toBeGreaterThan(0);
    });

    it('puts the week on a Monday', async () => {
      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/roster`)
        .query({ week: day() })
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      const weekStart = body<{ weekStart: string }>(response).weekStart;
      expect(new Date(`${weekStart}T00:00:00Z`).getUTCDay()).toBe(1);
    });

    it('refuses a branch manager reading another branch', async () => {
      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/roster`)
        .query({ week: day() })
        .set(auth(managerBToken));

      expect(response.status).toBe(403);
    });

    it('refuses a week that is not a date', async () => {
      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/roster`)
        .query({ week: 'last week' })
        .set(auth(ownerToken));

      expect(response.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------- payroll

  describe('payroll', () => {
    /** Waiter A's rate, set through the real endpoint. */
    async function setRate(rate: number, payType = 'hourly') {
      return request(app.getHttpServer())
        .put(`/branches/${branchA}/wage-rates/${waiterAId}`)
        .set(auth(ownerToken))
        .send({ payType, rate });
    }

    /**
     * A completed 7.5-hour shift for waiter A.
     *
     * The clock-out is written with SQL because the HTTP clock-out is always
     * "now", and a test that has to wait seven and a half hours is not a test.
     */
    async function workedSevenAndAHalfHours(): Promise<string> {
      const shiftId = await shiftForWaiterA();
      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);
      await adminTest.query(
        `UPDATE attendance_records
            SET clock_out = clock_in + interval '7 hours 30 minutes'
          WHERE shift_id = $1`,
        [shiftId],
      );
      return shiftId;
    }

    it('sets and reads a wage rate', async () => {
      expect((await setRate(100)).status).toBe(200);

      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/wage-rates/${waiterAId}`)
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      expect(Number(body<{ rate: string }>(response).rate)).toBe(100);
    });

    it('refuses a pay type with no strategy', async () => {
      const response = await setRate(100, 'salaried');

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/hourly/);
    });

    it('refuses a negative rate', async () => {
      const response = await setRate(-1);

      expect(response.status).toBe(400);
    });

    it('pays a 7.5-hour shift the exact fractional wage', async () => {
      expect((await setRate(100)).status).toBe(200);
      await workedSevenAndAHalfHours();

      const response = await payroll(ownerToken, branchA);

      expect(response.status).toBe(200);
      const summary = body<{
        lines: Array<{ userId: string; hoursWorked: number; wage: number }>;
        total: number;
      }>(response);

      const line = summary.lines.find((entry) => entry.userId === waiterAId);
      expect(line?.hoursWorked).toBe(7.5);
      expect(line?.wage).toBe(750);
      expect(summary.total).toBeGreaterThanOrEqual(750);
    });

    it('refuses to pay somebody who worked but has no rate', async () => {
      // Waiter B has no rate. A shift and a clock-in are not enough: a wage
      // that cannot be calculated must not be reported as zero.
      const shiftResponse = await createShift(ownerToken, branchB, waiterBId);
      expect(shiftResponse.status).toBe(201);
      const shiftId = body<{ id: string }>(shiftResponse).id;
      expect((await clockIn(waiterBToken, branchB, shiftId)).status).toBe(201);
      await adminTest.query(
        `UPDATE attendance_records
            SET clock_out = clock_in + interval '2 hours'
          WHERE shift_id = $1`,
        [shiftId],
      );

      const response = await payroll(managerBToken, branchB);

      expect(response.status).toBe(422);
      expect(JSON.stringify(response.body)).toMatch(/no wage rate/i);
    });

    it('exports a CSV whose total adds up to its rows', async () => {
      expect((await setRate(100)).status).toBe(200);
      await workedSevenAndAHalfHours();

      const range = period();
      const csvResponse = await request(app.getHttpServer())
        .get(`/branches/${branchA}/payroll/export`)
        .query(range)
        .set(auth(ownerToken));

      expect(csvResponse.status).toBe(200);
      expect(csvResponse.headers['content-type']).toMatch(/text\/csv/);
      expect(csvResponse.headers['content-disposition']).toMatch(
        /attachment; filename="payroll-/,
      );

      const rows = csvRows(csvResponse.text);
      const totals = rows[rows.length - 1].split(',');
      const total = Number(totals[6]);

      const wages = rows
        .slice(1, rows.length - 1)
        .map((row) => Number(row.split(',')[6]));

      expect(wages.length).toBeGreaterThan(0);
      expect(total).toBe(wages.reduce((sum, wage) => sum + wage, 0));
    });

    it('agrees with the JSON payroll on the same period', async () => {
      expect((await setRate(100)).status).toBe(200);
      await workedSevenAndAHalfHours();

      const json = await payroll(ownerToken, branchA);
      expect(json.status).toBe(200);

      const range = period();
      const csv = await request(app.getHttpServer())
        .get(`/branches/${branchA}/payroll/export`)
        .query(range)
        .set(auth(ownerToken));
      expect(csv.status).toBe(200);

      const rows = csvRows(csv.text);
      const csvTotal = Number(rows[rows.length - 1].split(',')[6]);

      expect(csvTotal).toBe(body<{ total: number }>(json).total);
    });

    it("refuses a branch manager reading another branch's payroll", async () => {
      const response = await payroll(managerBToken, branchA);

      expect(response.status).toBe(403);
    });

    it('refuses a half-specified period', async () => {
      const response = await request(app.getHttpServer())
        .get(`/branches/${branchA}/payroll`)
        .query({ from: day(-1) })
        .set(auth(ownerToken));

      expect(response.status).toBe(400);
    });
  });

  // ----------------------------------------------------------------- cascade

  describe('deleting a shift', () => {
    it('removes the hours recorded against it', async () => {
      const shiftId = await shiftForWaiterA();
      expect((await clockIn(waiterAToken, branchA, shiftId)).status).toBe(201);

      const deleted = await request(app.getHttpServer())
        .delete(`/branches/${branchA}/shifts/${shiftId}`)
        .set(auth(ownerToken));
      expect(deleted.status).toBe(204);

      const remaining = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM attendance_records WHERE shift_id = $1`,
        [shiftId],
      );
      expect(remaining.rows[0].n).toBe(0);
    });
  });
});
