import type { Request } from 'express';
import { SubdomainTenantResolver } from './subdomain-tenant.resolver';

function requestWithHostname(hostname: string): Request {
  return { hostname } as Request;
}

describe('SubdomainTenantResolver', () => {
  const resolver = new SubdomainTenantResolver();

  it('resolves a two-level subdomain slug', () => {
    expect(resolver.resolve(requestWithHostname('beanhouse.yourapp.com'))).toBe(
      'beanhouse',
    );
  });

  it('resolves a multi-level subdomain combining labels', () => {
    expect(resolver.resolve(requestWithHostname('a.b.yourapp.com'))).toBe(
      'a.b',
    );
  });

  it('strips a leading www from subdomains', () => {
    expect(
      resolver.resolve(requestWithHostname('www.beanhouse.yourapp.com')),
    ).toBe('beanhouse');
  });

  it('returns null on the apex domain', () => {
    expect(resolver.resolve(requestWithHostname('yourapp.com'))).toBeNull();
  });

  it('returns null on the www apex', () => {
    expect(resolver.resolve(requestWithHostname('www.yourapp.com'))).toBeNull();
  });

  it('returns null on localhost and bare hostnames', () => {
    expect(resolver.resolve(requestWithHostname('localhost'))).toBeNull();
    expect(resolver.resolve(requestWithHostname('api'))).toBeNull();
  });

  it('returns null on IP literals', () => {
    expect(resolver.resolve(requestWithHostname('127.0.0.1'))).toBeNull();
    expect(resolver.resolve(requestWithHostname('[::1]'))).toBeNull();
  });

  it('returns null when no hostname is present', () => {
    expect(resolver.resolve(requestWithHostname(''))).toBeNull();
  });
});
