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
import type { RenderedMenuNode } from './../src/menu/composite/menu-node';

/**
 * MenuModule acceptance tests against a fresh Postgres database: real
 * migrations 001..011, a restricted (RLS-subject) app role, then the full Nest
 * app booted with that pool. Requires a running Postgres; skipped when no
 * `DATABASE_*` env vars are present.
 *
 * Covers the four acceptance criteria from `.agent/docs/modules/04-menu-module.md`:
 *   1. an org-wide item resolves to its branch override only in that branch
 *   2. three stacked modifiers produce the mathematically correct total
 *   3. the composite tree renders for zero / empty / nested multi-category menus
 *   4. soft-delete preserves historical `order_items`
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'menu_ci';
const APP_ROLE = 'cafe_menu_app';
const APP_PASSWORD = 'cafe_menu_secret';
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

/**
 * Removes every trace of a previous run: kill anything still connected to the
 * test database, drop that database, THEN drop the app role. The order matters
 * — Postgres refuses `DROP ROLE` while the role has live sessions, and refuses
 * `DROP DATABASE` while it has live connections (hence `WITH (FORCE)`).
 * Failures are swallowed so teardown never masks a real test failure.
 */
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

describeWithDb('MenuModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  const hash = hashSync(PASSWORD, 10);

  let tenantId = '';
  let branchA = '';
  let branchB = '';
  let ownerToken = '';
  let waiterToken = '';
  const ownerEmail = 'menu-owner@cafe.test';
  const waiterEmail = 'menu-waiter@cafe.test';

  async function count(query: string, values: unknown[] = []): Promise<number> {
    const result = await adminTest.query<{ n: number }>(
      `SELECT count(*)::int AS n ${query}`,
      values,
    );
    return result.rows[0]?.n ?? 0;
  }

  function postCategory(token: string, body: object, branchId?: string) {
    const path = branchId
      ? `/menu/branches/${branchId}/categories`
      : '/menu/categories';
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function postItem(token: string, body: object, branchId?: string) {
    const path = branchId ? `/menu/branches/${branchId}/items` : '/menu/items';
    return request(app.getHttpServer())
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function postModifier(token: string, itemId: string, body: object) {
    return request(app.getHttpServer())
      .post(`/menu/items/${itemId}/modifiers`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  /** The customer-facing, unauthenticated read. */
  function publicMenu(branchId: string) {
    return request(app.getHttpServer())
      .get(`/menu/public/${branchId}`)
      .set('X-Tenant-Id', tenantId);
  }

  function staffMenu(token: string, branchId: string) {
    return request(app.getHttpServer())
      .get(`/menu/branches/${branchId}`)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', tenantId);
  }

  /**
   * supertest types `response.body` as `any`; every read goes through here so
   * the assertions stay typed and `no-unsafe-*` never fires.
   */
  function body<T>(response: request.Response): T {
    return response.body as T;
  }

  /** The rendered tree of a read, validated as a menu node array. */
  function treeOf(response: request.Response): RenderedMenuNode[] {
    const tree = body<RenderedMenuNode[]>(response);
    expect(Array.isArray(tree)).toBe(true);
    return tree;
  }

  function categories(tree: RenderedMenuNode[]): string[] {
    return tree
      .filter((node) => node.kind === 'category')
      .map((node) => {
        if (node.kind !== 'category') {
          throw new Error('unreachable');
        }
        return node.name;
      });
  }

  function itemsOf(
    tree: RenderedMenuNode[],
    categoryName: string,
  ): Array<{ id: string; name: string; price: number; basePrice: number }> {
    const category = tree.find(
      (node) => node.kind === 'category' && node.name === categoryName,
    );
    if (!category || category.kind !== 'category') {
      return [];
    }
    return category.items.map((row) => ({
      id: row.id,
      name: row.name,
      price: Number(row.price),
      basePrice: Number(row.basePrice),
    }));
  }

  async function login(
    email: string,
  ): Promise<{ status: number; body: Partial<LoginResult> }> {
    const response = await request(app.getHttpServer())
      .post('/auth/login')
      .set('X-Tenant-Id', tenantId)
      .send({ email, password: PASSWORD });
    return {
      status: response.status,
      body: response.body as Partial<LoginResult>,
    };
  }

  beforeAll(async () => {
    await admin.query('SELECT 1');

    // A previous run may have died before cleaning up. Postgres refuses to drop
    // a role that still has live sessions, so evict stragglers FIRST, then drop
    // the database (FORCE kills its connections), and only then the role —
    // otherwise a leftover `CREATE ROLE` failure cascades into every test.
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

    appPool = poolFor(TEST_DB, {
      user: APP_ROLE,
      password: APP_PASSWORD,
    });

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
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
  });

  afterAll(async () => {
    await app?.close();
    // The app pool is injected by hand, so Nest does NOT close it. Leaking it
    // keeps `cafe_menu_app` sessions alive, which makes the next run's
    // `DROP ROLE` fail — so it is ended explicitly.
    await endPool(appPool);
    await evictStragglers(admin);
    await endPool(adminTest);
    await endPool(admin);
  });

  describe('fixture', () => {
    it('onboards a tenant, adds a second branch, and authenticates owner + waiter', async () => {
      // 1. onboard the tenant (this creates tenant + branch A + the owner)
      const response = await request(app.getHttpServer())
        .post('/onboarding')
        .send({
          orgName: 'Menu Co',
          slug: 'menuco',
          planId: PLAN_STARTER,
          firstBranch: { name: 'Branch A', address: '1 Main' },
          defaultTables: 0,
          owner: { email: ownerEmail, password: PASSWORD },
        });
      expect(response.status).toBe(201);

      const body = response.body as TenantOnboardingResult;
      tenantId = body.tenantId;
      branchA = body.branchId;

      // 2. authenticate the owner BEFORE any authenticated call is made
      const owner = await login(ownerEmail);
      expect(owner.status).toBe(200);
      ownerToken = owner.body.accessToken ?? '';
      expect(owner.body.user).toMatchObject({ role: 'org_owner' });

      // 3. a second branch, so "org-wide vs override" has somewhere to differ
      const second = await request(app.getHttpServer())
        .post('/branches')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Branch B' });
      expect(second.status).toBe(201);
      branchB = (second.body as { id: string }).id;
      expect(branchB).not.toBe(branchA);

      // 4. a read-only staff member for the RBAC tests
      await adminTest.query(
        `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
         VALUES ('${tenantId}', '${branchA}',
                 (SELECT id FROM roles WHERE name = 'waiter'),
                 'Waiter', '${waiterEmail}', '${hash}')`,
      );

      const waiter = await login(waiterEmail);
      expect(waiter.status).toBe(200);
      waiterToken = waiter.body.accessToken ?? '';
      expect(waiter.body.user).toMatchObject({ role: 'waiter' });

      expect(tenantId).not.toBe('');
      expect(waiterToken).not.toBe('');
    });
  });

  describe('AC3 — composite tree shapes', () => {
    it('renders an empty menu for a tenant with no categories', async () => {
      const response = await publicMenu(branchA);

      expect(response.status).toBe(200);
      expect(treeOf(response)).toEqual([]);
    });

    it('renders a category that has no items', async () => {
      const created = await postCategory(ownerToken, { name: 'Empty' });
      expect(created.status).toBe(201);

      const response = await publicMenu(branchA);

      const tree = treeOf(response);
      expect(categories(tree)).toContain('Empty');
      const empty = tree.find(
        (node) => node.kind === 'category' && node.name === 'Empty',
      );
      expect(empty).toMatchObject({ kind: 'category', items: [] });
    });

    it('renders a nested multi-category menu in sort_order sequence', async () => {
      await postCategory(ownerToken, { name: 'Drinks', sortOrder: 1 });
      await postCategory(ownerToken, { name: 'Food', sortOrder: 2 });
      await postCategory(ownerToken, { name: 'Desserts', sortOrder: 3 });

      const drinks = await postItem(ownerToken, {
        name: 'Flat White',
        price: 3.5,
        categoryId: (
          await adminTest.query<{ id: string }>(
            `SELECT id FROM menu_categories WHERE tenant_id = $1 AND name = 'Drinks' AND branch_id IS NULL`,
            [tenantId],
          )
        ).rows[0].id,
      });
      expect(drinks.status).toBe(201);

      const response = await publicMenu(branchA);

      // 'Empty' was created earlier with the default sort_order of 0, so it
      // still leads the tree — the ordering is global, not per-test.
      expect(categories(treeOf(response))).toEqual([
        'Empty',
        'Drinks',
        'Food',
        'Desserts',
      ]);
      expect(
        itemsOf(treeOf(response), 'Drinks').map((row) => row.name),
      ).toEqual(['Flat White']);
    });
  });

  describe('AC2 — stacked modifiers', () => {
    it('sums three stacked modifiers onto the base price', async () => {
      const itemId = (
        await adminTest.query<{ id: string }>(
          `SELECT id FROM menu_items WHERE tenant_id = $1 AND name = 'Flat White' AND branch_id IS NULL`,
          [tenantId],
        )
      ).rows[0].id;

      expect(
        (
          await postModifier(ownerToken, itemId, {
            name: 'Size',
            optionName: 'Large',
            extraPrice: 0.75,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await postModifier(ownerToken, itemId, {
            name: 'Milk',
            optionName: 'Oat',
            extraPrice: 0.6,
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await postModifier(ownerToken, itemId, {
            name: 'Shot',
            optionName: 'Extra',
            extraPrice: 0.4,
          })
        ).status,
      ).toBe(201);

      const flatWhite = itemsOf(
        treeOf(await publicMenu(branchA)),
        'Drinks',
      ).find((row) => row.name === 'Flat White');

      // 3.50 + 0.75 + 0.60 + 0.40 = 5.25
      expect(flatWhite).toBeDefined();
      expect(flatWhite?.price).toBeCloseTo(5.25, 2);
      expect(flatWhite?.basePrice).toBe(3.5);

      const rendered = treeOf(await publicMenu(branchA));
      const drinks = rendered.find(
        (node) => node.kind === 'category' && node.name === 'Drinks',
      );
      expect(drinks?.kind).toBe('category');
      if (drinks?.kind !== 'category') {
        throw new Error('Drinks category missing');
      }
      const withModifiers = drinks.items.find(
        (row) => row.name === 'Flat White',
      );
      expect(withModifiers?.modifiers).toHaveLength(3);
    });
  });

  describe('AC1 — org-wide vs branch override', () => {
    it('resolves to the override in the overriding branch, org-wide elsewhere', async () => {
      // a branch-A override of the org-wide "Flat White" at a premium price
      const drinksId = (
        await adminTest.query<{ id: string }>(
          `SELECT id FROM menu_categories WHERE tenant_id = $1 AND name = 'Drinks' AND branch_id IS NULL`,
          [tenantId],
        )
      ).rows[0].id;
      const override = await postItem(
        ownerToken,
        { name: 'Flat White', price: 4.25, categoryId: drinksId },
        branchA,
      );
      expect(override.status).toBe(201);

      // branch A sees the override, and ONLY the override: the branch row
      // replaces the org item outright, so it does not inherit the org item's
      // three modifiers either.
      const inA = itemsOf(treeOf(await publicMenu(branchA)), 'Drinks');
      expect(inA).toHaveLength(1);
      expect(inA[0].basePrice).toBeCloseTo(4.25, 2);
      expect(inA[0].price).toBeCloseTo(4.25, 2);

      // branch B has no override, so it still resolves the ORG row — and the
      // org row keeps its own three modifiers: 3.50 + 0.75 + 0.60 + 0.40
      const inB = itemsOf(treeOf(await publicMenu(branchB)), 'Drinks');
      expect(inB).toHaveLength(1);
      expect(inB[0].basePrice).toBeCloseTo(3.5, 2);
      expect(inB[0].price).toBeCloseTo(5.25, 2);
    });

    it('hides a branch-only item from every other branch', async () => {
      const drinksId = (
        await adminTest.query<{ id: string }>(
          `SELECT id FROM menu_categories WHERE tenant_id = $1 AND name = 'Drinks' AND branch_id IS NULL`,
          [tenantId],
        )
      ).rows[0].id;
      const secret = await postItem(
        ownerToken,
        { name: 'Branch A Secret', price: 99, categoryId: drinksId },
        branchA,
      );
      expect(secret.status).toBe(201);

      const namesIn = async (branchId: string): Promise<string[]> =>
        itemsOf(treeOf(await publicMenu(branchId)), 'Drinks').map(
          (row) => row.name,
        );

      expect(await namesIn(branchA)).toContain('Branch A Secret');
      expect(await namesIn(branchB)).not.toContain('Branch A Secret');
    });
  });

  describe('AC4 — soft delete preserves history', () => {
    it('soft-deleting an item keeps it and its order_items intact', async () => {
      // an item that will be soft-deleted
      const drinksId = (
        await adminTest.query<{ id: string }>(
          `SELECT id FROM menu_categories WHERE tenant_id = $1 AND name = 'Drinks' AND branch_id IS NULL`,
          [tenantId],
        )
      ).rows[0].id;
      const doomed = await postItem(ownerToken, {
        name: 'Retired Special',
        price: 5,
        categoryId: drinksId,
      });
      expect(doomed.status).toBe(201);
      const doomedId = (doomed.body as { id: string }).id;

      // a historical order line pointing at it
      const orderRes = await adminTest.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, branch_id, total_amount) VALUES ($1, $2, 5) RETURNING id`,
        [tenantId, branchA],
      );
      const orderId = orderRes.rows[0].id;
      await adminTest.query(
        `INSERT INTO order_items (tenant_id, order_id, menu_item_id, quantity, unit_price)
         VALUES ($1, $2, $3, 1, 5)`,
        [tenantId, orderId, doomedId],
      );

      // soft-delete it
      const del = await request(app.getHttpServer())
        .patch(`/menu/items/${doomedId}/availability`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ isAvailable: false });
      expect(del.status).toBe(200);
      expect((del.body as { is_available: boolean }).is_available).toBe(false);

      // the row still exists (soft delete, not hard delete)
      expect(await count(`FROM menu_items WHERE id = '${doomedId}'`)).toBe(1);
      // the historical order line still resolves
      expect(
        await count(`FROM order_items WHERE menu_item_id = '${doomedId}'`),
      ).toBe(1);
    });
  });

  describe('RBAC + public endpoint', () => {
    it('rejects a non-manager (waiter) writing to the menu', async () => {
      const response = await postCategory(waiterToken, { name: 'Nope' });

      expect(response.status).toBe(403);
    });

    it('rejects an unauthenticated write', async () => {
      const response = await request(app.getHttpServer())
        .post('/menu/categories')
        .set('X-Tenant-Id', tenantId)
        .send({ name: 'Nope' });

      expect(response.status).toBe(401);
    });

    it('lets a waiter read the staff menu', async () => {
      const response = await staffMenu(waiterToken, branchA);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('lets an anonymous customer read the public menu (still tenant scoped)', async () => {
      const response = await publicMenu(branchA);

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('never leaks branch-scoped rows to a branch that does not own them', async () => {
      // a branch id belonging to no branch of this tenant. Org-wide rows
      // (branch_id IS NULL) legitimately apply everywhere, so the assertion is
      // NOT "empty" — it is that no branch-scoped row from another branch
      // appears, and nothing is attributed to the foreign branch id.
      const foreignBranch = '00000000-0000-4000-8000-000000000000';
      const response = await publicMenu(foreignBranch);

      expect(response.status).toBe(200);

      const tree = treeOf(response);
      const renderedItems = tree.flatMap((node) =>
        node.kind === 'category' ? node.items : [],
      );
      const names = renderedItems.map((row) => row.name);

      // branch A's branch-only item must not surface here
      expect(names).not.toContain('Branch A Secret');
      // org-wide rows DO apply (that is the point of branch_id IS NULL), so
      // "Flat White" legitimately appears — but only ever as the ORG row, and
      // nothing may be attributed to the foreign branch id.
      expect(renderedItems.every((row) => row.branchId === null)).toBe(true);
      expect(
        tree.every(
          (node) => node.kind !== 'category' || node.branchId === null,
        ),
      ).toBe(true);
    });
  });
});
