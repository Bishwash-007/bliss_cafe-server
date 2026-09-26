import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';
import type { TenantScopedConnection } from '../connection/tenant-scoped-connection';
import type {
  TenantConnectionService,
  TenantRecord,
} from '../connection/tenant-connection.service';
import type { TenantChainResolver } from '../resolvers/tenant-chain.resolver';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantInactiveException } from '../exceptions/tenant-inactive.exception';
import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';

const ACTIVE_ID = '8f14e45f-0000-4000-8000-000000000001';

function makeRes(): Response {
  return new EventEmitter() as unknown as Response;
}

function emitOn(res: Response, event: 'finish' | 'close'): void {
  (res as unknown as EventEmitter).emit(event);
}

function makeReq(
  path: string,
  extra: Partial<RequestWithTenant> = {},
): RequestWithTenant {
  return {
    path,
    hostname: 'yourapp.com',
    headers: {},
    ...extra,
  } as RequestWithTenant;
}

const releaseSpies = new WeakMap<TenantScopedConnection, jest.Mock>();

function fakeConnection(): TenantScopedConnection {
  const release = jest.fn(() => Promise.resolve(undefined));
  const query = jest.fn(() => Promise.resolve({ rows: [], rowCount: 0 }));
  const connection = { release, query } as unknown as TenantScopedConnection;
  releaseSpies.set(connection, release);
  return connection;
}

function releaseMockOf(connection: TenantScopedConnection): jest.Mock {
  const spy = releaseSpies.get(connection);
  if (!spy) {
    throw new Error('No release spy recorded for this connection.');
  }
  return spy;
}

interface Fixture {
  middleware: TenantContextMiddleware;
  chain: { resolve: jest.Mock };
  connections: {
    findTenant: jest.Mock;
    acquireScoped: jest.Mock;
    acquireUnscoped: jest.Mock;
  };
  next: jest.Mock;
}

function createMiddleware(
  chainResult: string | (() => string | never),
  tenant: TenantRecord | null,
): Fixture {
  const chain = {
    resolve: jest.fn(() => {
      if (typeof chainResult === 'function') {
        return chainResult();
      }
      return chainResult;
    }),
  };

  const connections = {
    findTenant: jest.fn(() => Promise.resolve(tenant)),
    acquireScoped: jest.fn(() => Promise.resolve(fakeConnection())),
    acquireUnscoped: jest.fn(() => Promise.resolve(fakeConnection())),
  };

  const middleware = new TenantContextMiddleware(
    chain as unknown as TenantChainResolver,
    connections as unknown as TenantConnectionService,
  );

  return { middleware, chain, connections, next: jest.fn() };
}

describe('TenantContextMiddleware', () => {
  it('resolves, validates, and scopes a valid tenant request', async () => {
    const { middleware, connections, next, chain } = createMiddleware(
      'beanhouse',
      {
        id: ACTIVE_ID,
        slug: 'beanhouse',
        status: 'active',
      },
    );
    const req = makeReq('/orders');
    const res = makeRes();

    await middleware.use(req, res, next);

    expect(chain.resolve).toHaveBeenCalledWith(req);
    expect(connections.findTenant).toHaveBeenCalledWith('beanhouse');
    expect(connections.acquireScoped).toHaveBeenCalledWith(ACTIVE_ID);
    expect(req.tenantId).toBe(ACTIVE_ID);
    expect(req.tenantSlug).toBe('beanhouse');
    expect(req.platformRoute).toBeUndefined();
    expect(req.tenantConnection).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });

  it('rejects a suspended tenant even though resolution succeeded', async () => {
    const { middleware, connections, next } = createMiddleware('beanhouse', {
      id: ACTIVE_ID,
      slug: 'beanhouse',
      status: 'suspended',
    });
    const req = makeReq('/orders');
    const res = makeRes();

    await middleware.use(req, res, next);

    expect(connections.acquireScoped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(TenantInactiveException));
    expect(req.tenantId).toBeUndefined();
  });

  it('rejects a cancelled tenant', async () => {
    const { middleware, next } = createMiddleware('beanhouse', {
      id: ACTIVE_ID,
      slug: 'beanhouse',
      status: 'cancelled',
    });
    await middleware.use(makeReq('/orders'), makeRes(), next);
    expect(next).toHaveBeenCalledWith(expect.any(TenantInactiveException));
  });

  it('rejects a tenant that does not exist', async () => {
    const { middleware, connections, next } = createMiddleware('ghost', null);
    await middleware.use(makeReq('/orders'), makeRes(), next);

    expect(connections.acquireScoped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(TenantNotFoundException));
  });

  it('propagates a TenantNotFoundException from the chain and acquires nothing', async () => {
    const { middleware, connections, next } = createMiddleware(() => {
      throw new TenantNotFoundException();
    }, null);
    await middleware.use(makeReq('/orders'), makeRes(), next);

    expect(connections.findTenant).not.toHaveBeenCalled();
    expect(connections.acquireScoped).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(expect.any(TenantNotFoundException));
  });

  it('bypasses tenant resolution entirely on /platform/* routes', async () => {
    const { middleware, connections, next, chain } = createMiddleware(
      'beanhouse',
      {
        id: ACTIVE_ID,
        slug: 'beanhouse',
        status: 'active',
      },
    );
    const req = makeReq('/platform/tenants');
    const res = makeRes();

    await middleware.use(req, res, next);

    expect(chain.resolve).not.toHaveBeenCalled();
    expect(connections.findTenant).not.toHaveBeenCalled();
    expect(connections.acquireUnscoped).toHaveBeenCalledTimes(1);
    expect(connections.acquireScoped).not.toHaveBeenCalled();
    expect(req.platformRoute).toBe(true);
    expect(req.tenantId).toBeUndefined();
    expect(req.tenantConnection).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('bypasses tenant resolution on the bare platform prefix', async () => {
    const { middleware, next } = createMiddleware('', null);
    await middleware.use(makeReq('/platform'), makeRes(), next);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });

  it('bypasses tenant resolution on public /onboarding routes', async () => {
    const { middleware, connections, next, chain } = createMiddleware(
      'beanhouse',
      {
        id: ACTIVE_ID,
        slug: 'beanhouse',
        status: 'active',
      },
    );
    const req = makeReq('/onboarding');
    const res = makeRes();

    await middleware.use(req, res, next);

    expect(chain.resolve).not.toHaveBeenCalled();
    expect(connections.findTenant).not.toHaveBeenCalled();
    expect(connections.acquireUnscoped).toHaveBeenCalledTimes(1);
    expect(connections.acquireScoped).not.toHaveBeenCalled();
    expect(req.platformRoute).toBe(true);
    expect(req.tenantId).toBeUndefined();
    expect(req.tenantConnection).toBeDefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('bypasses tenant resolution on nested /onboarding/* routes', async () => {
    const { middleware, connections, next } = createMiddleware('', null);
    await middleware.use(makeReq('/onboarding/verify/email'), makeRes(), next);
    expect(connections.acquireUnscoped).toHaveBeenCalledTimes(1);
    expect(next).not.toHaveBeenCalledWith(expect.any(Error));
  });

  it('releases the connection when the response finishes', async () => {
    const { middleware, next } = createMiddleware('beanhouse', {
      id: ACTIVE_ID,
      slug: 'beanhouse',
      status: 'active',
    });
    const req = makeReq('/orders');
    const res = makeRes();

    await middleware.use(req, res, next);

    const connection = req.tenantConnection as TenantScopedConnection;
    emitOn(res, 'finish');

    expect(releaseMockOf(connection)).toHaveBeenCalledTimes(1);
  });

  it('releases only once when both close and finish fire', async () => {
    const { middleware, next } = createMiddleware('beanhouse', {
      id: ACTIVE_ID,
      slug: 'beanhouse',
      status: 'active',
    });
    const req = makeReq('/orders');
    const res = makeRes();

    await middleware.use(req, res, next);

    const connection = req.tenantConnection as TenantScopedConnection;
    emitOn(res, 'finish');
    emitOn(res, 'close');

    expect(releaseMockOf(connection)).toHaveBeenCalledTimes(1);
  });
});
