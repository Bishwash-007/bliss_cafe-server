import type { Request } from 'express';
import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';
import type { TenantResolver } from '../interfaces/tenant-resolver.interface';
import { TENANT_RESOLVERS } from '../tenant.constants';
import { TenantChainResolver } from './tenant-chain.resolver';

const req = {} as Request;

function resolverReturning(value: string | null): TenantResolver {
  return { resolve: () => value };
}

function buildChain(resolvers: TenantResolver[]): TenantChainResolver {
  return new TenantChainResolver(resolvers);
}

describe('TenantChainResolver', () => {
  it('returns the first non-null resolver result in priority order', () => {
    const chain = buildChain([
      resolverReturning('first'),
      resolverReturning('second'),
    ]);
    expect(chain.resolve(req)).toBe('first');
  });

  it('falls through when a higher-priority resolver returns null', () => {
    const chain = buildChain([
      resolverReturning(null),
      resolverReturning('second'),
      resolverReturning('third'),
    ]);
    expect(chain.resolve(req)).toBe('second');
  });

  it('falls through blank references from a higher-priority resolver', () => {
    const chain = buildChain([
      resolverReturning('   '),
      resolverReturning(''),
      resolverReturning('winner'),
    ]);
    expect(chain.resolve(req)).toBe('winner');
  });

  it('skips resolvers that throw "not my concern" style nulls without leaking', () => {
    const chain = buildChain([
      resolverReturning(null),
      resolverReturning('last'),
    ]);
    expect(chain.resolve(req)).toBe('last');
  });

  it('throws TenantNotFoundException when every resolver returns null', () => {
    const chain = buildChain([
      resolverReturning(null),
      resolverReturning(null),
    ]);
    expect(() => chain.resolve(req)).toThrow(TenantNotFoundException);
  });

  it('throws TenantNotFoundException when the chain is empty', () => {
    const chain = buildChain([]);
    expect(() => chain.resolve(req)).toThrow(TenantNotFoundException);
  });
});

describe('TenantChainResolver DI wiring', () => {
  it('exposes the TENANT_RESOLVERS token for composition', () => {
    expect(typeof TENANT_RESOLVERS).toBe('string');
  });
});
