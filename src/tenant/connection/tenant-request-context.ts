import { Inject, Injectable, Scope } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';
import type { TenantScopedConnection } from './tenant-scoped-connection';

/**
 * Request-scoped view of the tenant context that the middleware established.
 * Repositories inject this to obtain the connection for the current request:
 *
 *   getConnection() -> TenantScopedConnection (pinned to the resolved tenant)
 *
 * Repository code never calls `SET LOCAL app.tenant_id` — the connection is
 * already tenant-scoped by `TenantScopedConnection`.
 */
@Injectable({ scope: Scope.REQUEST })
export class TenantRequestContext {
  constructor(@Inject(REQUEST) private readonly request: RequestWithTenant) {}

  /** Tenant id for the current request, or null for platform routes. */
  get tenantId(): string | null {
    return this.request.tenantId ?? null;
  }

  /** Tenant slug for the current request, or null for platform routes. */
  get tenantSlug(): string | null {
    return this.request.tenantSlug ?? null;
  }

  /** True for `/platform/*` requests, which bypass tenant scoping. */
  get isPlatformRoute(): boolean {
    return this.request.platformRoute === true;
  }

  /**
   * The connection for this request. Throws when the middleware did not
   * acquire one (should not happen for requests routed through Nest).
   */
  getConnection(): TenantScopedConnection {
    const connection = this.request.tenantConnection;
    if (!connection) {
      throw new TenantNotFoundException();
    }
    return connection;
  }
}
