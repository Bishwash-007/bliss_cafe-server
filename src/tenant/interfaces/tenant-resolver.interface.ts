import type { Request } from 'express';

/**
 * A TenantResolver extracts a tenant reference (either an id or a slug) from
 * an incoming request. Resolvers are composed in priority order into a chain,
 * so a resolver must stay independent: it returns null when the request shape
 * it looks for is absent and it must not throw for "not my concern".
 */
export interface TenantResolver {
  /**
   * @param req the raw incoming request
   * @returns a tenant reference (id or slug) for this request, or null when
   *          this strategy cannot resolve a tenant from the request shape.
   */
  resolve(req: Request): string | null;
}
