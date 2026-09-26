import type { Request } from 'express';
import { JwtClaimTenantResolver } from './jwt-claim-tenant.resolver';

function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function tokenWith(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.signature`;
}

function requestWithAuth(authorization?: string): Request {
  return {
    headers: authorization ? { authorization } : {},
  } as unknown as Request;
}

describe('JwtClaimTenantResolver', () => {
  const resolver = new JwtClaimTenantResolver();

  it('resolves the tenantId claim from a Bearer token', () => {
    const req = requestWithAuth(
      `Bearer ${tokenWith({ sub: 'u1', tenantId: '5ce9c8b4-0000-4000-8000-000000000001' })}`,
    );
    expect(resolver.resolve(req)).toBe('5ce9c8b4-0000-4000-8000-000000000001');
  });

  it('returns null without an Authorization header', () => {
    expect(resolver.resolve(requestWithAuth())).toBeNull();
  });

  it('returns null for a non-Bearer scheme', () => {
    expect(resolver.resolve(requestWithAuth('Basic abc123'))).toBeNull();
  });

  it('returns null for a malformed token (no payload segment)', () => {
    expect(resolver.resolve(requestWithAuth('Bearer onlyone'))).toBeNull();
  });

  it('returns null when the payload has no tenantId claim', () => {
    expect(
      resolver.resolve(requestWithAuth(`Bearer ${tokenWith({ sub: 'u1' })}`)),
    ).toBeNull();
  });

  it('returns null when the payload is not valid JSON', () => {
    const req = requestWithAuth('Bearer abc.not-json.signature');
    expect(resolver.resolve(req)).toBeNull();
  });

  it('returns null when tenantId is empty or not a string', () => {
    expect(
      resolver.resolve(
        requestWithAuth(`Bearer ${tokenWith({ tenantId: '' })}`),
      ),
    ).toBeNull();
    expect(
      resolver.resolve(
        requestWithAuth(`Bearer ${tokenWith({ tenantId: 42 })}`),
      ),
    ).toBeNull();
  });

  it('trims the tenantId claim', () => {
    expect(
      resolver.resolve(
        requestWithAuth(`Bearer ${tokenWith({ tenantId: '  beanhouse  ' })}`),
      ),
    ).toBe('beanhouse');
  });
});
