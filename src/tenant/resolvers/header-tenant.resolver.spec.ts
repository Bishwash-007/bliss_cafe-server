import type { Request } from 'express';
import { HeaderTenantResolver } from './header-tenant.resolver';

function requestWithHeaders(headers: Record<string, unknown>): Request {
  return { headers } as unknown as Request;
}

describe('HeaderTenantResolver', () => {
  const resolver = new HeaderTenantResolver();

  it('resolves the X-Tenant-Id header value', () => {
    const req = requestWithHeaders({ 'x-tenant-id': 'beanhouse' });
    expect(resolver.resolve(req)).toBe('beanhouse');
  });

  it('resolves a UUID tenant id from the header', () => {
    const req = requestWithHeaders({
      'x-tenant-id': '2a0f9f1e-0000-4000-8000-000000000001',
    });
    expect(resolver.resolve(req)).toBe('2a0f9f1e-0000-4000-8000-000000000001');
  });

  it('takes the first value when the header is an array', () => {
    const req = requestWithHeaders({ 'x-tenant-id': ['first', 'second'] });
    expect(resolver.resolve(req)).toBe('first');
  });

  it('trims surrounding whitespace', () => {
    const req = requestWithHeaders({ 'x-tenant-id': '  beanhouse  ' });
    expect(resolver.resolve(req)).toBe('beanhouse');
  });

  it('returns null when the header is absent', () => {
    expect(resolver.resolve(requestWithHeaders({}))).toBeNull();
  });

  it('returns null when the header is an empty string or whitespace', () => {
    expect(
      resolver.resolve(requestWithHeaders({ 'x-tenant-id': '' })),
    ).toBeNull();
    expect(
      resolver.resolve(requestWithHeaders({ 'x-tenant-id': '   ' })),
    ).toBeNull();
  });
});
