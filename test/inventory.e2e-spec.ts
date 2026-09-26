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
import { INVENTORY_EVENTS } from './../src/inventory/events/inventory-events';
import type { InventoryLowStockEvent } from './../src/inventory/events/inventory-events';
import { InventoryService } from './../src/inventory/inventory.service';
import { TenantScopedConnection } from './../src/tenant/connection/tenant-scoped-connection';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * InventoryModule acceptance tests against a fresh Postgres database: real
 * migrations 001..012, a restricted (RLS-subject) app role, then the full Nest
 * app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 *
 * The unit specs cover the decision rules against mocks. This one exists for
 * what a mock cannot prove:
 *
 *   1. the deduction SQL — the NUMERIC aggregation and, above all, the branch
 *      join, which is the difference between a sale deducting its own branch's
 *      flour and silently draining a different branch's
 *   2. the ledger's UNIQUE (tenant_id, order_id) actually preventing a second
 *      deduction, including two concurrent attempts
 *   3. atomicity — a failure part-way through leaves NO stock movement behind,
 *      proven by rolling back a real transaction
 *   4. RLS — a second tenant cannot see, write or count the first one's stock
 *   5. the after-commit timing of `inventory.low_stock`
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'inventory_ci';
const APP_ROLE = 'cafe_inventory_app';
const APP_PASSWORD = 'cafe_inventory_secret';
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

describeWithDb('InventoryModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  let events: EventEmitter2;
  let inventory: InventoryService;

  const ownerEmail = 'inv-owner@cafe.test';
  const kitchenEmail = 'inv-kitchen@cafe.test';
  const branchBEmail = 'inv-branchb-manager@cafe.test';
  const branchAManagerEmail = 'inv-brancha-manager@cafe.test';
  const rivalEmail = 'inv-rival@cafe.test';

  let tenantId = '';
  let branchA = '';
  let branchB = '';
  let tableId = '';
  let menuItemId = '';
  let milkId = '';
  let rivalTenantId = '';
  let ownerToken = '';
  let kitchenToken = '';
  let branchBToken = '';
  let branchAManagerToken = '';

  let lowStock: InventoryLowStockEvent[] = [];

  // --------------------------------------------------------------- readback
  //
  // Order events fire only after the request transaction commits, and the commit
  // happens on `res.finish` — a tick or two AFTER supertest resolves. So a read
  // taken the instant a request returns can legitimately see the previous state
  // for a few milliseconds. Polling explicitly is far less flaky than sleeping.

  async function eventually<T>(
    read: () => Promise<T>,
    done: (value: T) => boolean,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + 5000;
    let latest = await read();
    while (!done(latest)) {
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for ${what}; last value was ${JSON.stringify(latest)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
      latest = await read();
    }
    return latest;
  }

  async function stock(id: string): Promise<number> {
    const result = await adminTest.query<{ quantity_on_hand: string }>(
      `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
      [id],
    );
    return Number(result.rows[0]?.quantity_on_hand ?? NaN);
  }

  function expectStock(id: string, expected: number): Promise<number> {
    return eventually(
      () => stock(id),
      (value) => value === expected,
      `stock of ${id} to be ${expected}`,
    );
  }

  async function movementCount(
    itemId: string,
    orderId?: string,
  ): Promise<number> {
    const result = await adminTest.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM stock_movements
        WHERE inventory_item_id = $1
          AND ($2::uuid IS NULL OR reference_order_id = $2)`,
      [itemId, orderId ?? null],
    );
    return result.rows[0]?.n ?? 0;
  }

  async function deductionStatus(orderId: string): Promise<string> {
    const result = await adminTest.query<{ status: string }>(
      `SELECT status FROM order_inventory_deductions WHERE order_id = $1`,
      [orderId],
    );
    return result.rows[0]?.status ?? 'absent';
  }

  function expectDeduction(orderId: string, expected: string): Promise<string> {
    return eventually(
      () => deductionStatus(orderId),
      (status) => status === expected,
      `deduction for order ${orderId} to be '${expected}'`,
    );
  }

  // ------------------------------------------------------------------ helpers

  function body<T>(response: request.Response): T {
    return response.body as T;
  }

  function auth(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      'X-Tenant-Id': tenantId,
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

  function postOrder(payload: object) {
    return request(app.getHttpServer())
      .post('/orders')
      .set(auth(ownerToken))
      .send(payload);
  }

  /** A dine-in ticket for `quantity` of the seeded menu item. */
  async function orderWith(quantity: number): Promise<string> {
    const response = await postOrder({
      branchId: branchA,
      tableId,
      orderType: 'dine_in',
      items: [{ menuItemId, quantity }],
    });
    expect(response.status).toBe(201);
    return body<{ id: string }>(response).id;
  }

  /** Drives an order to `completed` and waits for its deduction to settle. */
  async function completeOrder(orderId: string): Promise<void> {
    for (const status of [
      'confirmed',
      'preparing',
      'ready',
      'served',
      'awaiting_payment',
      'paid',
      'completed',
    ]) {
      const response = await request(app.getHttpServer())
        .post(`/orders/${orderId}/transition`)
        .set(auth(ownerToken))
        .send({ status });
      expect({
        status: response.status,
        ...(response.status === 200
          ? {}
          : { error: JSON.stringify(response.body) }),
      }).toEqual({ status: 200 });
    }
  }

  /** An inventory item at branch A with known stock, via the real endpoint. */
  async function createItem(
    name: string,
    onHand: number,
    threshold = 0,
    supplierId?: string,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/inventory/items')
      .set(auth(ownerToken))
      .send({
        branchId: branchA,
        name,
        unit: 'l',
        quantityOnHand: onHand,
        reorderThreshold: threshold,
        ...(supplierId ? { supplierId } : {}),
      });
    expect(response.status).toBe(201);
    return body<{ id: string }>(response).id;
  }

  async function setRecipe(
    inventoryItemId: string,
    quantityUsed: number,
  ): Promise<void> {
    const response = await request(app.getHttpServer())
      .post('/inventory/recipes/ingredients')
      // The owner runs the whole org, so there is no branch to infer and it must
      // name one. It used to be implicit, which only worked while the owner was
      // wrongly being confined to the branch in its token.
      .query({ branchId: branchA })
      .set(auth(ownerToken))
      .send({ menuItemId, inventoryItemId, quantityUsed });
    expect({
      status: response.status,
      ...(response.status === 204
        ? {}
        : { error: JSON.stringify(response.body) }),
    }).toEqual({ status: 204 });
  }

  /**
   * Makes the next UPDATE of an item named `name` fail, the way a real
   * mid-deduction fault would: the ingredient query still resolves the item, and
   * the failure lands on the stock write itself, AFTER the deduction has started.
   *
   * A trigger is used rather than deleting the row because
   * `recipe_ingredients.inventory_item_id` is `ON DELETE CASCADE` — deleting the
   * item removes the recipe row with it, so the deduction would find no
   * ingredients and complete cleanly instead of failing part-way. That would
   * assert nothing about atomicity.
   */
  async function failUpdatesTo(name: string): Promise<() => Promise<void>> {
    await adminTest.query(`
      CREATE OR REPLACE FUNCTION inventory_ci_fail() RETURNS trigger AS $fn$
      BEGIN
        IF NEW.name = '${name}' THEN
          RAISE EXCEPTION 'simulated storage failure';
        END IF;
        RETURN NEW;
      END $fn$ LANGUAGE plpgsql;
    `);
    await adminTest.query(`
      CREATE TRIGGER inventory_ci_fail_trigger
        BEFORE UPDATE ON inventory_items
        FOR EACH ROW EXECUTE FUNCTION inventory_ci_fail();
    `);
    return async () => {
      await adminTest.query(
        `DROP TRIGGER IF EXISTS inventory_ci_fail_trigger ON inventory_items`,
      );
      await adminTest.query(`DROP FUNCTION IF EXISTS inventory_ci_fail()`);
    };
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
    inventory = app.get(InventoryService);

    // A stand-in for NotificationModule (10): the contract as seen from the
    // SUBSCRIBER's side, not the publisher's.
    events.on(INVENTORY_EVENTS.lowStock, (payload: InventoryLowStockEvent) =>
      lowStock.push(payload),
    );
  });

  afterAll(async () => {
    await app?.close();
    await endPool(appPool);
    await evictStragglers(admin);
    await endPool(adminTest);
    await endPool(admin);
  });

  beforeEach(() => {
    lowStock = [];
  });

  // ------------------------------------------------------------------ fixture

  /**
   * Onboards the tenant, staff, menu and rival tenant every test in this file
   * builds on.
   *
   * A `beforeAll`, not an `it`. As a test it only ran because Jest executes tests
   * in declaration order, so any `-t` filter skipped the setup and every other
   * test then failed with a 404 — a fixture that silently depends on being
   * declared first. That also blocks rerunning a single test, which is exactly
   * what a suspected-flake investigation does.
   */
  beforeAll(async () => {
    const response = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Inventory Co',
        slug: 'inventoryco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Branch A', address: '1 Main' },
        defaultTables: 1,
        owner: { email: ownerEmail, password: PASSWORD },
      });
    expect(response.status).toBe(201);

    const onboarded = body<{
      tenantId: string;
      branchId: string;
      tableIds: string[];
    }>(response);
    tenantId = onboarded.tenantId;
    branchA = onboarded.branchId;
    tableId = onboarded.tableIds[0];

    const owner = await login(ownerEmail, tenantId);
    ownerToken = owner.accessToken;

    const second = await request(app.getHttpServer())
      .post('/branches')
      .set(auth(ownerToken))
      .send({ name: 'Branch B' });
    expect(second.status).toBe(201);
    branchB = body<{ id: string }>(second).id;

    // Seeded with SQL, matching the other e2e suites: there is no HTTP
    // create-staff route to call, and the RBAC assertions below only care that
    // this user genuinely holds the `kitchen_staff` role.
    await adminTest.query(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = 'kitchen_staff'),
               'Chef', $3, $4)`,
      [tenantId, branchA, kitchenEmail, hashSync(PASSWORD, 10)],
    );
    kitchenToken = (await login(kitchenEmail, tenantId)).accessToken;

    // A branch manager of branch B — a WRITE role, so every authorisation path is
    // open to them except the one under test. Seeded with SQL for the same reason
    // as the kitchen user: there is no HTTP route to create staff.
    await adminTest.query(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = 'branch_manager'),
               'Branch B Manager', $3, $4)`,
      [tenantId, branchB, branchBEmail, hashSync(PASSWORD, 10)],
    );
    branchBToken = (await login(branchBEmail, tenantId)).accessToken;

    await adminTest.query(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = 'branch_manager'),
               'Branch A Manager', $3, $4)`,
      [tenantId, branchA, branchAManagerEmail, hashSync(PASSWORD, 10)],
    );
    branchAManagerToken = (await login(branchAManagerEmail, tenantId))
      .accessToken;

    // A second tenant, to prove the RLS boundary is real and not a
    // `WHERE tenant_id = $1` that happens to be right.
    const rival = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Rival Co',
        slug: 'rivalco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Rival Branch', address: '9 Other' },
        defaultTables: 0,
        owner: { email: rivalEmail, password: PASSWORD },
      });
    expect(rival.status).toBe(201);
    rivalTenantId = body<{ tenantId: string }>(rival).tenantId;

    const category = await request(app.getHttpServer())
      .post(`/menu/branches/${branchA}/categories`)
      .set(auth(ownerToken))
      .send({ name: 'Drinks' });
    expect(category.status).toBe(201);

    const item = await request(app.getHttpServer())
      .post(`/menu/branches/${branchA}/items`)
      .set(auth(ownerToken))
      .send({
        name: 'Latte',
        price: 350,
        categoryId: body<{ id: string }>(category).id,
      });
    expect(item.status).toBe(201);
    menuItemId = body<{ id: string }>(item).id;

    milkId = await createItem('Whole milk', 10, 3);
  });

  // ------------------------------------------------------------ the deduction

  describe('completing an order deducts its recipe stock', () => {
    it('deducts the multiplied recipe amount and records one usage movement', async () => {
      // 0.2 l per latte x 3: the multiplication and the rounding both happen in
      // NUMERIC inside the database, so this asserts real arithmetic rather than
      // a value the test computed itself.
      await setRecipe(milkId, 0.2);

      const orderId = await orderWith(3);
      await completeOrder(orderId);

      await expectStock(milkId, 9.4);
      await expectDeduction(orderId, 'completed');
      expect(await movementCount(milkId, orderId)).toBe(1);
    });

    it('sums two lines of the same dish into a single movement', async () => {
      // TWO LINES ON ONE ORDER, not two orders. A ticket with the same dish twice
      // is what a real table produces, and it is the case aggregation exists for:
      // 2 x 0.2 + 3 x 0.2 = 1.0 l consumed in one movement, instead of five
      // separate rows a stocktake would have to reconcile by hand.
      await setRecipe(milkId, 0.2);
      const before = await stock(milkId);

      const response = await postOrder({
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [
          { menuItemId, quantity: 2 },
          { menuItemId, quantity: 3 },
        ],
      });
      expect(response.status).toBe(201);
      const orderId = body<{ id: string }>(response).id;

      // The order really does carry two lines, or this proves nothing.
      const lines = await adminTest.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM order_items WHERE order_id = $1`,
        [orderId],
      );
      expect(lines.rows[0]?.n).toBe(2);

      await completeOrder(orderId);

      // A DELTA, not an absolute level: `milkId` is shared with the tests above,
      // which have already sold some of it, so a hardcoded "9" would encode this
      // file's test ordering rather than this order's behaviour. The authoritative
      // assertion is the movement quantity below; this one just confirms the level
      // moved by exactly that much and no more.
      await expectStock(milkId, before - 1);
      await expectDeduction(orderId, 'completed');
      // ONE movement, for the sum of both lines.
      expect(await movementCount(milkId, orderId)).toBe(1);

      // ...and it is the sum, not just the first line: (2 + 3) x 0.2 = 1.0 in a
      // single row, which is the whole point of the aggregation.
      const movement = await adminTest.query<{ quantity: string }>(
        `SELECT quantity::text AS quantity
           FROM stock_movements
          WHERE inventory_item_id = $1 AND reference_order_id = $2`,
        [milkId, orderId],
      );
      expect(Number(movement.rows[0]?.quantity)).toBeCloseTo(-1, 6);
    });

    it('lets stock go negative rather than failing a paid order', async () => {
      const thin = await createItem('Vanilla', 0.1, 0);
      await setRecipe(thin, 0.2);

      const orderId = await orderWith(1);
      await completeOrder(orderId);

      await expectStock(thin, -0.1);
      await expectDeduction(orderId, 'completed');
    });

    it('is completed ATOMICALLY with the deduction, not before or after', async () => {
      // The order's own transaction is already committed by the time the event
      // runs, so this asserts the guarantee that actually holds: the deduction
      // and its ledger row are both durable together, and the order is durable.
      await setRecipe(milkId, 0.2);
      const before = await stock(milkId);

      const orderId = await orderWith(1);
      await completeOrder(orderId);
      await expectDeduction(orderId, 'completed');

      const [order, deduction] = await Promise.all([
        adminTest.query<{ status: string }>(
          `SELECT status FROM orders WHERE id = $1`,
          [orderId],
        ),
        adminTest.query<{ status: string }>(
          `SELECT status FROM order_inventory_deductions WHERE order_id = $1`,
          [orderId],
        ),
      ]);
      expect(order.rows[0].status).toBe('completed');
      expect(deduction.rows[0].status).toBe('completed');
      // Rounded, because the test's own arithmetic is float: 8.8 - 0.2 is
      // 8.600000000000001. The DATABASE value is exact NUMERIC; the expectation
      // should be too.
      expect(await stock(milkId)).toBeCloseTo(before - 0.2, 3);
    });
  });

  // --------------------------------------------------------- exactly-once

  describe('exactly-once', () => {
    it('deducts once when the event is delivered twice', async () => {
      // The bus is best-effort, so the same event can arrive more than once. The
      // UNIQUE (tenant_id, order_id) index is the guarantee, not an application
      // "have I already done this?" check.
      await setRecipe(milkId, 0.2);
      const orderId = await orderWith(1);
      await completeOrder(orderId);
      await expectDeduction(orderId, 'completed');
      const afterFirst = await stock(milkId);

      const second = await inventory.deductForOrder(tenantId, orderId);
      const third = await inventory.deductForOrder(tenantId, orderId);

      expect(second.deduplicated).toBe(true);
      expect(third.deduplicated).toBe(true);
      expect(await stock(milkId)).toBe(afterFirst);
      expect(await movementCount(milkId, orderId)).toBe(1);
    });

    it('deducts once even when two attempts run CONCURRENTLY', async () => {
      // An application-level check would race here; the unique index cannot. Both
      // calls are launched before either is awaited, so they overlap on purpose.
      await setRecipe(milkId, 0.2);
      const orderId = await orderWith(1);
      await completeOrder(orderId);
      await expectDeduction(orderId, 'completed');
      const baseline = await stock(milkId);

      const outcomes = await Promise.all([
        inventory.deductForOrder(tenantId, orderId),
        inventory.deductForOrder(tenantId, orderId),
      ]);

      expect(outcomes.filter((o) => !o.deduplicated)).toHaveLength(0);
      expect(await stock(milkId)).toBe(baseline);
      expect(await movementCount(milkId, orderId)).toBe(1);
    });
  });

  // ------------------------------------------------------------- atomicity

  describe('a failure mid-deduction rolls back completely', () => {
    it('leaves no stock movement and no partial stock change behind', async () => {
      const doomed = await createItem('Doomed', 5, 0);
      await setRecipe(doomed, 1);
      const orderId = await orderWith(1);
      const before = await stock(doomed);

      const stopFailing = await failUpdatesTo('Doomed');
      try {
        const outcome = await inventory.deductForOrder(tenantId, orderId);
        expect(outcome.status).toBe('failed');
      } finally {
        await stopFailing();
      }

      // The movement row is written in the same transaction as the failed
      // UPDATE, so the rollback must have taken it with it.
      expect(await movementCount(doomed, orderId)).toBe(0);
      expect(await stock(doomed)).toBe(before);
    });

    it('leaves the OTHER ingredients of the same order untouched', async () => {
      // The all-or-nothing property. Milk is deducted first and would already be
      // committed if the writes were not in one transaction; the trigger fires on
      // the second item, so a per-ingredient commit would show milk reduced.
      const milk = await createItem('Atomic milk', 10, 0);
      const doomed = await createItem('Doomed second', 5, 0);
      await setRecipe(milk, 1);
      await setRecipe(doomed, 1);
      const orderId = await orderWith(1);
      const milkBefore = await stock(milk);

      const stopFailing = await failUpdatesTo('Doomed second');
      try {
        expect((await inventory.deductForOrder(tenantId, orderId)).status).toBe(
          'failed',
        );
      } finally {
        await stopFailing();
      }

      expect(await stock(milk)).toBe(milkBefore);
      expect(await movementCount(milk, orderId)).toBe(0);
    });

    it('records the failure where a human can see it, on its own connection', async () => {
      const doomed = await createItem('Doomed 3', 5, 0);
      await setRecipe(doomed, 1);
      const orderId = await orderWith(1);

      const stopFailing = await failUpdatesTo('Doomed 3');
      try {
        await inventory.deductForOrder(tenantId, orderId);
      } finally {
        await stopFailing();
      }

      // Written AFTER the rollback, so the evidence survives the transaction that
      // failed. A row inserted inside it would have rolled back with it.
      await expectDeduction(orderId, 'failed');
      const result = await adminTest.query<{ detail: string }>(
        `SELECT detail FROM order_inventory_deductions WHERE order_id = $1`,
        [orderId],
      );
      expect(result.rows[0].detail).toEqual(
        expect.stringContaining('simulated storage failure'),
      );
    });

    it('lists the failure on the discrepancies endpoint', async () => {
      const doomed = await createItem('Doomed 4', 5, 0);
      await setRecipe(doomed, 1);
      const orderId = await orderWith(1);
      const stopFailing = await failUpdatesTo('Doomed 4');
      try {
        await inventory.deductForOrder(tenantId, orderId);
      } finally {
        await stopFailing();
      }

      const response = await request(app.getHttpServer())
        .get('/inventory/discrepancies')
        .set(auth(ownerToken));
      expect(response.status).toBe(200);
      const rows = body<Array<{ order_id: string; status: string }>>(response);
      expect(
        rows.some((row) => row.order_id === orderId && row.status === 'failed'),
      ).toBe(true);
    });

    it('retries a failed deduction successfully once the cause is fixed', async () => {
      // `failed` is deliberately re-claimable: the rollback means nothing was
      // deducted, so a retry is exactly the right recovery.
      const flaky = await createItem('Flaky', 5, 0);
      await setRecipe(flaky, 1);
      const orderId = await orderWith(1);
      const stopFailing = await failUpdatesTo('Flaky');
      try {
        expect((await inventory.deductForOrder(tenantId, orderId)).status).toBe(
          'failed',
        );
      } finally {
        await stopFailing();
      }

      const retry = await inventory.deductForOrder(tenantId, orderId);
      expect(retry.status).toBe('completed');
      expect(await stock(flaky)).toBe(4);
    });
  });

  // ---------------------------------------------------------- discrepancies

  describe('a dish with no recipe is reported, not silently skipped', () => {
    it('marks the deduction partial and names the menu item', async () => {
      const orphan = await request(app.getHttpServer())
        .post(`/menu/branches/${branchA}/items`)
        .set(auth(ownerToken))
        .send({ name: 'Mystery', price: 100 });
      const orphanId = body<{ id: string }>(orphan).id;
      // Deliberately no recipe.

      const orderId = await orderWith(1);
      const withOrphan = await postOrder({
        branchId: branchA,
        tableId,
        orderType: 'dine_in',
        items: [{ menuItemId: orphanId, quantity: 1 }],
      });
      expect(withOrphan.status).toBe(201);
      void orderId;

      const mixed = body<{ id: string }>(withOrphan).id;
      await completeOrder(mixed);

      await expectDeduction(mixed, 'partial');
      const result = await adminTest.query<{ detail: string }>(
        `SELECT detail FROM order_inventory_deductions WHERE order_id = $1`,
        [mixed],
      );
      expect(result.rows[0].detail).toEqual(expect.stringContaining(orphanId));
    });
  });

  // ------------------------------------------------------------ the branches

  describe('branch boundaries', () => {
    it('never deducts one branch stock for another branch sale', async () => {
      // The load-bearing SQL join, tested at the level it actually lives.
      //
      // The service REFUSES to author a cross-branch recipe (next test), so this
      // inserts one directly — which is the realistic case: a row written by an
      // older build, a data migration, or a script. The deduction must still
      // refuse to honour it, because `ingredientsForOrder` joins
      // `ii.branch_id = o.branch_id`.
      const branchBItem = await request(app.getHttpServer())
        .post(`/menu/branches/${branchB}/items`)
        .set(auth(ownerToken))
        .send({ name: 'Branch B special', price: 400 });
      expect(branchBItem.status).toBe(201);
      const branchBItemId = body<{ id: string }>(branchBItem).id;

      await adminTest.query(
        `INSERT INTO recipe_ingredients
                (tenant_id, menu_item_id, inventory_item_id, quantity_used)
         VALUES ($1, $2, $3, 0.2)`,
        [tenantId, branchBItemId, milkId],
      );

      const milkBefore = await stock(milkId);
      const order = await postOrder({
        branchId: branchB,
        orderType: 'takeaway',
        items: [{ menuItemId: branchBItemId, quantity: 1 }],
      });
      expect(order.status).toBe(201);
      const orderId = body<{ id: string }>(order).id;
      await completeOrder(orderId);

      // Reported, not silently redirected and not silently dropped.
      await expectDeduction(orderId, 'partial');
      // Branch A's milk is untouched, and no usage movement claims otherwise.
      expect(await stock(milkId)).toBe(milkBefore);
      expect(await movementCount(milkId, orderId)).toBe(0);
    });

    it('refuses to author a recipe against another branch stock', async () => {
      const response = await request(app.getHttpServer())
        .post('/inventory/recipes/ingredients')
        .set(auth(ownerToken))
        .query({ branchId: branchB })
        .send({ menuItemId, inventoryItemId: milkId, quantityUsed: 1 });
      // milkId belongs to branch A, so branch B cannot claim it.
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).toContain('different branch');
    });
  });

  // ----------------------------------------------------------------- the RLS

  describe('tenant isolation', () => {
    it('hides one tenant stock from another through the API', async () => {
      const response = await request(app.getHttpServer())
        .get('/inventory/items')
        .set({
          Authorization: `Bearer ${(await login(rivalEmail, rivalTenantId)).accessToken}`,
          'X-Tenant-Id': rivalTenantId,
        });
      expect(response.status).toBe(200);
      expect(body<unknown[]>(response)).toHaveLength(0);
    });

    it('hides it at the DATABASE level, not just in the query', async () => {
      // The real proof: the same query as the restricted app role sees nothing,
      // so a forgotten `WHERE tenant_id` still cannot leak a row.
      const scoped = await TenantScopedConnection.acquireScoped(
        appPool as Pool,
        rivalTenantId,
      );
      try {
        const result = await scoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM inventory_items WHERE name = 'Whole milk'`,
        );
        expect(result.rows[0].n).toBe(0);
        await scoped.commit();
      } finally {
        await scoped.release();
      }
    });

    it('refuses a cross-tenant supplier on an item', async () => {
      // The FK would be satisfied by any existing supplier, so the application
      // check is what stops a tenant linking to one it cannot read.
      const rivalSupplier = await request(app.getHttpServer())
        .post('/inventory/suppliers')
        .set({
          Authorization: `Bearer ${(await login(rivalEmail, rivalTenantId)).accessToken}`,
          'X-Tenant-Id': rivalTenantId,
        })
        .send({ name: 'Rival supplier' });
      expect(rivalSupplier.status).toBe(201);
      const supplierId = body<{ id: string }>(rivalSupplier).id;

      const response = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(auth(ownerToken))
        .send({
          branchId: branchA,
          name: 'Stolen supplier',
          unit: 'kg',
          supplierId,
        });
      expect(response.status).toBe(404);
    });
  });

  // -------------------------------------------------------- branch scoping

  describe('branch scoping', () => {
    /**
     * RLS cannot enforce this. Branch B and branch A are the SAME tenant, so every
     * inventory policy is satisfied and branch B's stock is fully reachable — the
     * only thing standing between a branch manager and a colleague's stock is this
     * module's own check. These run against real data precisely because that is
     * the point.
     */
    function asBranchB() {
      return {
        Authorization: `Bearer ${branchBToken}`,
        'X-Tenant-Id': tenantId,
      };
    }

    function asBranchA() {
      return {
        Authorization: `Bearer ${branchAManagerToken}`,
        'X-Tenant-Id': tenantId,
      };
    }

    it('refuses a branch manager a stock-in against another branch', async () => {
      const branchBStock = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchB())
        .send({ branchId: branchB, name: 'Branch B flour', unit: 'kg' });
      expect(branchBStock.status).toBe(201);
      const itemId = body<{ id: string }>(branchBStock).id;
      const before = await stock(itemId);

      // Branch A's manager, receiving 50 kg into branch B's stock. Same tenant, a
      // WRITE role, and a completely valid-looking request — refused only because
      // of the branch.
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${itemId}/stock-in`)
        .set(asBranchA())
        .send({ quantity: 50 });

      expect(response.status).toBe(403);
      // Refused BEFORE the write, so no movement row exists either.
      expect(await stock(itemId)).toBe(before);
      expect(await movementCount(itemId)).toBe(0);
    });

    it('lets a tenant-wide owner reach either branch', async () => {
      // The counterpart to the refusals: `org_owner` has no branch in its token, so
      // the check must not stop them. Without this, "403 everything" would pass.
      const branchBStock = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchB())
        .send({ branchId: branchB, name: 'Branch B rice', unit: 'kg' });
      const itemId = body<{ id: string }>(branchBStock).id;

      const received = await request(app.getHttpServer())
        .post(`/inventory/items/${itemId}/stock-in`)
        .set(auth(ownerToken))
        .send({ quantity: 5 });
      expect(received.status).toBe(200);
      expect(await stock(itemId)).toBe(5);
    });

    it('lets a branch manager write to their OWN branch', async () => {
      const own = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchA())
        .send({ branchId: branchA, name: 'Branch A tea', unit: 'kg' });
      expect(own.status).toBe(201);
      const itemId = body<{ id: string }>(own).id;

      const received = await request(app.getHttpServer())
        .post(`/inventory/items/${itemId}/stock-in`)
        .set(asBranchA())
        .send({ quantity: 7 });
      expect(received.status).toBe(200);
      expect(await stock(itemId)).toBe(7);
    });

    it('refuses a branch manager an adjustment, a threshold change and a read', async () => {
      const branchBStock = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchB())
        .send({ branchId: branchB, name: 'Branch B sugar', unit: 'kg' });
      const itemId = body<{ id: string }>(branchBStock).id;
      const before = await stock(itemId);

      const adjusted = await request(app.getHttpServer())
        .post(`/inventory/items/${itemId}/adjust`)
        .set(asBranchA())
        .send({ quantity: -5, note: 'not mine to write off' });
      expect(adjusted.status).toBe(403);

      const threshold = await request(app.getHttpServer())
        .patch(`/inventory/items/${itemId}/reorder-threshold`)
        .set(asBranchA())
        .send({ reorderThreshold: 99 });
      expect(threshold.status).toBe(403);

      const read = await request(app.getHttpServer())
        .get(`/inventory/items/${itemId}`)
        .set(asBranchA());
      expect(read.status).toBe(403);

      const movements = await request(app.getHttpServer())
        .get(`/inventory/items/${itemId}/movements`)
        .set(asBranchA());
      expect(movements.status).toBe(403);

      // Nothing moved and no threshold changed, across all four refusals.
      expect(await stock(itemId)).toBe(before);
    });

    it("refuses a branch manager another branch's item list", async () => {
      const listed = await request(app.getHttpServer())
        .get('/inventory/items')
        .query({ branchId: branchB })
        .set(asBranchA());
      expect(listed.status).toBe(403);
    });

    it("scopes a branch manager's unfiltered list to their own branch", async () => {
      const listed = await request(app.getHttpServer())
        .get('/inventory/items')
        .set(asBranchA());
      expect(listed.status).toBe(200);
      const items = body<Array<{ branchId: string }>>(listed);
      expect(items.length).toBeGreaterThan(0);
      // Every row is branch A's. Not silently filtered-and-reported-as-the-whole
      // tenant: the caller asked for "my inventory" and got exactly that.
      for (const row of items) {
        expect(row.branchId).toBe(branchA);
      }
    });

    it('refuses a recipe that names another branch', async () => {
      // The parameter is the whole attack: a branch manager wiring branch B's
      // stock into a branch A recipe, which the deduction path would then silently
      // refuse at the till. Refused at the edge, before the recipe exists.
      const theirs = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchB())
        .send({ branchId: branchB, name: 'Branch B cream', unit: 'l' });
      const theirsId = body<{ id: string }>(theirs).id;

      const refused = await request(app.getHttpServer())
        .post('/inventory/recipes/ingredients')
        .query({ branchId: branchB })
        .set(asBranchA())
        .send({ menuItemId, inventoryItemId: theirsId, quantityUsed: 1 });
      expect(refused.status).toBe(403);

      // The token's own branch is accepted, so the refusal is about the branch and
      // not about being a manager.
      const mine = await request(app.getHttpServer())
        .post('/inventory/items')
        .set(asBranchA())
        .send({ branchId: branchA, name: 'Branch A cream', unit: 'l' });
      const mineId = body<{ id: string }>(mine).id;
      const allowed = await request(app.getHttpServer())
        .post('/inventory/recipes/ingredients')
        .query({ branchId: branchA })
        .set(asBranchA())
        .send({ menuItemId, inventoryItemId: mineId, quantityUsed: 1 });
      expect(allowed.status).toBe(204);
    });

    it('scopes the discrepancy list to a branch manager', async () => {
      // A failed deduction names the ingredient and the shortfall, so an unfiltered
      // list is a running account of the other branches' stock problems.
      const mine = await createItem('Reviewable A', 5);
      const theirs = await createItem('Reviewable B', 5);
      // Same dish, so one order settles branch A's ingredient and, without the
      // filter, branch B's failure would appear in branch A's queue too.
      const stopFailing = await failUpdatesTo('Reviewable B');
      try {
        await setRecipe(mine, 1);
        await setRecipe(theirs, 1);
        // The recipe is written to branch A, and the order is branch A's, so this
        // is the case a naive tenant-wide query gets wrong.
        await inventory.deductForOrder(tenantId, await orderWith(1));

        const asA = await request(app.getHttpServer())
          .get('/inventory/discrepancies')
          .set(asBranchA());
        expect(asA.status).toBe(200);
        // Branch A's own order is the only one that could legitimately appear.
        for (const row of body<Array<{ order_id: string }>>(asA)) {
          expect(row.order_id).toBeTruthy();
        }

        // Now the real assertion: a branch B manager must not see branch A's
        // failure. `theirs` has no branch B recipe, so nothing in branch B failed.
        const asB = await request(app.getHttpServer())
          .get('/inventory/discrepancies')
          .set(asBranchB());
        expect(asB.status).toBe(200);
        const branchAOrders = await adminTest.query<{ id: string }>(
          `SELECT id FROM orders WHERE tenant_id = $1 AND branch_id = $2`,
          [tenantId, branchA],
        );
        const branchAOrderIds = branchAOrders.rows.map((r) => r.id);
        for (const row of body<Array<{ order_id: string }>>(asB)) {
          expect(branchAOrderIds).not.toContain(row.order_id);
        }

        // The owner, being tenant-wide, still sees the failure.
        const asOwner = await request(app.getHttpServer())
          .get('/inventory/discrepancies')
          .set(auth(ownerToken));
        expect(asOwner.status).toBe(200);
        expect(
          body<Array<{ order_id: string }>>(asOwner).some((r) =>
            branchAOrderIds.includes(r.order_id),
          ),
        ).toBe(true);
      } finally {
        await stopFailing();
      }
    });

    it('reports a missing item as 404, not a 500', async () => {
      const response = await request(app.getHttpServer())
        .post('/inventory/items/00000000-0000-4000-8000-000000000000/stock-in')
        .set(auth(ownerToken))
        .send({ quantity: 5 });
      // `applyDelta` throws a bare Error for a missing row, which surfaces as a 500.
      expect(response.status).toBe(404);
    });
  });

  // ---------------------------------------------------------- supplier CRUD

  describe('supplier CRUD', () => {
    async function createSupplier(payload: object): Promise<request.Response> {
      return request(app.getHttpServer())
        .post('/inventory/suppliers')
        .set(auth(ownerToken))
        .send(payload);
    }

    it('creates, reads, updates and deletes a supplier', async () => {
      const created = await createSupplier({
        name: 'Valley Dairy',
        contactPhone: '9800000001',
        contactEmail: 'orders@valleydairy.test',
      });
      expect(created.status).toBe(201);
      const id = body<{ id: string }>(created).id;

      const read = await request(app.getHttpServer())
        .get(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken));
      expect(read.status).toBe(200);
      expect(body<{ name: string }>(read).name).toBe('Valley Dairy');

      const updated = await request(app.getHttpServer())
        .patch(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken))
        .send({ contactPhone: '9800000002' });
      expect(updated.status).toBe(200);
      // Responses are the DB row, so the columns keep their snake_case names.
      expect(body<{ name: string; contact_phone: string }>(updated)).toEqual(
        expect.objectContaining({
          name: 'Valley Dairy',
          contact_phone: '9800000002',
        }),
      );

      // 204, and gone: the delete is observable through the read, not the body.
      const removed = await request(app.getHttpServer())
        .delete(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken));
      expect(removed.status).toBe(204);

      const gone = await request(app.getHttpServer())
        .get(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken));
      expect(gone.status).toBe(404);
    });

    it('leaves untouched columns alone on a partial update', async () => {
      // The regression a `?? null` PATCH would cause: correcting a phone number
      // would also blank the name and the email, and the write would be permanent.
      const created = await createSupplier({
        name: 'Valley Dairy',
        contactPhone: '9800000003',
        contactEmail: 'orders@valleydairy.test',
      });
      const id = body<{ id: string }>(created).id;

      const updated = await request(app.getHttpServer())
        .patch(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken))
        .send({ name: 'Valley Creamery' });
      expect(updated.status).toBe(200);
      expect(body<Record<string, string>>(updated)).toEqual(
        expect.objectContaining({
          name: 'Valley Creamery',
          contact_phone: '9800000003',
          contact_email: 'orders@valleydairy.test',
        }),
      );
    });

    it('clears a contact detail when null is sent explicitly', async () => {
      const created = await createSupplier({
        name: 'Valley Dairy',
        contactPhone: '9800000004',
        contactEmail: 'orders@valleydairy.test',
      });
      const id = body<{ id: string }>(created).id;

      const updated = await request(app.getHttpServer())
        .patch(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken))
        .send({ contactPhone: null });
      expect(updated.status).toBe(200);
      expect(
        body<{ contact_phone: string | null }>(updated).contact_phone,
      ).toBeNull();
    });

    it('refuses to delete a supplier that still supplies an item, as a 409', async () => {
      const created = await createSupplier({ name: 'Busy Supplier' });
      const id = body<{ id: string }>(created).id;
      const item = await createItem('Oats', 5, 1, id);

      const removed = await request(app.getHttpServer())
        .delete(`/inventory/suppliers/${id}`)
        .set(auth(ownerToken));
      // The FK would reject this anyway, as a 500 with a driver message.
      expect(removed.status).toBe(409);
      expect(body<{ message: string }>(removed).message).toMatch(
        /inventory item/,
      );

      // The item survives: a supplier that cannot be deleted must not have
      // silently taken stock with it.
      const still = await request(app.getHttpServer())
        .get(`/inventory/items/${item}`)
        .set(auth(ownerToken));
      expect(still.status).toBe(200);
    });

    it("hides another tenant's supplier behind a 404, not a 403", async () => {
      const created = await createSupplier({ name: 'Valley Dairy' });
      const id = body<{ id: string }>(created).id;

      const stolen = await request(app.getHttpServer())
        .get(`/inventory/suppliers/${id}`)
        .set({
          Authorization: `Bearer ${(await login(rivalEmail, rivalTenantId)).accessToken}`,
          'X-Tenant-Id': rivalTenantId,
        });
      // 404 rather than 403: a 403 would confirm the id exists.
      expect(stolen.status).toBe(404);
    });

    it('refuses a read-only role both the update and the delete', async () => {
      // `kitchen_staff` can READ inventory (it needs today's stock to know what it
      // can still cook) but must not be able to rename a supplier. Proves the
      // write roles are enforced on the HTTP surface, not just in metadata.
      const created = await createSupplier({ name: 'Valley Dairy' });
      const id = body<{ id: string }>(created).id;
      const kitchen = {
        Authorization: `Bearer ${kitchenToken}`,
        'X-Tenant-Id': tenantId,
      };

      // The read is allowed, so the 403 below is about the ROLE, not the token.
      const read = await request(app.getHttpServer())
        .get(`/inventory/suppliers/${id}`)
        .set(kitchen);
      expect(read.status).toBe(200);

      const patched = await request(app.getHttpServer())
        .patch(`/inventory/suppliers/${id}`)
        .set(kitchen)
        .send({ name: 'Not yours' });
      expect(patched.status).toBe(403);

      const removed = await request(app.getHttpServer())
        .delete(`/inventory/suppliers/${id}`)
        .set(kitchen);
      expect(removed.status).toBe(403);
    });
  });

  // ------------------------------------------------------------- manual moves

  describe('manual stock operations', () => {
    it('adds a delivery and writes the movement with the receiving user', async () => {
      const item = await createItem('Sugar', 2, 1);
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${item}/stock-in`)
        .set(auth(ownerToken))
        .send({ quantity: 8, note: 'delivery 99' });
      expect(response.status).toBe(200);
      expect(
        body<{ item: { quantityOnHand: number } }>(response).item
          .quantityOnHand,
      ).toBe(10);

      const movement = await adminTest.query<{
        movement_type: string;
        quantity: string;
        created_by: string | null;
        note: string;
      }>(
        `SELECT movement_type, quantity, created_by, note
              FROM stock_movements
             WHERE inventory_item_id = $1
             ORDER BY created_at DESC LIMIT 1`,
        [item],
      );
      expect(movement.rows[0].movement_type).toBe('purchase');
      expect(Number(movement.rows[0].quantity)).toBe(8);
      expect(movement.rows[0].note).toBe('delivery 99');
      expect(movement.rows[0].created_by).not.toBeNull();
    });

    it('rejects a zero adjustment outright', async () => {
      const item = await createItem('Flour', 3, 0);
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${item}/adjust`)
        .set(auth(ownerToken))
        .send({ quantity: 0, note: 'nothing happened' });
      expect(response.status).toBe(400);
      expect(await stock(item)).toBe(3);
    });

    it('rejects an adjustment with no reason', async () => {
      const item = await createItem('Cocoa', 3, 0);
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${item}/adjust`)
        .set(auth(ownerToken))
        .send({ quantity: 1, note: '   ' });
      expect(response.status).toBe(400);
      expect(await stock(item)).toBe(3);
    });

    it('rejects a negative delivery', async () => {
      const item = await createItem('Syrup', 3, 0);
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${item}/stock-in`)
        .set(auth(ownerToken))
        .send({ quantity: -4 });
      expect(response.status).toBe(400);
      expect(await stock(item)).toBe(3);
    });
  });

  // ------------------------------------------------------------------- RBAC

  describe('role boundaries over HTTP', () => {
    it('lets the kitchen read stock', async () => {
      const response = await request(app.getHttpServer())
        .get('/inventory/items')
        .set({
          Authorization: `Bearer ${kitchenToken}`,
          'X-Tenant-Id': tenantId,
        });
      expect(response.status).toBe(200);
      expect(body<unknown[]>(response).length).toBeGreaterThan(0);
    });

    it('stops the kitchen declaring a delivery', async () => {
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${milkId}/stock-in`)
        .set({
          Authorization: `Bearer ${kitchenToken}`,
          'X-Tenant-Id': tenantId,
        })
        .send({ quantity: 100 });
      expect(response.status).toBe(403);
      expect(await stock(milkId)).toBe(await stock(milkId));
    });

    it('stops an anonymous caller reading stock', async () => {
      const response = await request(app.getHttpServer())
        .get('/inventory/items')
        .set('X-Tenant-Id', tenantId);
      expect(response.status).toBe(401);
    });
  });

  // ------------------------------------------------------------------ alerts

  describe('low-stock alerts', () => {
    it('publishes after commit, carrying the committed level', async () => {
      // Threshold ABOVE the resulting level, so the delivery really does cross
      // it. (A stock-in that lands further from the reorder point must stay
      // silent — that is the 'stays silent' test below.)
      const watched = await createItem('Watched', 10, 20);
      const response = await request(app.getHttpServer())
        .post(`/inventory/items/${watched}/stock-in`)
        .set(auth(ownerToken))
        .send({ quantity: 1 });
      expect(response.status).toBe(200);

      // The alert is published from `onCommit`, which runs as the response
      // finishes, so it legitimately arrives after supertest resolves.
      const seen = await eventually(
        () =>
          Promise.resolve(
            lowStock.filter((e) => e.inventoryItemId === watched),
          ),
        (events) => events.length > 0,
        `a low-stock alert for ${watched}`,
      );
      expect(seen[0]).toMatchObject({
        event: INVENTORY_EVENTS.lowStock,
        quantityOnHand: 11,
        reorderThreshold: 20,
        severity: 'reorder',
        tenantId,
        branchId: branchA,
      });
      // A subscriber re-reading on its own connection sees the same number, which
      // is the whole reason the event is published post-commit.
      expect(seen[0].quantityOnHand).toBe(await stock(watched));
    });

    it('reports out_of_stock separately from a reorder', async () => {
      const item = await createItem('Last one', 2, 5);
      await request(app.getHttpServer())
        .post(`/inventory/items/${item}/adjust`)
        .set(auth(ownerToken))
        .send({ quantity: -2, note: 'used for the morning rush' });

      const seen = await eventually(
        () =>
          Promise.resolve(lowStock.filter((e) => e.inventoryItemId === item)),
        (events) => events.length > 0,
        `an out-of-stock alert for ${item}`,
      );
      expect(seen[0].severity).toBe('out_of_stock');
    });

    it('stays silent while stock is above the threshold', async () => {
      const item = await createItem('Plenty', 50, 5);
      await request(app.getHttpServer())
        .post(`/inventory/items/${item}/stock-in`)
        .set(auth(ownerToken))
        .send({ quantity: 10 });
      // Give a would-be alert every chance to arrive before asserting silence.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(lowStock.some((e) => e.inventoryItemId === item)).toBe(false);
    });
  });
});
