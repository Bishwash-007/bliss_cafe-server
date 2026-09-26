import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';
import type { TenantScopedConnection } from './tenant-scoped-connection';
import { TenantRequestContext } from './tenant-request-context';

const TENANT_ID = '8f14e45f-0000-4000-8000-000000000001';

function fakeConnection(): TenantScopedConnection {
  return {} as TenantScopedConnection;
}

describe('TenantRequestContext', () => {
  it('exposes the tenant id resolved by the middleware', () => {
    const ctx = new TenantRequestContext({
      tenantId: TENANT_ID,
      tenantSlug: 'beanhouse',
    } as RequestWithTenant);
    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(ctx.tenantSlug).toBe('beanhouse');
  });

  it('reports platform routes with no tenant', () => {
    const ctx = new TenantRequestContext({
      platformRoute: true,
      tenantId: undefined,
    } as RequestWithTenant);
    expect(ctx.isPlatformRoute).toBe(true);
    expect(ctx.tenantId).toBeNull();
  });

  it('returns the current request connection', () => {
    const connection = fakeConnection();
    const ctx = new TenantRequestContext({
      tenantConnection: connection,
    } as RequestWithTenant);
    expect(ctx.getConnection()).toBe(connection);
  });

  it('throws TenantNotFoundException when no connection was acquired', () => {
    const ctx = new TenantRequestContext({} as RequestWithTenant);
    expect(() => ctx.getConnection()).toThrow(TenantNotFoundException);
  });
});
