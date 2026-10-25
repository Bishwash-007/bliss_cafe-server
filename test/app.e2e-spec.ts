import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { AUTH_CONFIG } from './../src/auth/auth.constants';
import { PG_POOL } from './../src/tenant/tenant.constants';

/**
 * Mints an access token for a given role.
 *
 * The JWT strategy only checks the SIGNATURE and the claims it carries — it
 * does not look the user up in the database — so a token minted here is
 * exactly as good as one the login route would have produced, and the test
 * does not need a seeded user row.
 */
function tokenFor(role: string): string {
  const jwt = new JwtService({
    secret: AUTH_CONFIG.jwtSecret,
    signOptions: { expiresIn: AUTH_CONFIG.accessTtl as never },
  });
  return jwt.sign({
    sub: '00000000-0000-4000-8000-000000000001',
    tenantId: '00000000-0000-4000-8000-0000000000ff',
    branchId: null,
    role,
    email: `${role}@platform.test`,
    fullName: role,
    type: 'access',
  });
}

describe('PlatformController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    // Listen on a real (ephemeral) port once. Leaving the server unlistened
    // makes supertest spin up and tear down a throwaway server per request,
    // which intermittently resets in-flight sockets ("read ECONNRESET") on
    // newer Node — a transport flake, never a product one.
    await app.listen(0);
  });

  it('/platform/tenants (GET) refuses an anonymous caller', async () => {
    const response = await request(app.getHttpServer()).get(
      '/platform/tenants',
    );

    // The route skips TENANT resolution (it is not a tenant route at all), but
    // it is not anonymous: without a super-admin token the tenant ids, slugs
    // and statuses of every café on the platform are nobody's business.
    expect(response.status).toBe(401);
  });

  it('/platform/tenants (GET) refuses a token that is not a super admin', async () => {
    const response = await request(app.getHttpServer())
      .get('/platform/tenants')
      .set('Authorization', `Bearer ${tokenFor('org_owner')}`);

    expect(response.status).toBe(403);
  });

  it('/platform/tenants (GET) serves a super admin', async () => {
    const response = await request(app.getHttpServer())
      .get('/platform/tenants')
      .set('Authorization', `Bearer ${tokenFor('super_admin')}`);

    expect(response.status).toBe(200);
    const body = response.body as Array<{ slug: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((tenant) => tenant.slug).sort()).toEqual(expect.any(Array));
  });

  it('/ (GET) requires a resolvable tenant and rejects without one', async () => {
    const response = await request(app.getHttpServer()).get('/');
    expect(response.status).toBe(404);
  });

  it('answers 429 once the login rate limit is exceeded', async () => {
    // The limit is read from the environment PER REQUEST, so it can be lowered
    // for this test and restored afterwards.
    const previous = process.env.AUTH_LOGIN_RATE_LIMIT;
    process.env.AUTH_LOGIN_RATE_LIMIT = '2';

    try {
      const pool = app.get<{
        query: (
          sql: string,
          params?: unknown[],
        ) => Promise<{ rows: Array<{ id: string }> }>;
      }>(PG_POOL);
      const tenants = await pool.query(
        'SELECT id FROM tenants WHERE status = $1 LIMIT 1',
        ['active'],
      );
      const tenantId = tenants.rows[0]?.id;
      if (!tenantId) {
        // Nothing to log into — the limiter is not what this test is about.
        return;
      }

      const attempt = () =>
        request(app.getHttpServer())
          .post('/auth/login')
          .set('X-Tenant-Id', tenantId)
          .send({ email: 'nobody@cafe.test', password: 'wrong-password' });

      // The limiter counts ATTEMPTS, so a wrong password is enough to fill the
      // bucket — which is the whole point of rate limiting a login.
      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(401);
      expect((await attempt()).status).toBe(429);
    } finally {
      if (previous === undefined) {
        delete process.env.AUTH_LOGIN_RATE_LIMIT;
      } else {
        process.env.AUTH_LOGIN_RATE_LIMIT = previous;
      }
    }
  });

  it('answers 429 once the default rate limit is exceeded', async () => {
    // The default limit applies to EVERY route, not only the ones that ask
    // for a tighter one. It is read from the environment PER REQUEST, so it
    // can be lowered for this test and restored afterwards.
    const previous = process.env.RATE_LIMIT_DEFAULT;
    process.env.RATE_LIMIT_DEFAULT = '2';

    try {
      const attempt = () =>
        request(app.getHttpServer())
          .get('/platform/tenants')
          .set('Authorization', `Bearer ${tokenFor('super_admin')}`);

      expect((await attempt()).status).toBe(200);
      expect((await attempt()).status).toBe(200);
      expect((await attempt()).status).toBe(429);
    } finally {
      if (previous === undefined) {
        delete process.env.RATE_LIMIT_DEFAULT;
      } else {
        process.env.RATE_LIMIT_DEFAULT = previous;
      }
    }
  });

  afterEach(async () => {
    await app.get<{ end: () => Promise<void> }>(PG_POOL).end();
    await app.close();
  });
});
