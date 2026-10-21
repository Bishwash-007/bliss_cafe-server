import { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { hashSync } from 'bcryptjs';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Pool, type PoolConfig } from 'pg';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import type { LoginResult } from './../src/auth/interfaces/auth.interface';
import { ORDER_EVENTS } from './../src/order';
import { PAYMENT_HTTP } from './../src/payment/providers/payment-http';
import type {
  PaymentHttpClient,
  PaymentHttpRequest,
  PaymentHttpResponse,
} from './../src/payment/providers/payment-http';
import type { PaymentRow } from './../src/payment/payment.types';
import { TenantScopedConnection } from './../src/tenant/connection/tenant-scoped-connection';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * PaymentModule acceptance tests against a fresh Postgres database: real
 * migrations 001..015, a restricted (RLS-subject) app role, the full Nest app,
 * and a scripted gateway transport.
 *
 * What only an integration test can prove:
 *
 *   1. RLS hides `tenant_payment_configs` and `payments` from an unscoped
 *      connection, and a rival tenant's webhook cannot settle our payment.
 *   2. The webhook idempotency is the DATABASE's conditional UPDATE: the same
 *      signed delivery twice produces ONE `order.paid` and ONE transition.
 *   3. The three adapters produce an identical QR shape through the real
 *      checkout endpoint, selected by the tenant's active config.
 *   4. Invalid signatures are rejected BEFORE any state changes.
 *   5. Config secrets are encrypted at rest and never echoed by the API.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'db', 'migrations');
const TEST_DB = 'payment_ci';
const APP_ROLE = 'cafe_payment_app';
const APP_PASSWORD = 'cafe_payment_secret';
const PASSWORD = 'Password123!';
const PLAN_STARTER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CONFIG_KEY = 'f'.repeat(64);

const STRIPE_WEBHOOK_SECRET = 'whsec_e2e_stripe';
const ESEWA_WEBHOOK_SECRET = 'whsec_e2e_esewa';
const RAZORPAY_WEBHOOK_SECRET = 'whsec_e2e_razorpay';

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

function stripeSignature(raw: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${raw}`)
    .digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

function hmacHex(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw).digest('hex');
}

describeWithDb('PaymentModule (integration)', () => {
  jest.setTimeout(120_000);

  const admin = poolFor(process.env.DATABASE_NAME ?? 'postgres');
  let adminTest: Pool;
  let appPool: Pool | undefined;
  let app: INestApplication<App>;
  let events: EventEmitter2;

  const ownerEmail = 'pay-owner@cafe.test';
  const waiterEmail = 'pay-waiter@cafe.test';
  const rivalEmail = 'pay-rival@cafe.test';

  let tenantId = '';
  let branchId = '';
  let rivalTenantId = '';
  let ownerToken = '';
  let waiterToken = '';
  let rivalToken = '';

  /** Deterministic scripted gateway responses; one counter keeps refs unique. */
  let gatewayCounter = 0;
  const gatewayRequests: PaymentHttpRequest[] = [];

  const fakeGateway: PaymentHttpClient = {
    request(input: PaymentHttpRequest): Promise<PaymentHttpResponse> {
      gatewayRequests.push(input);
      gatewayCounter += 1;
      const url = input.url;
      const respond = (
        status: number,
        payload: unknown,
      ): Promise<PaymentHttpResponse> =>
        Promise.resolve({ status, body: payload });

      if (url.includes('/v1/refunds')) {
        return respond(200, { id: 're_1', status: 'succeeded', amount: 25050 });
      }
      if (url.includes('/v1/payment_intents')) {
        return respond(200, {
          id: `pi_${gatewayCounter}`,
          client_secret: `cs_${gatewayCounter}`,
          status: 'requires_payment_method',
        });
      }
      if (url.includes('/api/qr/generate')) {
        return respond(200, {
          qr_image_url: `https://esewa.test/qr-${gatewayCounter}.png`,
          expires_at: '2030-01-01T00:00:00.000Z',
        });
      }
      if (url.includes('/api/epay/refund')) {
        return respond(200, {
          refund_id: 'es_ref_1',
          status: 'COMPLETE',
          refund_amount: 250.5,
        });
      }
      if (url.includes('/v1/payments/qr_codes')) {
        return respond(200, {
          id: `qr_${gatewayCounter}`,
          image_url: `https://razorpay.test/qr-${gatewayCounter}.png`,
          close_by: Math.floor(Date.now() / 1000) + 900,
        });
      }
      if (/\/v1\/payments\/[^/]+\/refund$/.test(url)) {
        return respond(200, {
          id: 'rfnd_1',
          status: 'processed',
          amount: 25050,
        });
      }
      return respond(404, { error: `unscripted ${url}` });
    },
  };

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

  async function seedOrder(status: string, total = '250.50'): Promise<string> {
    const result = await adminTest.query<{ id: string }>(
      `INSERT INTO orders (tenant_id, branch_id, status, order_type,
                           subtotal, tax_amount, discount_amount, total_amount)
            VALUES ($1, $2, $3, 'dine_in', $4, 0, 0, $4)
         RETURNING id`,
      [tenantId, branchId, status, total],
    );
    return result.rows[0].id;
  }

  function configure(
    provider: string,
    config: Record<string, unknown>,
    isActive = true,
    token = ownerToken,
  ) {
    return request(app.getHttpServer())
      .put(`/payments/config/${provider}`)
      .set(auth(token))
      .send({ config, isActive });
  }

  async function activate(
    provider: 'stripe' | 'esewa' | 'razorpay',
  ): Promise<void> {
    const configs = {
      stripe: {
        secretKey: 'sk_test_e2e',
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        baseUrl: 'https://stripe.test',
        checkoutBaseUrl: 'https://pay.stripe.test',
      },
      esewa: {
        merchantCode: 'EPAYTEST',
        secretKey: 'esewa_secret',
        webhookSecret: ESEWA_WEBHOOK_SECRET,
        baseUrl: 'https://esewa.test',
      },
      razorpay: {
        keyId: 'rzp_test_e2e',
        keySecret: 'rzp_secret',
        webhookSecret: RAZORPAY_WEBHOOK_SECRET,
        baseUrl: 'https://razorpay.test',
      },
    };
    const response = await configure(provider, configs[provider]);
    expect(response.status).toBe(200);
  }

  function checkout(token: string, orderId: string) {
    return request(app.getHttpServer())
      .post(`/orders/${orderId}/checkout`)
      .set(auth(token));
  }

  async function configureAndCheckout(
    provider: 'stripe' | 'esewa' | 'razorpay',
    total = '250.50',
  ): Promise<{
    orderId: string;
    payment: PaymentRow;
    qr: Record<string, unknown>;
  }> {
    await activate(provider);
    const orderId = await seedOrder('awaiting_payment', total);
    const response = await checkout(ownerToken, orderId);
    expect(response.status).toBe(200);
    const result = body<{ payment: PaymentRow; qr: Record<string, unknown> }>(
      response,
    );
    // The response is `{ payment, qr }`; the order id lives on the payment row.
    return {
      orderId: result.payment.order_id,
      payment: result.payment,
      qr: result.qr,
    };
  }

  function stripeWebhook(raw: string, signature?: string) {
    return request(app.getHttpServer())
      .post('/webhooks/stripe')
      .set('X-Tenant-Id', tenantId)
      .set('Content-Type', 'application/json')
      .set(
        'stripe-signature',
        signature ?? stripeSignature(raw, STRIPE_WEBHOOK_SECRET),
      )
      .send(raw);
  }

  function esewaWebhook(raw: string, signature: string) {
    return request(app.getHttpServer())
      .post('/webhooks/esewa')
      .set('X-Tenant-Id', tenantId)
      .set('Content-Type', 'application/json')
      .set('x-esewa-signature', signature)
      .send(raw);
  }

  function razorpayWebhook(raw: string, signature: string) {
    return request(app.getHttpServer())
      .post('/webhooks/razorpay')
      .set('X-Tenant-Id', tenantId)
      .set('Content-Type', 'application/json')
      .set('x-razorpay-signature', signature)
      .send(raw);
  }

  async function paymentRowsFor(orderId: string): Promise<PaymentRow[]> {
    const result = await adminTest.query<PaymentRow>(
      `SELECT * FROM payments WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId],
    );
    return result.rows;
  }

  async function orderStatus(orderId: string): Promise<string> {
    const result = await adminTest.query<{ status: string }>(
      `SELECT status FROM orders WHERE id = $1`,
      [orderId],
    );
    return result.rows[0].status;
  }

  /** Lets the post-commit event emitter run before assertions. */
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 50));
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

    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = CONFIG_KEY;

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PG_POOL)
      .useValue(appPool)
      .overrideProvider(PAYMENT_HTTP)
      .useValue(fakeGateway)
      .compile();

    // `rawBody: true` is mandatory here: signatures are computed over the
    // exact bytes, and without it the webhook controller refuses to guess.
    app = moduleRef.createNestApplication({ rawBody: true });
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
        orgName: 'Payment Co',
        slug: 'paymentco',
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
        orgName: 'Rival Payment Co',
        slug: 'rivalpaymentco',
        planId: PLAN_STARTER,
        firstBranch: { name: 'Rival Branch', address: '9 Other' },
        defaultTables: 0,
        owner: { email: rivalEmail, password: PASSWORD },
      });
    expect(rival.status).toBe(201);
    rivalTenantId = body<{ tenantId: string }>(rival).tenantId;
    rivalToken = (await login(rivalEmail, rivalTenantId)).accessToken;
  });

  // ------------------------------------------------------------------ config

  describe('provider configuration', () => {
    it('stores credentials encrypted and never echoes them back', async () => {
      const response = await configure('stripe', {
        secretKey: 'sk_test_secret_value',
        webhookSecret: STRIPE_WEBHOOK_SECRET,
        baseUrl: 'https://stripe.test',
        checkoutBaseUrl: 'https://pay.stripe.test',
      });

      expect(response.status).toBe(200);
      expect(body(response)).toMatchObject({
        provider: 'stripe',
        is_active: true,
        activated: true,
      });

      const stored = await adminTest.query<{ config_encrypted: string }>(
        `SELECT config_encrypted FROM tenant_payment_configs
          WHERE tenant_id = $1 AND provider = 'stripe'`,
        [tenantId],
      );
      expect(stored.rows[0].config_encrypted).not.toContain(
        'sk_test_secret_value',
      );
      expect(stored.rows[0].config_encrypted.startsWith('v1:')).toBe(true);

      const list = await request(app.getHttpServer())
        .get('/payments/config')
        .set(auth(ownerToken));
      expect(list.status).toBe(200);
      expect(JSON.stringify(list.body)).not.toContain('sk_test_secret_value');
      expect(body<{ provider: string }[]>(list)).toEqual([
        { provider: 'stripe', is_active: true },
      ]);
    });

    it('rejects a provider this build does not implement', async () => {
      const response = await configure('paypal', {});

      expect(response.status).toBe(422);
    });

    it('rejects an incomplete config at save time, not at checkout', async () => {
      const response = await configure('stripe', { secretKey: 'only-the-key' });

      expect(response.status).toBe(400);
    });

    it('restricts configuration to owners', async () => {
      const response = await configure(
        'stripe',
        {
          secretKey: 'sk',
          webhookSecret: 'whsec',
        },
        true,
        waiterToken,
      );

      expect(response.status).toBe(403);
    });

    it('activating one provider deactivates the others', async () => {
      await activate('esewa');

      const rows = await adminTest.query<{
        provider: string;
        is_active: boolean;
      }>(
        `SELECT provider, is_active FROM tenant_payment_configs
          WHERE tenant_id = $1 ORDER BY provider`,
        [tenantId],
      );
      const active = rows.rows.filter((row) => row.is_active);

      expect(active).toHaveLength(1);
      expect(active[0].provider).toBe('esewa');
    });
  });

  // ---------------------------------------------------------------- checkout

  describe('checkout', () => {
    it('returns every provider a QR payload with the same shape', async () => {
      const shapes: string[][] = [];

      for (const provider of ['stripe', 'esewa', 'razorpay'] as const) {
        const result = await configureAndCheckout(provider);

        expect(result.payment.status).toBe('pending');
        expect(result.payment.provider).toBe(provider);
        expect(Number(result.payment.amount)).toBe(250.5);
        shapes.push(Object.keys(result.qr).sort());

        expect(result.qr.provider).toBe(provider);
        expect(result.qr.orderId).toBe(result.payment.order_id);
        expect(result.qr.amount).toBe(250.5);
        expect(typeof result.qr.data).toBe('string');
        expect(['url', 'image', 'text']).toContain(result.qr.format);
      }

      expect(shapes[1]).toEqual(shapes[0]);
      expect(shapes[2]).toEqual(shapes[0]);
    });

    it('parks the order at awaiting_payment before payment', async () => {
      await activate('stripe');
      const orderId = await seedOrder('served');

      const response = await checkout(ownerToken, orderId);

      expect(response.status).toBe(200);
      expect(await orderStatus(orderId)).toBe('awaiting_payment');
    });

    it('uses the order total, not a client-supplied amount', async () => {
      await activate('stripe');
      const orderId = await seedOrder('awaiting_payment', '999.99');

      const response = await checkout(ownerToken, orderId);

      expect(response.status).toBe(200);
      expect(body<{ qr: { amount: number } }>(response).qr.amount).toBe(999.99);
    });

    it('refuses an unknown order and an already-paid order', async () => {
      await activate('stripe');
      const missing = await checkout(
        ownerToken,
        '00000000-0000-4000-8000-000000000000',
      );
      expect(missing.status).toBe(404);

      const paidOrder = await seedOrder('paid');
      const paid = await checkout(ownerToken, paidOrder);
      expect(paid.status).toBe(409);
    });

    it('lists payment attempts for an order', async () => {
      const { orderId } = await configureAndCheckout('stripe');

      const response = await request(app.getHttpServer())
        .get(`/payments/order/${orderId}`)
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      expect(body<PaymentRow[]>(response)).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------------- webhook

  describe('webhooks', () => {
    it('rejects an invalid signature before changing any state', async () => {
      const { orderId, payment } = await configureAndCheckout('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.provider_reference } },
      });

      const response = await stripeWebhook(raw, 't=1,v1=deadbeef');

      expect(response.status).toBe(401);

      const rows = await paymentRowsFor(orderId);
      expect(rows[0].status).toBe('pending');
      expect(await orderStatus(orderId)).toBe('awaiting_payment');
    });

    it('settles once and publishes order.paid once, even when redelivered', async () => {
      const { orderId, payment } = await configureAndCheckout('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: {
          object: { id: payment.provider_reference, status: 'succeeded' },
        },
      });

      let paidEvents = 0;
      const listener = () => {
        paidEvents += 1;
      };
      events.on(ORDER_EVENTS.paid, listener);

      try {
        const first = await stripeWebhook(raw);
        expect(first.status).toBe(200);
        expect(body<{ duplicate: boolean }>(first).duplicate).toBe(false);
        await settle();

        expect(await orderStatus(orderId)).toBe('paid');
        expect(paidEvents).toBe(1);

        const rows = await paymentRowsFor(orderId);
        expect(rows[0].status).toBe('succeeded');
        expect(rows[0].paid_at).not.toBeNull();

        const second = await stripeWebhook(raw);
        expect(second.status).toBe(200);
        expect(body<{ duplicate: boolean }>(second).duplicate).toBe(true);
        await settle();

        expect(paidEvents).toBe(1);
        expect(await orderStatus(orderId)).toBe('paid');
      } finally {
        events.off(ORDER_EVENTS.paid, listener);
      }
    });

    it('records a failed payment without paying the order', async () => {
      const { orderId, payment } = await configureAndCheckout('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.payment_failed',
        data: { object: { id: payment.provider_reference } },
      });

      const response = await stripeWebhook(raw);

      expect(response.status).toBe(200);
      const rows = await paymentRowsFor(orderId);
      expect(rows[0].status).toBe('failed');
      expect(await orderStatus(orderId)).toBe('awaiting_payment');
    });

    it('settles eSewa and Razorpay through their own signed envelopes', async () => {
      const esewa = await configureAndCheckout('esewa');
      const esewaRaw = JSON.stringify({
        transaction_uuid: esewa.payment.provider_reference,
        status: 'COMPLETE',
      });
      const esewaResponse = await esewaWebhook(
        esewaRaw,
        hmacHex(esewaRaw, ESEWA_WEBHOOK_SECRET),
      );
      expect(esewaResponse.status).toBe(200);
      expect(await orderStatus(esewa.orderId)).toBe('paid');

      const razorpay = await configureAndCheckout('razorpay');
      const razorpayRaw = JSON.stringify({
        event: 'qr_code.credited',
        payload: {
          qr_code: { entity: { id: razorpay.payment.provider_reference } },
          payment: { entity: { id: 'pay_e2e', status: 'captured' } },
        },
      });
      const razorpayResponse = await razorpayWebhook(
        razorpayRaw,
        hmacHex(razorpayRaw, RAZORPAY_WEBHOOK_SECRET),
      );
      expect(razorpayResponse.status).toBe(200);
      expect(await orderStatus(razorpay.orderId)).toBe('paid');
    });

    it('404s a signed reference this tenant never created', async () => {
      await activate('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_never_created' } },
      });

      const response = await stripeWebhook(raw);

      expect(response.status).toBe(404);
    });

    it('rejects a correctly signed body that is not JSON', async () => {
      await activate('stripe');
      const raw = 'not-json';

      const response = await stripeWebhook(raw);

      expect(response.status).toBe(400);
    });

    it('cannot settle another tenant\u2019s payment', async () => {
      const { orderId, payment } = await configureAndCheckout('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.provider_reference } },
      });

      const response = await request(app.getHttpServer())
        .post('/webhooks/stripe')
        .set('X-Tenant-Id', rivalTenantId)
        .set('Content-Type', 'application/json')
        .set('stripe-signature', stripeSignature(raw, STRIPE_WEBHOOK_SECRET))
        .send(raw);

      // The rival has no Stripe config, so the factory refuses before the
      // signature is even checked; either way our payment must be untouched.
      expect([404, 422]).toContain(response.status);
      const rows = await paymentRowsFor(orderId);
      expect(rows[0].status).toBe('pending');
      expect(await orderStatus(orderId)).toBe('awaiting_payment');
    });
  });

  // ----------------------------------------------------------------- refunds

  describe('refunds', () => {
    it('refunds a succeeded payment and updates the row', async () => {
      const { orderId, payment } = await configureAndCheckout('stripe');
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: { id: payment.provider_reference } },
      });
      expect((await stripeWebhook(raw)).status).toBe(200);

      const response = await request(app.getHttpServer())
        .post(`/payments/${payment.id}/refund`)
        .set(auth(ownerToken));

      expect(response.status).toBe(200);
      expect(body<{ payment: PaymentRow }>(response).payment.status).toBe(
        'refunded',
      );
      const rows = await paymentRowsFor(orderId);
      expect(rows[0].status).toBe('refunded');
    });

    it('restricts refunds to managers and above', async () => {
      const { payment } = await configureAndCheckout('stripe');

      const response = await request(app.getHttpServer())
        .post(`/payments/${payment.id}/refund`)
        .set(auth(waiterToken));

      expect(response.status).toBe(403);
    });

    it('refuses to refund a payment that has not succeeded', async () => {
      const { payment } = await configureAndCheckout('stripe');

      const response = await request(app.getHttpServer())
        .post(`/payments/${payment.id}/refund`)
        .set(auth(ownerToken));

      expect(response.status).toBe(409);
    });
  });

  // --------------------------------------------------------------------- RLS

  describe('tenant isolation', () => {
    it('hides payment rows and provider configs from an unscoped connection', async () => {
      await configureAndCheckout('stripe');

      const unscoped = await TenantScopedConnection.acquireUnscoped(
        appPool as Pool,
      );
      try {
        const payments = await unscoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM payments`,
        );
        const configs = await unscoped.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_payment_configs`,
        );

        expect(payments.rows[0].n).toBe(0);
        expect(configs.rows[0].n).toBe(0);
      } finally {
        await unscoped.commit().catch(() => undefined);
        await unscoped.release();
      }
    });

    it('keeps a rival tenant from reading our order payments', async () => {
      const { orderId } = await configureAndCheckout('stripe');

      const response = await request(app.getHttpServer())
        .get(`/payments/order/${orderId}`)
        .set(auth(rivalToken, rivalTenantId));

      expect(response.status).toBe(404);
    });
  });
});
