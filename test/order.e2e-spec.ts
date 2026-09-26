import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { hashSync } from 'bcryptjs';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { LoginResult } from './../src/auth/interfaces/auth.interface';
import { ORDER_EVENTS } from './../src/order/events/order-events';
import type {
  OrderPaidEvent,
  OrderPlacedEvent,
  OrderStatusChangedEvent,
} from './../src/order/events/order-events';
import type { TenantOnboardingResult } from './../src/org/tenant-onboarding.builder';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * OrderModule acceptance tests against a fresh Postgres database: real
 * migrations 001..011, a restricted (RLS-subject) app role, then the full Nest
 * app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 *
 * Covers the five acceptance criteria from
 * `.agent/docs/modules/05-order-module.md`:
 *   1. illegal transitions rejected with a clear error, for every illegal pair
 *   2. a legal transition fires the right events with the right payload
 *   3. duplicate `client_action_id` returns the original order and does not
 *      double-fire `order.placed` — proven against the REAL unique index
 *   4. the KDS snapshot is branch scoped (the room scoping itself is covered by
 *      the real-socket spec in `src/order/realtime/kds.gateway.spec.ts`)
 *   5. table status updates on completion/cancellation
 *
 * The unit spec (`src/order/order.service.spec.ts`) covers the same rules
 * against mocks; this one exists for what a mock cannot prove — the partial
 * unique index, the RLS policies, and the SQL itself.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'order_ci';
const APP_ROLE = 'cafe_order_app';
const APP_PASSWORD = 'cafe_order_secret';
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

describeWithDb('OrderModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  let events: EventEmitter2;
  const hash = hashSync(PASSWORD, 10);

  let tenantId = '';
  let branchA = '';
  let branchB = '';
  let tableId = '';
  let menuItemId = '';
  let ownerToken = '';
  let waiterToken = '';
  let kitchenToken = '';
  const ownerEmail = 'order-owner@cafe.test';
  const waiterEmail = 'order-waiter@cafe.test';
  const kitchenEmail = 'order-kitchen@cafe.test';

  /** Everything the order module published during a test, in order. */
  let published: Array<{ event: string; payload: unknown }> = [];

  // --------------------------------------------------------------- readback
  //
  // These read through a SEPARATE connection (`adminTest`), while the app
  // commits the request transaction on `res.finish`/`res.close` — asynchronous
  // with respect to supertest receiving the response. So a read taken the
  // instant a request returns can legitimately observe the previous state for a
  // few milliseconds. That is a harness race, not a product one; encoding it as
  // an explicit poll is far clearer, and far less flaky, than fixed sleeps.

  async function eventually(
    read: () => Promise<string>,
    done: (value: string) => boolean,
    what: string,
  ): Promise<string> {
    const deadline = Date.now() + 5000;
    let latest = await read();
    while (!done(latest)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${what}; last value was "${latest}"`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      latest = await read();
    }
    return latest;
  }

  async function readTableStatus(id: string): Promise<string> {
    const result = await adminTest.query<{ status: string }>(
      `SELECT status FROM tables WHERE id = $1`,
      [id],
    );
    return result.rows[0]?.status ?? '';
  }

  /** Asserts a table reaches `expected`, waiting out the commit race. */
  function expectTableStatus(id: string, expected: string): Promise<string> {
    return eventually(
      () => readTableStatus(id),
      (status) => status === expected,
      `table ${id} to be '${expected}'`,
    );
  }

  async function readOrderRow(id: string): Promise<Record<string, unknown>> {
    const result = await adminTest.query<Record<string, unknown>>(
      `SELECT id, status, subtotal, tax_amount, discount_amount, total_amount
         FROM orders WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? {};
  }

  /**
   * Reads an order, optionally waiting for it to reach `expectedStatus`.
   * Returns the row so the money assertions can use the same read.
   */
  async function readOrder(
    id: string,
    expectedStatus?: string,
  ): Promise<Record<string, unknown>> {
    const json = await eventually(
      async () => {
        const row = await readOrderRow(id);
        return Object.keys(row).length > 0 ? JSON.stringify(row) : '';
      },
      (value) =>
        value !== '' &&
        (expectedStatus === undefined ||
          (JSON.parse(value) as { status: string }).status === expectedStatus),
      expectedStatus
        ? `order ${id} to reach '${expectedStatus}'`
        : `order ${id} to exist`,
    );
    return JSON.parse(json) as Record<string, unknown>;
  }

  async function countOrdersWhere(
    clause: string,
    values: unknown[] = [],
  ): Promise<number> {
    return eventually(
      async () => {
        const result = await adminTest.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM orders ${clause}`,
          values,
        );
        return result.rows[0]?.n === 1 ? '1' : String(result.rows[0]?.n ?? 0);
      },
      (value) => value === '1',
      `exactly one order ${clause}`,
    ).then(() => 1);
  }

  // ------------------------------------------------------------------ helpers

  function body<T>(response: request.Response): T {
    return response.body as T;
  }

  function postOrder(token: string, payload: object) {
    return request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .send(payload);
  }

  function transition(token: string, orderId: string, status: string) {
    return request(app.getHttpServer())
      .post(`/orders/${orderId}/transition`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId)
      .send({ status });
  }

  function activeOrders(token: string, branchId: string) {
    return request(app.getHttpServer())
      .get(`/orders/branches/${branchId}/active`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId);
  }

  /** A brand new table. Table-status tests must not share one. */
  async function freshTable(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post(`/branches/${branchA}/tables`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .set('X-Tenant-Id', tenantId)
      .send({ label: `T-${Math.random().toString(36).slice(2, 8)}`, seats: 2 });
    expect(response.status).toBe(201);
    return body<{ id: string }>(response).id;
  }

  /** A valid dine-in ticket on branch A, priced from the seeded menu. */
  async function dineInOrder(
    token: string,
    overrides: Record<string, unknown> = {},
    onTable?: string,
  ): Promise<string> {
    const response = await postOrder(token, {
      branchId: branchA,
      tableId: onTable ?? tableId,
      orderType: 'dine_in',
      items: [{ menuItemId, quantity: 1 }],
      ...overrides,
    });
    if (response.status !== 201) {
      throw new Error(
        `dineInOrder failed: ${response.status} ${JSON.stringify(response.body)}`,
      );
    }
    return body<{ id: string }>(response).id;
  }

  /** Drives an order along a legal path, asserting each hop succeeded. */
  async function walk(
    token: string,
    orderId: string,
    path_: string[],
  ): Promise<void> {
    for (const status of path_) {
      const response = await transition(token, orderId, status);
      // The body is in the message on purpose: a bare "expected 200, got 400"
      // says nothing about WHICH precondition failed, and this file has enough
      // multi-step state machines that guessing from a status code alone wastes
      // more time than the assertion costs.
      expect({
        status: response.status,
        ...(response.status === 200
          ? {}
          : { error: JSON.stringify(response.body) }),
      }).toEqual({ status: 200 });
    }
  }

  async function login(
    email: string,
    tenant = tenantId,
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

  // ------------------------------------------------------------------ events
  //
  // `order.placed` / `order.status_changed` / `order.paid` are published only
  // AFTER the request transaction commits, and the commit happens on
  // `res.finish` — a tick or two AFTER supertest resolves the request. So the
  // bus is genuinely asynchronous with respect to the HTTP response, and these
  // tests must wait for it rather than assume it already ran.

  /** Waits until at least `count` order events have been published. */
  async function waitForEvents(count: number): Promise<void> {
    const deadline = Date.now() + 5000;
    while (published.length < count) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${count} order event(s); saw ` +
            `[${published.map((entry) => entry.event).join(', ')}]`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /**
   * Clears the recorded events for a test that only cares about what happens
   * NEXT. A bare `published = []` would be a bug: a previous request's events
   * are still in flight (they publish on `res.finish`), so they would land
   * after the reset and be mistaken for the action under test.
   */
  async function resetEvents(): Promise<void> {
    await settleEvents();
    published = [];
  }

  /**
   * Gives any *unexpected* event time to show up, so a negative assertion
   * ("the replay did not re-fire `order.placed`") is meaningful rather than
   * passing simply because nothing had been given a chance to arrive.
   */
  async function settleEvents(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 250));
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
    await app.init();
    // Listen on a real (ephemeral) port once. Leaving the server unlistened
    // makes supertest spin up and tear down a throwaway server per request,
    // which intermittently resets in-flight sockets ("read ECONNRESET") on
    // newer Node — a transport flake, never a product one.
    await app.listen(0);
    events = app.get(EventEmitter2);

    // A stand-in for Inventory/CRM/Notification: the whole point of the bus is
    // that an outside module can observe orders without OrderModule knowing it
    // exists. Recording payloads here proves the contract from the SUBSCRIBER's
    // side, not just from the publisher's.
    for (const name of [
      ORDER_EVENTS.placed,
      ORDER_EVENTS.statusChanged,
      ORDER_EVENTS.paid,
    ]) {
      events.on(name, (payload: unknown) =>
        published.push({ event: name, payload }),
      );
    }
  });

  afterAll(async () => {
    await app?.close();
    await endPool(appPool);
    await evictStragglers(admin);
    await endPool(adminTest);
    await endPool(admin);
  });

  beforeEach(() => {
    // Nothing is in flight between tests, so a plain reset is correct here —
    // unlike the mid-test resets, which must first let stragglers land.
    published = [];
  });

  // ------------------------------------------------------------------ fixture

  describe('fixture', () => {
    it('onboards a tenant, two branches, a table, a menu, and three staff', async () => {
      const response = await request(app.getHttpServer())
        .post('/onboarding')
        .send({
          orgName: 'Order Co',
          slug: 'orderco',
          planId: PLAN_STARTER,
          firstBranch: { name: 'Branch A', address: '1 Main' },
          defaultTables: 1,
          owner: { email: ownerEmail, password: PASSWORD },
        });
      expect(response.status).toBe(201);

      const onboarded = body<TenantOnboardingResult>(response);
      tenantId = onboarded.tenantId;
      branchA = onboarded.branchId;

      const owner = await login(ownerEmail);
      expect(owner.status).toBe(200);
      ownerToken = owner.body.accessToken ?? '';
      expect(owner.body.user).toMatchObject({ role: 'org_owner' });

      const second = await request(app.getHttpServer())
        .post('/branches')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', tenantId)
        .send({ name: 'Branch B' });
      expect(second.status).toBe(201);
      branchB = body<{ id: string }>(second).id;

      const table = await request(app.getHttpServer())
        .post(`/branches/${branchA}/tables`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', tenantId)
        .send({ label: 'T-main', seats: 4 });
      expect(table.status).toBe(201);
      tableId = body<{ id: string }>(table).id;

      const category = await request(app.getHttpServer())
        .post('/menu/categories')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', tenantId)
        .send({ name: 'Drinks' });
      expect(category.status).toBe(201);
      const categoryId = body<{ id: string }>(category).id;

      const item = await request(app.getHttpServer())
        .post('/menu/items')
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', tenantId)
        .send({ name: 'Flat White', price: 3.5, categoryId });
      expect(item.status).toBe(201);
      menuItemId = body<{ id: string }>(item).id;

      const modifier = await request(app.getHttpServer())
        .post(`/menu/items/${menuItemId}/modifiers`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', tenantId)
        .send({ name: 'Size', optionName: 'Large', extraPrice: 0.75 });
      expect(modifier.status).toBe(201);

      for (const [email, role] of [
        [waiterEmail, 'waiter'],
        [kitchenEmail, 'kitchen_staff'],
      ] as const) {
        await adminTest.query(
          `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
           VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3), $4, $5, $6)`,
          [tenantId, branchA, role, role, email, hash],
        );
        const session = await login(email);
        expect(session.status).toBe(200);
        if (role === 'waiter') {
          waiterToken = session.body.accessToken ?? '';
        } else {
          kitchenToken = session.body.accessToken ?? '';
        }
      }

      expect(tenantId).not.toBe('');
      expect(waiterToken).not.toBe('');
      expect(kitchenToken).not.toBe('');
    });
  });

  // ---------------------------------------------------------------------- AC1

  describe('AC1 — illegal transitions are rejected', () => {
    it('rejects served -> placed, naming both ends and what is allowed', async () => {
      const orderId = await dineInOrder(waiterToken);
      await walk(kitchenToken, orderId, [
        'confirmed',
        'preparing',
        'ready',
        'served',
      ]);

      const response = await transition(kitchenToken, orderId, 'placed');

      expect(response.status).toBe(400);
      const message = body<{ message: string }>(response).message;
      expect(message).toContain(`cannot move from 'served' to 'placed'`);
      expect(message).toContain('Allowed next: awaiting_payment, cancelled');
      // and the row really did not move
      expect((await readOrder(orderId, 'served')).status).toBe('served');
    });

    it('rejects skipping ahead, going backwards, and re-entering a status', async () => {
      const orderId = await dineInOrder(waiterToken);

      // Skipping ahead from `placed` is not an edge.
      expect((await transition(kitchenToken, orderId, 'ready')).status).toBe(
        400,
      );
      expect((await transition(kitchenToken, orderId, 'paid')).status).toBe(
        400,
      );

      await walk(kitchenToken, orderId, ['confirmed', 'preparing', 'ready']);

      // ready -> paid would mean skipping the serving + payment steps
      expect((await transition(kitchenToken, orderId, 'paid')).status).toBe(
        400,
      );
      // re-entering the current status is not an edge either
      expect((await transition(kitchenToken, orderId, 'ready')).status).toBe(
        400,
      );
      // backwards
      expect((await transition(kitchenToken, orderId, 'placed')).status).toBe(
        400,
      );
      expect((await readOrder(orderId, 'ready')).status).toBe('ready');
    });

    it('rejects a terminal order being reopened', async () => {
      const orderId = await dineInOrder(waiterToken);
      expect(
        (await transition(kitchenToken, orderId, 'cancelled')).status,
      ).toBe(200);

      const response = await transition(kitchenToken, orderId, 'confirmed');

      expect(response.status).toBe(400);
      expect(body<{ message: string }>(response).message).toContain(
        "'cancelled' is a terminal state",
      );
    });

    it('rejects cancelling a PAID order (that is a refund, not a transition)', async () => {
      const orderId = await dineInOrder(waiterToken);
      await walk(kitchenToken, orderId, [
        'confirmed',
        'preparing',
        'ready',
        'served',
        'awaiting_payment',
        'paid',
      ]);

      expect(
        (await transition(kitchenToken, orderId, 'cancelled')).status,
      ).toBe(400);
      expect((await readOrder(orderId, 'paid')).status).toBe('paid');
    });

    it('rejects a status outside the known set', async () => {
      const orderId = await dineInOrder(waiterToken);
      const response = await transition(kitchenToken, orderId, 'refunded');
      expect(response.status).toBe(400);
      expect(body<{ message: string }>(response).message).toContain(
        "'refunded' is not a recognised order status",
      );
    });

    it('404s an order that belongs to another tenant', async () => {
      const orderId = await dineInOrder(waiterToken);

      const other = await request(app.getHttpServer())
        .post('/onboarding')
        .send({
          orgName: 'Other Co',
          slug: 'otherco',
          planId: PLAN_STARTER,
          firstBranch: { name: 'Their Branch' },
          defaultTables: 0,
          owner: { email: 'other-owner@cafe.test', password: PASSWORD },
        });
      expect(other.status).toBe(201);
      const otherTenant = body<TenantOnboardingResult>(other).tenantId;

      const response = await request(app.getHttpServer())
        .post(`/orders/${orderId}/transition`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .set('X-Tenant-Id', otherTenant)
        .send({ status: 'confirmed' });

      // RLS makes this invisible rather than merely forbidden, which is the
      // stronger guarantee: no order id grants cross-tenant access.
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------------------- AC2

  describe('AC2 — a legal transition fires the right events', () => {
    it('publishes order.status_changed with the documented payload', async () => {
      const orderId = await dineInOrder(waiterToken);
      await resetEvents();

      const response = await transition(kitchenToken, orderId, 'confirmed');
      expect(response.status).toBe(200);
      await waitForEvents(1);

      expect(published).toHaveLength(1);
      const [event] = published;
      expect(event.event).toBe(ORDER_EVENTS.statusChanged);
      expect(event.payload).toMatchObject({
        event: 'order.status_changed',
        orderId,
        tenantId,
        branchId: branchA,
        previousStatus: 'placed',
        newStatus: 'confirmed',
        orderType: 'dine_in',
      });
      // a subscriber must be able to trust that occurredAt is a real timestamp
      expect(
        new Date(
          (event.payload as OrderStatusChangedEvent).occurredAt,
        ).getTime(),
      ).not.toBeNaN();
    });

    it('publishes order.paid alongside order.status_changed on payment', async () => {
      const orderId = await dineInOrder(waiterToken);
      await walk(kitchenToken, orderId, [
        'confirmed',
        'preparing',
        'ready',
        'served',
        'awaiting_payment',
      ]);
      await resetEvents();

      await walk(kitchenToken, orderId, ['paid']);
      await waitForEvents(2);

      expect(published.map((entry) => entry.event)).toEqual([
        ORDER_EVENTS.statusChanged,
        ORDER_EVENTS.paid,
      ]);
      const paid = published[1].payload as OrderPaidEvent;
      expect(paid).toMatchObject({
        event: 'order.paid',
        orderId,
        tenantId,
        branchId: branchA,
        previousStatus: 'awaiting_payment',
        newStatus: 'paid',
      });
      expect(paid.totalAmount).toBeCloseTo(3.5, 2);
    });

    it('publishes order.placed exactly once, with the priced lines', async () => {
      await resetEvents();
      const orderId = await dineInOrder(waiterToken);
      // placed + the status_changed it implies
      await waitForEvents(2);

      const placed = published.filter(
        (entry) => entry.event === ORDER_EVENTS.placed,
      );
      expect(placed).toHaveLength(1);
      const payload = placed[0].payload as OrderPlacedEvent;
      expect(payload).toMatchObject({
        event: 'order.placed',
        orderId,
        tenantId,
        branchId: branchA,
        status: 'placed',
        orderType: 'dine_in',
        tableId,
      });
      expect(payload.items).toEqual([
        { menuItemId, quantity: 1, unitPrice: 3.5, notes: null },
      ]);
      // creation also produces the initial status_changed, so a KDS built only
      // on that one event still sees brand new tickets
      expect(
        published.filter((entry) => entry.event === ORDER_EVENTS.statusChanged),
      ).toHaveLength(1);
    });

    it('hands subscribers an order that is already committed and readable', async () => {
      // The reason events are published after COMMIT rather than inside the
      // request. A subscriber (Inventory, CRM, Notification) reacts by loading
      // the order on its OWN connection — so if the event arrived before the
      // commit, that read would find nothing. `adminTest` is a separate pool,
      // which makes this the real scenario rather than a restatement of the
      // service's own transaction.
      const observed: Array<{ id: string; status: string | null }> = [];
      const listener = (payload: OrderPlacedEvent): void => {
        void adminTest
          .query<{ id: string; status: string }>(
            'SELECT id, status FROM orders WHERE id = $1',
            [payload.orderId],
          )
          .then((result) => {
            observed.push(...result.rows);
          });
      };
      events.on(ORDER_EVENTS.placed, listener);

      try {
        const orderId = await dineInOrder(waiterToken);
        await waitForEvents(2);

        const deadline = Date.now() + 5000;
        while (observed.length === 0 && Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 25));
        }

        expect(observed).toEqual([{ id: orderId, status: 'placed' }]);
      } finally {
        events.off(ORDER_EVENTS.placed, listener);
      }
    });

    it('prices modifiers per unit, from the menu', async () => {
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [
          {
            menuItemId,
            quantity: 2,
            modifiers: [{ name: 'Size', optionName: 'Large' }],
          },
        ],
      });
      expect(response.status).toBe(201);

      // (3.50 + 0.75) x 2 = 8.50, computed server-side
      const row = await readOrder(body<{ id: string }>(response).id);
      expect(Number(row.subtotal)).toBeCloseTo(8.5, 2);
      expect(Number(row.total_amount)).toBeCloseTo(8.5, 2);
    });

    it('refuses a modifier the item does not have', async () => {
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [
          { menuItemId, modifiers: [{ name: 'Size', optionName: 'Enormous' }] },
        ],
      });
      expect(response.status).toBe(400);
      expect(body<{ message: string }>(response).message).toContain(
        'is not a modifier of menu item',
      );
    });

    it('refuses a dine-in order with no table', async () => {
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        orderType: 'dine_in',
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(response.status).toBe(400);
    });

    it('refuses a menu item that is not on the branch menu', async () => {
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [{ menuItemId: '00000000-0000-4000-8000-000000000000' }],
      });
      expect(response.status).toBe(400);
    });
  });

  // ---------------------------------------------------------------------- AC3

  describe('AC3 — idempotent creation (offline action queue)', () => {
    it('returns the original order for a replayed client_action_id', async () => {
      const clientActionId = '11111111-1111-4111-8111-111111111111';
      await resetEvents();

      const first = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        clientActionId,
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(first.status).toBe(201);
      const original = body<{ id: string }>(first).id;
      await waitForEvents(2);
      expect(
        published.filter((entry) => entry.event === ORDER_EVENTS.placed),
      ).toHaveLength(1);

      // The phone retries after a dropped response.
      const replay = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        clientActionId,
        items: [{ menuItemId, quantity: 1 }],
      });

      expect(replay.status).toBe(201);
      expect(body<{ id: string }>(replay).id).toBe(original);
      // no second row, and no second round of events — the kitchen must not see
      // the ticket twice and inventory must not deduct twice
      await countOrdersWhere('WHERE client_action_id = $1', [clientActionId]);
      await settleEvents();
      expect(
        published.filter((entry) => entry.event === ORDER_EVENTS.placed),
      ).toHaveLength(1);
    });

    it('survives a concurrent double submit (the real unique index decides)', async () => {
      const clientActionId = '22222222-2222-4222-8222-222222222222';
      const payload = {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        clientActionId,
        items: [{ menuItemId, quantity: 1 }],
      };
      await resetEvents();

      // Two identical requests in flight at once. The pre-check can miss for
      // both, so only `idx_orders_client_action` stands between them — and the
      // loser's 500 must not happen, because the phone did nothing wrong.
      const [a, b] = await Promise.all([
        postOrder(waiterToken, payload),
        postOrder(waiterToken, payload),
      ]);

      expect([a.status, b.status].sort()).toEqual([201, 201]);
      expect(body<{ id: string }>(a).id).toBe(body<{ id: string }>(b).id);
      await countOrdersWhere('WHERE client_action_id = $1', [clientActionId]);
      await waitForEvents(2);
      await settleEvents();
      expect(
        published.filter((entry) => entry.event === ORDER_EVENTS.placed),
      ).toHaveLength(1);
    });

    it('scopes the idempotency key per tenant, so two cafés can share a uuid', async () => {
      const clientActionId = '33333333-3333-4333-8333-333333333333';
      const first = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        clientActionId,
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(first.status).toBe(201);

      const other = await request(app.getHttpServer())
        .post('/onboarding')
        .send({
          orgName: 'Other Co 2',
          slug: 'otherco2',
          planId: PLAN_STARTER,
          firstBranch: { name: 'Their Branch' },
          defaultTables: 0,
          owner: { email: 'other-owner-2@cafe.test', password: PASSWORD },
        });
      expect(other.status).toBe(201);
      const otherTenant = body<TenantOnboardingResult>(other).tenantId;
      const otherBranch = body<TenantOnboardingResult>(other).branchId;

      // Seed that tenant's own menu through its own connection.
      const otherAdmin = poolFor(TEST_DB);
      try {
        const category = await otherAdmin.query<{ id: string }>(
          `INSERT INTO menu_categories (tenant_id, name) VALUES ($1, 'Drinks') RETURNING id`,
          [otherTenant],
        );
        const item = await otherAdmin.query<{ id: string }>(
          `INSERT INTO menu_items (tenant_id, category_id, name, price)
           VALUES ($1, $2, 'Flat White', 3.5) RETURNING id`,
          [otherTenant, category.rows[0].id],
        );
        const otherOwner = await login('other-owner-2@cafe.test', otherTenant);
        expect(otherOwner.status).toBe(200);

        const response = await request(app.getHttpServer())
          .post('/orders')
          .set('Authorization', `Bearer ${otherOwner.body.accessToken ?? ''}`)
          .set('X-Tenant-Id', otherTenant)
          .send({
            branchId: otherBranch,
            orderType: 'takeaway',
            clientActionId,
            items: [{ menuItemId: item.rows[0].id, quantity: 1 }],
          });

        // A separate tenant reusing the same client-generated uuid must NOT be
        // told it already placed this order.
        expect(response.status).toBe(201);
        expect(body<{ id: string }>(response).id).not.toBe(
          body<{ id: string }>(first).id,
        );
      } finally {
        await otherAdmin.end();
      }
    });

    it('does not deduplicate orders with no client_action_id', async () => {
      const payload = {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [{ menuItemId, quantity: 1 }],
      };
      const [a, b] = await Promise.all([
        postOrder(waiterToken, payload),
        postOrder(waiterToken, payload),
      ]);
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(body<{ id: string }>(a).id).not.toBe(body<{ id: string }>(b).id);
    });
  });

  // ---------------------------------------------------------------------- AC4

  describe('AC4 — the KDS snapshot is branch scoped', () => {
    it('lists only the active orders of the requested branch', async () => {
      const inA = await dineInOrder(waiterToken);
      const inB = await postOrder(waiterToken, {
        branchId: branchB,
        orderType: 'takeaway',
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(inB.status).toBe(201);

      const response = await activeOrders(waiterToken, branchA);

      expect(response.status).toBe(200);
      const rows = body<Array<{ id: string; branch_id: string }>>(response);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.branch_id === branchA)).toBe(true);
      expect(rows.map((row) => row.id)).toContain(inA);
      expect(rows.map((row) => row.id)).not.toContain(
        body<{ id: string }>(inB).id,
      );
    });

    it('drops completed and cancelled orders from the active list', async () => {
      const done = await dineInOrder(waiterToken);
      const called = await dineInOrder(waiterToken);
      const open = await dineInOrder(waiterToken);
      await walk(kitchenToken, done, ['cancelled']);
      await walk(kitchenToken, called, ['cancelled']);

      const ids = body<Array<{ id: string }>>(
        await activeOrders(waiterToken, branchA),
      ).map((row) => row.id);

      expect(ids).not.toContain(done);
      expect(ids).not.toContain(called);
      expect(ids).toContain(open);
    });
  });

  // ---------------------------------------------------------------------- AC5

  describe('AC5 — table status side-effects', () => {
    it('marks a table occupied when a dine-in order is placed', async () => {
      const t = await freshTable();
      await expectTableStatus(t, 'free');
      await dineInOrder(waiterToken, {}, t);
      await expectTableStatus(t, 'occupied');
    });

    it('frees the table when the order is cancelled', async () => {
      const t = await freshTable();
      const orderId = await dineInOrder(waiterToken, {}, t);
      await expectTableStatus(t, 'occupied');

      await walk(kitchenToken, orderId, ['cancelled']);
      await expectTableStatus(t, 'free');
    });

    it('frees the table when the order completes', async () => {
      const t = await freshTable();
      const orderId = await dineInOrder(waiterToken, {}, t);
      await walk(kitchenToken, orderId, [
        'confirmed',
        'preparing',
        'ready',
        'served',
        'awaiting_payment',
        'paid',
        'completed',
      ]);

      expect((await readOrder(orderId, 'completed')).status).toBe('completed');
      await expectTableStatus(t, 'free');
    });

    it('leaves the table occupied through every intermediate status', async () => {
      const t = await freshTable();
      const orderId = await dineInOrder(waiterToken, {}, t);
      for (const status of [
        'confirmed',
        'preparing',
        'ready',
        'served',
        'awaiting_payment',
        'paid',
      ]) {
        await transition(kitchenToken, orderId, status);
        await expectTableStatus(t, 'occupied');
      }
    });

    it('keeps the table busy while another order on it is still open', async () => {
      // A table can hold more than one ticket at a time (a second party joining
      // mid-visit, a split check). Closing one of them must NOT tell the floor
      // the table is free while the other is still being served.
      const t = await freshTable();
      const first = await dineInOrder(waiterToken, {}, t);
      const second = await dineInOrder(waiterToken, {}, t);
      await expectTableStatus(t, 'occupied');

      await walk(kitchenToken, first, [
        'confirmed',
        'preparing',
        'ready',
        'served',
        'awaiting_payment',
        'paid',
        'completed',
      ]);

      expect((await readOrder(first, 'completed')).status).toBe('completed');
      await expectTableStatus(t, 'occupied');

      // ...until the last one out closes it.
      await walk(kitchenToken, second, ['cancelled']);
      await expectTableStatus(t, 'free');
    });

    it('never touches a table for a takeaway order', async () => {
      const t = await freshTable();
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        tableId: t,
        orderType: 'takeaway',
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(response.status).toBe(201);
      await expectTableStatus(t, 'free');
    });
  });

  // ---------------------------------------------------------------------- RBAC

  describe('RBAC', () => {
    it('lets a waiter place and advance an order', async () => {
      const orderId = await dineInOrder(waiterToken);
      expect((await transition(waiterToken, orderId, 'confirmed')).status).toBe(
        200,
      );
    });

    it('lets kitchen staff advance an order', async () => {
      const orderId = await dineInOrder(waiterToken);
      expect(
        (await transition(kitchenToken, orderId, 'confirmed')).status,
      ).toBe(200);
    });

    it('stops kitchen staff from placing an order', async () => {
      const response = await postOrder(kitchenToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(response.status).toBe(403);
    });

    it('rejects an unauthenticated write', async () => {
      const response = await request(app.getHttpServer())
        .post('/orders')
        .set('X-Tenant-Id', tenantId)
        .send({
          branchId: branchA,
          tableId,
          orderType: 'dine_in',
          items: [{ menuItemId, quantity: 1 }],
        });
      expect(response.status).toBe(401);
    });

    it('records the authenticated staff member as the author, not the body', async () => {
      const forged = '00000000-0000-4000-8000-000000000000';
      const response = await postOrder(waiterToken, {
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        createdBy: forged,
        items: [{ menuItemId, quantity: 1 }],
      });
      expect(response.status).toBe(201);
      const orderId = body<{ id: string }>(response).id;
      await readOrder(orderId);

      const result = await adminTest.query<{ created_by: string }>(
        `SELECT created_by FROM orders WHERE id = $1`,
        [orderId],
      );
      expect(result.rows[0].created_by).not.toBe(forged);
    });
  });
});
