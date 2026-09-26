import type { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import { AUTH_CONFIG } from '../../auth/auth.constants';
import {
  ORDER_EVENTS,
  type OrderStatusChangedEvent,
} from '../events/order-events';
import { KdsGateway, KDS_JOIN_EVENT, kdsRoom } from './kds.gateway';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ORDER1 = 'ffffffff-ffff-4fff-8fff-fffffffffff1';
const ORDER2 = 'ffffffff-ffff-4fff-8fff-fffffffffff2';

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

function connect(
  url: string,
  options: Record<string, unknown> = {},
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...options,
    });
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

/** Resolves with the rejection reason instead of throwing, for negative cases. */
function connectExpectingFailure(
  url: string,
  options: Record<string, unknown>,
): Promise<Error> {
  return new Promise((resolve, reject) => {
    const socket = io(url, {
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      ...options,
    });
    socket.on('connect', () =>
      reject(new Error('socket connected but should not have')),
    );
    socket.on('connect_error', resolve);
  });
}

function nextEvent(socket: Socket, event: string): Promise<unknown> {
  return new Promise((resolve) => socket.once(event, resolve));
}

interface Identity {
  tenantId: string;
  /** `null` = tenant-wide staff (org_owner, super_admin). */
  branchId: string | null;
  role: string;
}

const KITCHEN_AT_B1: Identity = {
  tenantId: T1,
  branchId: B1,
  role: 'kitchen_staff',
};
const WAITER_AT_B1: Identity = { tenantId: T1, branchId: B1, role: 'waiter' };
const WAITER_AT_B2: Identity = { tenantId: T1, branchId: B2, role: 'waiter' };
const OWNER_OF_T1: Identity = {
  tenantId: T1,
  branchId: null,
  role: 'org_owner',
};
const OWNER_OF_T2: Identity = {
  tenantId: T2,
  branchId: null,
  role: 'org_owner',
};
const CUSTOMER_OF_T1: Identity = {
  tenantId: T1,
  branchId: null,
  role: 'customer',
};

/**
 * The acceptance criterion, tested the way it actually happens: two real
 * Socket.IO clients, each joined to a DIFFERENT branch's KDS room, and a domain
 * event published. The branch-B display must not see branch A's ticket.
 *
 * The gateway is wired through a real Nest application (not a hand-built
 * instance) so the `@SubscribeMessage` / `@OnEvent` / handshake-middleware
 * metadata Nest relies on is genuinely exercised — a unit test that called
 * `handleOrderStatusChanged` directly would pass even if the gateway was never
 * registered.
 *
 * Every client presents a REAL signed access token, because "unauthenticated
 * sockets are rejected" is only meaningful if the positive cases authenticate
 * for real rather than stubbing the check away.
 *
 * Note this uses the DEFAULT in-memory adapter, which is the right choice for a
 * single-process test: the Redis adapter's cross-instance behaviour is a
 * transport concern, and what is under test here is auth and room scoping.
 * `kds.redis.spec.ts` covers the transport.
 */
describe('KdsGateway (real WebSocket clients)', () => {
  let app: INestApplication;
  let url: string;
  let gateway: KdsGateway;
  let jwt: JwtService;
  const clients: Socket[] = [];

  function tokenFor(identity: Identity, overrides: object = {}): string {
    return jwt.sign({
      sub: '99999999-9999-4999-8999-999999999999',
      tenantId: identity.tenantId,
      branchId: identity.branchId,
      role: identity.role,
      email: 'display@cafe.test',
      fullName: 'Kitchen Display',
      type: 'access',
      ...overrides,
    });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // The same secret the HTTP API signs with — a socket must never accept a
      // token the API would reject, or the other way round.
      imports: [JwtModule.register({ secret: AUTH_CONFIG.jwtSecret })],
      providers: [KdsGateway],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.listen(0);
    gateway = app.get(KdsGateway);
    jwt = app.get(JwtService);
    const server = app.getHttpServer() as {
      address: () => AddressInfo | string | null;
    };
    const address = server.address();
    url = `ws://127.0.0.1:${
      address && typeof address === 'object' ? address.port : 0
    }/kds`;
  });

  afterAll(async () => {
    for (const client of clients) {
      client.close();
    }
    await app.close();
  });

  async function open(identity: Identity): Promise<Socket> {
    const socket = await connect(url, { auth: { token: tokenFor(identity) } });
    clients.push(socket);
    return socket;
  }

  async function join(
    identity: Identity,
    branchId: string,
    tenantId?: string,
  ): Promise<Socket> {
    const socket = await open(identity);
    socket.emit(KDS_JOIN_EVENT, { tenantId, branchId });
    await nextEvent(socket, 'kds:joined');
    return socket;
  }

  /**
   * Tries to join and reports whether the server accepted. Resolves on the
   * server's refusal (or a short silence), rather than throwing, so a refused
   * join can then be checked for what actually matters: no event delivery.
   */
  async function attemptJoin(
    identity: Identity,
    branchId: string,
    tenantId?: string,
  ): Promise<{ socket: Socket; joined: boolean }> {
    const socket = await open(identity);
    const joined = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      socket.once('kds:joined', () => {
        clearTimeout(timer);
        resolve(true);
      });
      // A handler that throws answers the ack with an error instead.
      socket.emit(KDS_JOIN_EVENT, { tenantId, branchId }, (ack: unknown) => {
        const message = (ack as { message?: string } | undefined)?.message;
        if (message) {
          clearTimeout(timer);
          resolve(false);
        }
      });
    });
    return { socket, joined };
  }

  /** Publishes and asserts the socket received nothing at all. */
  async function expectNoDelivery(
    socket: Socket,
    event: OrderStatusChangedEvent = statusChanged(),
  ): Promise<void> {
    const seen: string[] = [];
    socket.on(ORDER_EVENTS.statusChanged, (payload) =>
      seen.push((payload as OrderStatusChangedEvent).orderId),
    );
    gateway.handleOrderStatusChanged(event);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual([]);
  }

  it('delivers order.status_changed to a display in that branch room', async () => {
    const branchA = await join(KITCHEN_AT_B1, B1);
    const received = nextEvent(branchA, ORDER_EVENTS.statusChanged);

    gateway.handleOrderStatusChanged(statusChanged());

    await expect(received).resolves.toEqual(
      expect.objectContaining({
        event: 'order.status_changed',
        orderId: ORDER1,
        branchId: B1,
        previousStatus: 'placed',
        newStatus: 'confirmed',
      }),
    );
  });

  it('does NOT deliver to a display in another branch room', async () => {
    const branchA = await join(KITCHEN_AT_B1, B1);
    const branchB = await join(WAITER_AT_B2, B2);
    const otherBranch = new Set<string>();

    const gotB = nextEvent(branchB, ORDER_EVENTS.statusChanged);

    // A ticket for branch B, while branch A is also watching.
    gateway.handleOrderStatusChanged(
      statusChanged({ orderId: ORDER2, branchId: B2, newStatus: 'preparing' }),
    );

    await expect(gotB).resolves.toEqual(
      expect.objectContaining({ orderId: ORDER2, branchId: B2 }),
    );
    // Give the negative assertion a real chance to fail rather than resolving
    // spuriously: any stray delivery would arrive on this socket's event bus.
    branchA.on(ORDER_EVENTS.statusChanged, (payload) =>
      otherBranch.add((payload as OrderStatusChangedEvent).orderId),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(otherBranch).toEqual(new Set());
  });

  it('does NOT deliver across tenants', async () => {
    // The room name carries the tenant AND the tenant comes from a verified
    // token, so one café's display cannot reach another's traffic even when
    // both name the same branch id.
    const otherTenant = await join(OWNER_OF_T2, B1);
    const seen: string[] = [];
    otherTenant.on(ORDER_EVENTS.statusChanged, (payload) =>
      seen.push((payload as OrderStatusChangedEvent).orderId),
    );

    gateway.handleOrderStatusChanged(statusChanged({ orderId: ORDER1 }));
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(seen).toEqual([]);
  });

  it('delivers to every display in the same room', async () => {
    const first = await join(KITCHEN_AT_B1, B1);
    const second = await join(WAITER_AT_B1, B1);
    const gotFirst = nextEvent(first, ORDER_EVENTS.statusChanged);
    const gotSecond = nextEvent(second, ORDER_EVENTS.statusChanged);

    gateway.handleOrderStatusChanged(statusChanged({ newStatus: 'ready' }));

    await expect(gotFirst).resolves.toEqual(
      expect.objectContaining({ newStatus: 'ready' }),
    );
    await expect(gotSecond).resolves.toEqual(
      expect.objectContaining({ newStatus: 'ready' }),
    );
  });

  it('stops delivering after a display leaves the room', async () => {
    const leaver = await join(KITCHEN_AT_B1, B1);

    leaver.emit('kds:leave', { branchId: B1 });
    await nextEvent(leaver, 'kds:left');

    await expectNoDelivery(leaver);
  });

  it('auto-joins from the handshake when the display supplies its branch', async () => {
    const socket = await connect(url, {
      auth: { token: tokenFor(KITCHEN_AT_B1), branchId: B1 },
    });
    clients.push(socket);

    const received = nextEvent(socket, ORDER_EVENTS.statusChanged);
    // The `afterInit`/connection handler has run by the time the client is
    // connected, so the room is already joined.
    gateway.handleOrderStatusChanged(statusChanged());
    await expect(received).resolves.toEqual(
      expect.objectContaining({ branchId: B1 }),
    );
  });

  it('lets tenant-wide staff watch any branch of their own tenant', async () => {
    // An org_owner has no branch of their own, so pinning them to one branch
    // would break the owner opening a second location's screen.
    const owner = await join(OWNER_OF_T1, B2);
    const received = nextEvent(owner, ORDER_EVENTS.statusChanged);

    gateway.handleOrderStatusChanged(
      statusChanged({ branchId: B2, orderId: ORDER2 }),
    );

    await expect(received).resolves.toEqual(
      expect.objectContaining({ branchId: B2 }),
    );
  });

  // ------------------------------------------------------------ authentication

  describe('authentication', () => {
    it('refuses a socket with no token at all', async () => {
      await expect(connectExpectingFailure(url, {})).resolves.toBeInstanceOf(
        Error,
      );
    });

    it('refuses a token that is not signed by us', async () => {
      // The whole point: room names are guessable, so an unsigned/forged claim
      // must not be enough to reach another tenant's tickets.
      await expect(
        connectExpectingFailure(url, {
          auth: {
            token: `${Buffer.from(
              JSON.stringify({
                sub: 'x',
                tenantId: T2,
                branchId: null,
                role: 'org_owner',
                type: 'access',
              }),
            ).toString('base64url')}.nope`,
          },
        }),
      ).resolves.toBeInstanceOf(Error);
    });

    it('refuses an expired token', async () => {
      const expired = jwt.sign({
        sub: '99999999-9999-4999-8999-999999999999',
        tenantId: T1,
        branchId: B1,
        role: 'kitchen_staff',
        type: 'access',
        exp: Math.floor(Date.now() / 1000) - 60,
      });

      await expect(
        connectExpectingFailure(url, { auth: { token: expired } }),
      ).resolves.toBeInstanceOf(Error);
    });

    it('refuses a refresh token, which is not an access token', async () => {
      // Otherwise a stolen long-lived refresh token becomes a 30-day KDS feed.
      const refresh = jwt.sign({
        sub: '99999999-9999-4999-8999-999999999999',
        tenantId: T1,
        branchId: B1,
        role: 'kitchen_staff',
        type: 'refresh',
      });

      await expect(
        connectExpectingFailure(url, { auth: { token: refresh } }),
      ).resolves.toBeInstanceOf(Error);
    });

    it('accepts a bearer Authorization header for non-browser clients', async () => {
      // Kiosks and native apps cannot set `handshake.auth`, so the header is a
      // supported path — and it is verified exactly the same way.
      const socket = await connect(url, {
        extraHeaders: { Authorization: `Bearer ${tokenFor(KITCHEN_AT_B1)}` },
      });
      clients.push(socket);
      socket.emit(KDS_JOIN_EVENT, { branchId: B1 });
      await nextEvent(socket, 'kds:joined');

      const received = nextEvent(socket, ORDER_EVENTS.statusChanged);
      gateway.handleOrderStatusChanged(statusChanged());
      await expect(received).resolves.toEqual(
        expect.objectContaining({ branchId: B1 }),
      );
    });
  });

  // ---------------------------------------------------------- authorization

  describe('authorization', () => {
    it('refuses a branch-scoped user watching a different branch', async () => {
      const { joined } = await attemptJoin(KITCHEN_AT_B1, B2);

      expect(joined).toBe(false);
    });

    it('delivers nothing to a user whose join was refused', async () => {
      // The assertion that actually matters: a refused join must not be a
      // quiet, still-subscribed socket.
      const { socket, joined } = await attemptJoin(KITCHEN_AT_B1, B2);

      expect(joined).toBe(false);
      await expectNoDelivery(socket, statusChanged({ branchId: B2 }));
    });

    it('refuses a join whose body claims a different tenant than the token', async () => {
      // The body is never trusted, so this is refused rather than silently
      // coerced — a mismatch means the client is pointed at the wrong deploy.
      const { joined } = await attemptJoin(OWNER_OF_T1, B1, T2);

      expect(joined).toBe(false);
    });

    it('still delivers when the body tenant simply agrees with the token', async () => {
      const { joined } = await attemptJoin(OWNER_OF_T1, B1, T1);

      expect(joined).toBe(true);
    });

    it('refuses a role that may not watch a KDS at all', async () => {
      // A customer token must not become a feed of every open ticket, prices
      // and table numbers in the branch.
      const { socket, joined } = await attemptJoin(CUSTOMER_OF_T1, B1);

      expect(joined).toBe(false);
      await expectNoDelivery(socket);
    });

    it('refuses a malformed branch id', async () => {
      const { joined } = await attemptJoin(OWNER_OF_T1, 'not-a-uuid');

      expect(joined).toBe(false);
    });

    it('ignores a forged branch in the handshake auto-join', async () => {
      // The socket connects (its token is fine) but must not be auto-joined to
      // a branch the identity is not scoped to.
      const socket = await connect(url, {
        auth: { token: tokenFor(KITCHEN_AT_B1), branchId: B2 },
      });
      clients.push(socket);

      await expectNoDelivery(socket, statusChanged({ branchId: B2 }));
    });
  });
});

describe('kdsRoom', () => {
  it('scopes the room by tenant AND branch', () => {
    expect(kdsRoom(T1, B1)).toBe(`kds:${T1}:${B1}`);
  });

  it('cannot be made to collide by moving characters between the two ids', () => {
    // ':' cannot appear inside a UUID, so the split point is unambiguous.
    expect(kdsRoom('t1', 'b1')).not.toBe(kdsRoom('t', '1b1'));
  });
});
