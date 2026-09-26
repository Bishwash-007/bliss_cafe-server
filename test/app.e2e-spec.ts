import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { PG_POOL } from './../src/tenant/tenant.constants';

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

  it('/platform/tenants (GET) bypasses tenant resolution', async () => {
    const response = await request(app.getHttpServer()).get(
      '/platform/tenants',
    );

    // No X-Tenant-Id / subdomain / JWT is required: the request succeeds
    // without any resolvable tenant (lists whatever tenants exist).
    expect(response.status).toBe(200);
    const body = response.body as Array<{ slug: string }>;
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((tenant) => tenant.slug).sort()).toEqual(expect.any(Array));
  });

  it('/ (GET) requires a resolvable tenant and rejects without one', async () => {
    const response = await request(app.getHttpServer()).get('/');
    expect(response.status).toBe(404);
  });

  afterEach(async () => {
    await app.get<{ end: () => Promise<void> }>(PG_POOL).end();
    await app.close();
  });
});
