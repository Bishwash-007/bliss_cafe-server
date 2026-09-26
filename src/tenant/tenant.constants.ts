/** DI token for the shared `pg.Pool`. */
export const PG_POOL = 'PG_POOL';

/** DI token for the ordered array of tenant resolvers (Chain of Responsibility). */
export const TENANT_RESOLVERS = 'TENANT_RESOLVERS';

/** First path segment reserved for the platform super-admin (no tenant scoping). */
export const PLATFORM_ROUTE_PREFIX = 'platform';

/**
 * Public paths that must work BEFORE a tenant exists — e.g. self-service
 * onboarding. These routes also bypass tenant resolution and get an unscoped
 * connection (RLS-protected tables need `app.tenant_id` set explicitly by the
 * code that writes into them).
 */
export const PUBLIC_ROUTE_PREFIX = 'onboarding';

/** `tenants.status` value required for a tenant to serve requests. */
export const ACTIVE_TENANT_STATUS = 'active';

const PLATFORM_PREFIX_WITH_SLASH = `/${PLATFORM_ROUTE_PREFIX}`;
const PUBLIC_PREFIX_WITH_SLASH = `/${PUBLIC_ROUTE_PREFIX}`;

/** True when the request path targets the platform (super-admin) area. */
export function isPlatformPath(path: string): boolean {
  return (
    path === PLATFORM_PREFIX_WITH_SLASH ||
    path.startsWith(`${PLATFORM_PREFIX_WITH_SLASH}/`)
  );
}

/** True when the request path targets a public (pre-tenant) route. */
export function isPublicRoutePath(path: string): boolean {
  return (
    path === PUBLIC_PREFIX_WITH_SLASH ||
    path.startsWith(`${PUBLIC_PREFIX_WITH_SLASH}/`)
  );
}
