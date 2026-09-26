import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PG_POOL } from '../tenant.constants';
import { TenantScopedConnection } from './tenant-scoped-connection';

export interface TenantRecord {
  id: string;
  slug: string;
  status: string;
}

/**
 * Owns the shared `pg.Pool` and is the only place that acquires connections:
 *
 * - `findTenant()` — validates a resolved reference (id or slug) against the
 *   `tenants` table (platform table, no RLS involved).
 * - `acquireScoped()` — hands out a connection pinned to a tenant via
 *   `SET LOCAL app.tenant_id`.
 * - `acquireUnscoped()` — hands out a connection for `/platform/*` routes.
 *
 * Repository code never touches the pool directly for tenant data — it gets
 * its connection through the request-scoped `TenantRequestContext`.
 */
@Injectable()
export class TenantConnectionService {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Looks up a tenant by id or slug; returns null when it does not exist. */
  async findTenant(reference: string): Promise<TenantRecord | null> {
    const result = await this.pool.query<TenantRecord>(
      `SELECT id, slug, status
         FROM tenants
        WHERE id::text = $1 OR slug = $1
        LIMIT 1`,
      [reference],
    );
    return result.rows[0] ?? null;
  }

  /** Acquires a connection scoped to the given tenant (starts a transaction). */
  acquireScoped(tenantId: string): Promise<TenantScopedConnection> {
    return TenantScopedConnection.acquireScoped(this.pool, tenantId);
  }

  /** Acquires a connection with no tenant scope (platform routes). */
  acquireUnscoped(): Promise<TenantScopedConnection> {
    return TenantScopedConnection.acquireUnscoped(this.pool);
  }
}
