import type { Request } from 'express';
import type { TenantScopedConnection } from '../connection/tenant-scoped-connection';

/** A tenant-reference is what a resolver produces; it may be an id or a slug. */
export type TenantReference = string;

/**
 * An enriched Express request produced by `TenantContextMiddleware`.
 *
 * - `tenantId` / `tenantSlug` are set for tenant-scoped routes.
 * - `platformRoute` is set for `/platform/*` (SuperAdmin) routes, which bypass
 *   tenant resolution entirely.
 * - `tenantConnection` is the tenant-scoped (or unscoped) connection acquired
 *   for the duration of the request. Repository code reads it via the
 *   request-scoped `TenantRequestContext`, never by reaching into `req`.
 */
export interface RequestWithTenant extends Request {
  tenantId?: string;
  tenantSlug?: string;
  platformRoute?: boolean;
  tenantConnection?: TenantScopedConnection;
}
