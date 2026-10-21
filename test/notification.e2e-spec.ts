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
import { CRM_EVENTS, type CrmPromotionEvent } from './../src/crm';
import {
  INVENTORY_EVENTS,
  type InventoryLowStockEvent,
} from './../src/inventory';
import {
  NOTIFICATION_DELIVERY_GATEWAY,
  type NotificationDelivery,
  type NotificationDeliveryGateway,
} from './../src/notification';
import { ORDER_EVENTS, type OrderStatusChangedEvent } from './../src/order';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * NotificationModule acceptance tests against a fresh Postgres database: real
 * migrations 001..016, a restricted (RLS-subject) app role, the full Nest app,
 * the real event bus and the in-memory queue. Requires Postgres; skipped when
 * no `DATABASE_*` env vars are present.
 *
 * The provider is replaced with a recording fake so "which channel and what
 * message" is observable. Everything above the gateway — listeners, service,
 * opt-out, queue, retries, DLQ — is the production code path.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'notification_ci';
const APP_ROLE = 'cafe_notification_app';
const APP_PASSWORD = 'cafe_notification_secret';
const PASSWORD = 'Password123!';
const PLAN_STARTER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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
  pool.on('error', () => undefined);
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

describeWithDb('NotificationModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  let events: EventEmitter2;

  const deliveries: NotificationDelivery[] = [];
  const forcedFailures = new Set<string>();
  const gateway: NotificationDeliveryGateway = {
    deliver(delivery) {
      deliveries.push(delivery);
      if (forcedFailures.has(delivery.recipient)) {
        return Promise.reject(new Error('forced provider failure'));
      }
      return Promise.resolve();
    },
  };

  const previousRedisUrl = process.env.REDIS_URL;
  const previousBackoff = process.env.NOTIFICATION_RETRY_BACKOFF_MS;
  const previousAttempts = process.env.NOTIFICATION_RETRY_ATTEMPTS;

  const ownerEmail = 'notification-owner@cafe.test';
  const managerEmail = 'notification-manager@cafe.test';
  const waiterEmail = 'notification-waiter@cafe.test';
  const rivalEmail = 'notification-rival@cafe.test';

  let tenantId = '';
  let branchId = '';
  let rivalTenantId = '';
  let ownerToken = '';
  let waiterToken = '';
  let rivalToken = '';
  let sequence = 0;

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
    return response.body as LoginResult;
  }

  async function seedUser(role: string, email: string, name: string) {
    await adminTest.query(
      `INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES ($1, $2, (SELECT id FROM roles WHERE name = $3), $4, $5, $6)`,
      [tenantId, branchId, role, name, email, hashSync(PASSWORD, 10)],
    );
  }

  async function createCustomer(
    overrides: Partial<{
      phone: string;
      email: string;
      fullName: string;
      pushToken: string;
      optOut: boolean;
      preferredChannel: string | null;
      dateOfBirth: string;
    }> = {},
  ): Promise<{
    id: string;
    phone: string;
    email: string | null;
    date_of_birth: string | null;
  }> {
    sequence += 1;
    const phone =
      overrides.phone ?? `98100000${String(sequence).padStart(2, '0')}`;
    const response = await request(app.getHttpServer())
      .post('/customers')
      .set(auth(ownerToken))
      .send({
        phone,
        email: overrides.email ?? `customer-${sequence}@example.test`,
        fullName: overrides.fullName ?? `Customer ${sequence}`,
        ...(overrides.dateOfBirth
          ? { dateOfBirth: overrides.dateOfBirth }
          : {}),
      });
    expect(response.status).toBe(200);
    const body = response.body as {
      customer: {
        id: string;
        phone: string;
        email: string | null;
        date_of_birth: string | null;
      };
    };

    await adminTest.query(
      `UPDATE customers
          SET push_token = $2,
              notification_opt_out = $3,
              notification_channel = $4
        WHERE tenant_id = $1 AND id = $5`,
      [
        tenantId,
        overrides.pushToken ?? null,
        overrides.optOut ?? false,
        overrides.preferredChannel ?? null,
        body.customer.id,
      ],
    );

    return body.customer;
  }

  async function createPromotion(
    code: string,
    overrides: Partial<{
      description: string | null;
      isActive: boolean;
    }> = {},
  ): Promise<{ id: string; code: string }> {
    const response = await request(app.getHttpServer())
      .post('/promotions')
      .set(auth(ownerToken))
      .send({
        code,
        description:
          overrides.description === undefined
            ? 'Ten percent off this week'
            : overrides.description,
        discountType: 'percentage',
        discountValue: 10,
        isActive: overrides.isActive ?? true,
      });
    expect(response.status).toBe(201);
    return response.body as { id: string; code: string };
  }

  async function createOrder(
    customerId: string | null,
    orderType = 'takeaway',
    tenant = tenantId,
    branch = branchId,
  ): Promise<string> {
    const result = await adminTest.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, branch_id, customer_id, order_type, status,
                           subtotal, tax_amount, discount_amount, total_amount)
            VALUES ($1, $2, $3, $4, 'preparing', 100, 0, 0, 100)
         RETURNING id`,
      [tenant, branch, customerId, orderType],
    );
    return result.rows[0].id;
  }

  function readyEvent(
    orderId: string,
    eventTenant = tenantId,
  ): OrderStatusChangedEvent {
    return {
      event: ORDER_EVENTS.statusChanged,
      orderId,
      tenantId: eventTenant,
      branchId,
      previousStatus: 'preparing',
      newStatus: 'ready',
      tableId: null,
      orderType: 'takeaway',
      totalAmount: 100,
      occurredAt: new Date().toISOString(),
    };
  }

  function lowStockEvent(movementId: string): InventoryLowStockEvent {
    return {
      event: INVENTORY_EVENTS.lowStock,
      inventoryItemId: '99999999-9999-4999-8999-999999999999',
      tenantId,
      branchId,
      name: 'Milk',
      unit: 'litre',
      quantityOnHand: 0,
      reorderThreshold: 5,
      severity: 'out_of_stock',
      triggeredByMovementId: movementId,
      occurredAt: new Date().toISOString(),
    };
  }

  async function waitFor<T>(
    check: () => Promise<T | null> | T | null,
    timeoutMs = 5_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value !== null) {
        return value;
      }
      if (Date.now() >= deadline) {
        throw new Error('Timed out waiting for a notification.');
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
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
        ('${PLAN_STARTER}', 'starter', 3, 15, 2499)
    `);
    await adminTest.query(`
      INSERT INTO roles (name) VALUES
        ('super_admin'), ('org_owner'), ('branch_manager'),
        ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer')
    `);

    appPool = poolFor(TEST_DB, { user: APP_ROLE, password: APP_PASSWORD });

    // Force the deterministic in-memory driver and fast retries: this suite
    // proves the pipeline, not Redis itself (the BullMQ spec covers that).
    delete process.env.REDIS_URL;
    process.env.NOTIFICATION_RETRY_ATTEMPTS = '3';
    process.env.NOTIFICATION_RETRY_BACKOFF_MS = '10';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue(appPool)
      .overrideProvider(NOTIFICATION_DELIVERY_GATEWAY)
      .useValue(gateway)
      .compile();

    app = moduleRef.createNestApplication();
    app.useLogger(false);
    await app.init();
    await app.listen(0);
    events = app.get(EventEmitter2);
  });

  afterAll(async () => {
    await app?.close();
    await appPool?.end();
    await evictStragglers(admin);
    await adminTest?.end();
    await admin.end();

    if (previousRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = previousRedisUrl;
    }
    if (previousBackoff === undefined) {
      delete process.env.NOTIFICATION_RETRY_BACKOFF_MS;
    } else {
      process.env.NOTIFICATION_RETRY_BACKOFF_MS = previousBackoff;
    }
    if (previousAttempts === undefined) {
      delete process.env.NOTIFICATION_RETRY_ATTEMPTS;
    } else {
      process.env.NOTIFICATION_RETRY_ATTEMPTS = previousAttempts;
    }
  });

  beforeAll(async () => {
    const response = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Notification Co',
        slug: 'notificationco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Branch A', address: '1 Main' },
        defaultTables: 0,
        owner: { email: ownerEmail, password: PASSWORD },
      });
    expect(response.status).toBe(201);
    const onboarded = response.body as { tenantId: string; branchId: string };
    tenantId = onboarded.tenantId;
    branchId = onboarded.branchId;
    ownerToken = (await login(ownerEmail, tenantId)).accessToken;

    await seedUser('branch_manager', managerEmail, 'Maya Manager');
    await seedUser('waiter', waiterEmail, 'Waiter One');
    waiterToken = (await login(waiterEmail, tenantId)).accessToken;

    const rival = await request(app.getHttpServer())
      .post('/onboarding')
      .send({
        orgName: 'Rival Notification Co',
        slug: 'rivalnotificationco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Rival Branch', address: '9 Other' },
        defaultTables: 0,
        owner: { email: rivalEmail, password: PASSWORD },
      });
    expect(rival.status).toBe(201);
    rivalTenantId = (rival.body as { tenantId: string }).tenantId;
    rivalToken = (await login(rivalEmail, rivalTenantId)).accessToken;
  });

  it('sends push to a customer with a device token when the order is ready', async () => {
    const customer = await createCustomer({
      pushToken: 'device-token-e2e-1',
      email: 'push-customer@example.test',
    });
    const orderId = await createOrder(customer.id);

    await events.emitAsync(ORDER_EVENTS.statusChanged, readyEvent(orderId));

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'push' &&
            entry.recipient === 'device-token-e2e-1',
        ) ?? null,
    );
    expect(delivery.title).toBe('Your order is ready');
    expect(delivery.body).toContain(orderId.slice(0, 8));
    expect(delivery.data.orderId).toBe(orderId);
  });

  it('falls back to SMS when the customer has only a phone number', async () => {
    const customer = await createCustomer({
      phone: '9812345678',
      email: 'sms-customer@example.test',
    });
    const orderId = await createOrder(customer.id);

    await events.emitAsync(ORDER_EVENTS.statusChanged, readyEvent(orderId));

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'sms' && entry.recipient === '9812345678',
        ) ?? null,
    );
    expect(delivery.body).toContain('ready for pickup');
  });

  it('does not notify an opted-out customer, even when the event fires', async () => {
    const customer = await createCustomer({
      phone: '9811112233',
      pushToken: 'opted-out-device',
      optOut: true,
    });
    const orderId = await createOrder(customer.id);

    await events.emitAsync(ORDER_EVENTS.statusChanged, readyEvent(orderId));
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(
      deliveries.some(
        (entry) =>
          entry.recipient === 'opted-out-device' ||
          entry.recipient === '9811112233',
      ),
    ).toBe(false);
  });

  it('emails every branch manager when stock runs out', async () => {
    const event = lowStockEvent('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

    await events.emitAsync(INVENTORY_EVENTS.lowStock, event);

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'email' && entry.recipient === managerEmail,
        ) ?? null,
    );
    expect(delivery.title).toBe('Out of stock: Milk');
    expect(delivery.body).toContain('0 litre on hand');
  });

  it('routes a CRM promotion through the customer preference', async () => {
    const customer = await createCustomer({
      email: 'promo-customer@example.test',
      preferredChannel: 'email',
    });
    const promotion: CrmPromotionEvent = {
      event: CRM_EVENTS.promotion,
      tenantId,
      customerId: customer.id,
      promotionId: '77777777-7777-4777-8777-777777777777',
      code: 'TENOFF',
      description: 'Ten percent off this week',
      occurredAt: new Date().toISOString(),
    };

    await events.emitAsync(CRM_EVENTS.promotion, promotion);

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'email' &&
            entry.recipient === 'promo-customer@example.test',
        ) ?? null,
    );
    expect(delivery.body).toBe('TENOFF: Ten percent off this week');
  });

  it('never sends another tenant\u2019s customer a notification', async () => {
    // The event claims the rival tenant but points at OUR order. The scoped
    // read must find nothing rather than leaking branch/customer data.
    const customer = await createCustomer();
    const orderId = await createOrder(customer.id);

    await events.emitAsync(
      ORDER_EVENTS.statusChanged,
      readyEvent(orderId, rivalTenantId),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(deliveries.some((entry) => entry.recipient === customer.phone)).toBe(
      false,
    );
  });

  it('announces a promotion through the CRM publisher and honours opt-out', async () => {
    const promotion = await createPromotion('ANNOUNCE10');
    const recipient = await createCustomer({
      email: 'announce-recipient@example.test',
      preferredChannel: 'email',
      fullName: 'Announce Recipient',
    });
    const optedOut = await createCustomer({
      email: 'announce-opted-out@example.test',
      preferredChannel: 'email',
      optOut: true,
    });

    const response = await request(app.getHttpServer())
      .post(`/promotions/${promotion.id}/announce`)
      .set(auth(ownerToken))
      .send({ customerIds: [recipient.id, optedOut.id] });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      promotionId: promotion.id,
      code: 'ANNOUNCE10',
      published: 2,
    });

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'email' &&
            entry.recipient === 'announce-recipient@example.test',
        ) ?? null,
    );
    expect(delivery.body).toBe('ANNOUNCE10: Ten percent off this week');

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(
      deliveries.some(
        (entry) => entry.recipient === 'announce-opted-out@example.test',
      ),
    ).toBe(false);
  });

  it('stores a birthday on customer creation as a calendar day', async () => {
    const customer = await createCustomer({ dateOfBirth: '1990-04-12' });

    expect(customer.date_of_birth).toBe('1990-04-12');
  });

  it('greets a birthday after the counter records the date', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const customer = await createCustomer({
      email: 'birthday-customer@example.test',
      preferredChannel: 'email',
      fullName: 'Birthday Person',
    });

    const patched = await request(app.getHttpServer())
      .patch(`/customers/${customer.id}`)
      .set(auth(ownerToken))
      .send({ dateOfBirth: `1990-${today.slice(5)}` });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({
      date_of_birth: `1990-${today.slice(5)}`,
    });

    const announced = await request(app.getHttpServer())
      .post('/customers/birthdays/announce')
      .set(auth(ownerToken))
      .send({ date: today });
    expect(announced.status).toBe(200);
    expect(announced.body).toMatchObject({ date: today, published: 1 });

    const delivery = await waitFor(
      () =>
        deliveries.find(
          (entry) =>
            entry.channel === 'email' &&
            entry.recipient === 'birthday-customer@example.test',
        ) ?? null,
    );
    expect(delivery.title).toBe('Happy birthday, Birthday Person!');
  });

  it('refuses campaign sends from a waiter and an empty audience', async () => {
    const promotion = await createPromotion('WAITERNO');

    const waiterPromotion = await request(app.getHttpServer())
      .post(`/promotions/${promotion.id}/announce`)
      .set(auth(waiterToken))
      .send({});
    expect(waiterPromotion.status).toBe(403);

    const waiterBirthdays = await request(app.getHttpServer())
      .post('/customers/birthdays/announce')
      .set(auth(waiterToken))
      .send({});
    expect(waiterBirthdays.status).toBe(403);

    const emptyAudience = await request(app.getHttpServer())
      .post(`/promotions/${promotion.id}/announce`)
      .set(auth(ownerToken))
      .send({ customerIds: [] });
    expect(emptyAudience.status).toBe(400);
  });

  it('does not announce a promotion that cannot be applied', async () => {
    const promotion = await createPromotion('INACTIVE', { isActive: false });

    const response = await request(app.getHttpServer())
      .post(`/promotions/${promotion.id}/announce`)
      .set(auth(ownerToken))
      .send({});
    expect(response.status).toBe(422);
    expect((response.body as { message: string }).message).toContain(
      'inactive',
    );
  });

  it('retries a failed send and exposes the dead letter per tenant', async () => {
    const failingEmail = 'dead-letter-manager@cafe.test';
    await seedUser('branch_manager', failingEmail, 'Fail Manager');
    forcedFailures.add(failingEmail);

    const event = lowStockEvent('99999999-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    await events.emitAsync(INVENTORY_EVENTS.lowStock, event);

    const body = await waitFor(async () => {
      const response = await request(app.getHttpServer())
        .get('/notifications/dead-letter')
        .set(auth(ownerToken));
      expect(response.status).toBe(200);
      const payload = response.body as {
        driver: string;
        count: number;
        dead_letters: Array<{
          job: {
            recipient: string;
            eventKey: string;
          };
          failedReason: string;
          attemptsMade: number;
        }>;
      };
      return payload.count > 0 ? payload : null;
    });

    expect(body.driver).toBe('memory');
    const entry = body.dead_letters.find(
      (item) => item.job.recipient === failingEmail,
    );
    expect(entry).toMatchObject({
      failedReason: 'forced provider failure',
      attemptsMade: 3,
    });
    expect(entry?.job.eventKey).toContain(event.inventoryItemId);

    // The rival tenant cannot see our dead letter.
    const rivalList = await request(app.getHttpServer())
      .get('/notifications/dead-letter')
      .set(auth(rivalToken, rivalTenantId));
    expect(rivalList.status).toBe(200);
    expect((rivalList.body as { count: number }).count).toBe(0);

    // A waiter cannot inspect recipients at all.
    const waiterList = await request(app.getHttpServer())
      .get('/notifications/dead-letter')
      .set(auth(waiterToken));
    expect(waiterList.status).toBe(403);
  });
});
