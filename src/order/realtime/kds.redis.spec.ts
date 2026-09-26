import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { AUTH_CONFIG } from '../../auth/auth.constants';
import {
  ORDER_EVENTS,
  type OrderStatusChangedEvent,
} from '../events/order-events';
import { KdsGateway, KDS_JOIN_EVENT, kdsRoom } from './kds.gateway';
import { RedisIoAdapter } from './redis-io.adapter';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ORDER1 = 'ffffffff-ffff-4fff-8fff-fffffffffff1';

jest.setTimeout(30_000);

function statusChanged(
  overrides: Partial<OrderStatusChangedEvent> = {},
): OrderStatusChangedEvent {
  return {
    event: ORDER_EVENTS.statusChanged,
    orderId: ORDER1,
    tenantId: T1,
    branchId: B1,
    previousStatus: 'placed',
    newStatus: 'confirmed',
    tableId: null,
    orderType: 'dine_in',
    totalAmount: 10,
    occurredAt: new Date().toISOString(),
    ...overrides,
  };
}

function connect(url: string, token: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      auth: { token },
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

function nextEvent(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

async function join(
  url: string,
  tenantId: string,
  branchId: string,
  role = 'kitchen_staff',
): Promise<Socket> {
  const socket = await connect(url, sign(tenantId, branchId, role));
  // The gateway confirms with a `kds:joined` event, not an ack callback, so the
  // room is only guaranteed joined once that comes back.
  socket.emit(KDS_JOIN_EVENT, { tenantId, branchId });
  await nextEvent(socket, 'kds:joined');
  return socket;
}

/**
 * Gives the Redis adapter time to finish subscribing after a socket joins.
 * There is no public readiness signal for the adapter, and a display in
 * production joins seconds before the next order, so this only matters to a
 * test that publishes the instant it connects.
 */
async function settleRedisSubscription(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function bootInstance(): Promise<{
  app: INestApplication;
  url: string;
  gateway: KdsGateway;
  adapter: RedisIoAdapter;
}> {
  const moduleRef = await Test.createTestingModule({
    // Real signatures, same secret as the API: an authenticated KDS must not
    // mean "authenticated under different rules than HTTP".
    imports: [JwtModule.register({ secret: AUTH_CONFIG.jwtSecret })],
    providers: [KdsGateway],
  }).compile();

  const app = moduleRef.createNestApplication();
  // Same wiring as `main.ts`, so this exercises the real production path.
  const adapter = new RedisIoAdapter(app);
  app.useWebSocketAdapter(adapter);
  await app.listen(0);
  jwt = app.get(JwtService);

  const server = app.getHttpServer() as {
    address: () => AddressInfo | string | null;
  };
  const address = server.address();
  return {
    app,
    url: `ws://127.0.0.1:${address && typeof address === 'object' ? address.port : 0}/kds`,
    gateway: app.get(KdsGateway),
    adapter,
  };
}

/**
 * The cross-instance half of the KDS acceptance criterion.
 *
 * `kds.gateway.spec.ts` proves room scoping with real sockets but inside ONE
 * process, where the default in-memory adapter is indistinguishable from a
 * correct distributed one. That gap is exactly how "the kitchen screen
 * sometimes freezes" reaches production: everything passes in CI, and the bug
 * only appears once a second replica exists.
 *
 * So this boots two genuinely separate Nest applications on two ports, each
 * with the Redis adapter installed, and asserts that an event published on
 * instance A reaches a display that is connected to instance B. Requires a
 * reachable Redis; skipped otherwise, since asserting against a silently
 * in-memory adapter would pass without proving anything.
 */
let jwt: JwtService;

function sign(tenantId: string, branchId: string, role: string): string {
  return jwt.sign({
    sub: '99999999-9999-4999-8999-999999999999',
    tenantId,
    branchId,
    role,
    email: 'display@cafe.test',
    fullName: 'Kitchen Display',
    type: 'access',
  });
}

const describeWithRedis = process.env.REDIS_URL ? describe : describe.skip;

describeWithRedis('KdsGateway (cross-instance via Redis)', () => {
  let instanceA: Awaited<ReturnType<typeof bootInstance>>;
  let instanceB: Awaited<ReturnType<typeof bootInstance>>;
  const clients: Socket[] = [];

  beforeAll(async () => {
    instanceA = await bootInstance();
    instanceB = await bootInstance();
  });

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await instanceA?.app.close();
    await instanceB?.app.close();
    // `app.close()` does not know about a hand-built adapter; without this the
    // Redis sockets stay open and Jest never exits.
    instanceA?.adapter.disconnect();
    instanceB?.adapter.disconnect();
  });

  it('delivers an event published on instance A to a display on instance B', async () => {
    const display = await join(instanceB.url, T1, B1);
    clients.push(display);

    const received = nextEvent(display, ORDER_EVENTS.statusChanged);

    // `kds:joined` proves the SERVER joined the room, not that this instance has
    // finished subscribing to the Redis channels the adapter fans out through —
    // that handshake completes a tick or two later. Publishing in the same tick
    // as the join can legitimately miss, so let the subscription settle.
    await settleRedisSubscription();
    instanceA.gateway.handleOrderStatusChanged(statusChanged());

    await expect(received).resolves.toEqual(
      expect.objectContaining({
        event: 'order.status_changed',
        orderId: ORDER1,
        tenantId: T1,
        branchId: B1,
        newStatus: 'confirmed',
      }),
    );
  });

  it('still keeps instance B other branches silent', async () => {
    const watchingB1 = await join(instanceB.url, T1, B1);
    const watchingB2 = await join(instanceB.url, T1, B2);
    clients.push(watchingB1, watchingB2);

    const leaked: string[] = [];
    watchingB1.on(ORDER_EVENTS.statusChanged, () => leaked.push('B1'));
    watchingB2.on(ORDER_EVENTS.statusChanged, () => leaked.push('B2'));

    instanceA.gateway.handleOrderStatusChanged(
      statusChanged({ branchId: B1, newStatus: 'preparing' }),
    );
    // Long enough for a mis-scoped broadcast to land on both sockets.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // B1 saw it; B2 did not. Redis fan-out must not dissolve room scoping.
    expect(leaked).toEqual(['B1']);
    expect(kdsRoom(T1, B2)).not.toBe(kdsRoom(T1, B1));
  });

  it('authenticates the socket on whichever instance is serving it', async () => {
    // Each replica runs its own gateway, so the handshake check has to hold on
    // the instance a display happens to be connected to — not just the one that
    // happened to boot first in this test.
    const unauthenticated = await new Promise<Error>((resolve, reject) => {
      const socket = io(instanceB.url, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
      });
      socket.on('connect', () =>
        reject(new Error('unauthenticated socket connected')),
      );
      socket.on('connect_error', resolve);
    });
    expect(unauthenticated).toBeInstanceOf(Error);
  });

  it("does not fan another tenant's events out over Redis", async () => {
    // The room name embeds the tenant, and the tenant comes from a verified
    // token. So even a legitimately connected display from a different café
    // lands in a different Redis room, and the pub/sub hop cannot merge them.
    const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    const otherTenant = await join(instanceB.url, T2, B1, 'org_owner');
    clients.push(otherTenant);

    const leaked: string[] = [];
    otherTenant.on(ORDER_EVENTS.statusChanged, () => leaked.push('T1 event'));

    instanceA.gateway.handleOrderStatusChanged(statusChanged());
    await settleRedisSubscription();
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(leaked).toEqual([]);
  });
});
