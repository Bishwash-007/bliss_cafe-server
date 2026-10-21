import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';

export interface BranchRow {
  id: string;
  tenant_id: string;
  name: string;
  address: string | null;
  phone: string | null;
  timezone: string;
  is_active: boolean;
  created_at: Date;
}

export interface TableRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  label: string;
  seats: number;
  status: TableStatus;
  created_at: Date;
}

/** Mirrors the `tables.status` comment in `db/migrations/003_branches_and_tables.sql`. */
export const TABLE_STATUSES = ['free', 'occupied', 'reserved'] as const;

export type TableStatus = (typeof TABLE_STATUSES)[number];

export function isTableStatus(value: unknown): value is TableStatus {
  return (
    typeof value === 'string' &&
    (TABLE_STATUSES as readonly string[]).includes(value)
  );
}

export interface CreateBranchInput {
  name: string;
  address?: string | null;
  phone?: string | null;
}

export type UpdateBranchInput = Partial<CreateBranchInput> & {
  timezone?: string;
};

export interface CreateTableInput {
  label: string;
  seats?: number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the string looks like the canonical UUID form PG expects. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Data-access layer for branches and their nested tables. Every read/write is
 * tenant-scoped through the `TenantScopedConnection` (RLS is a second layer of
 * defence); no branch row is ever hard-deleted — see `deactivate`.
 */
@Injectable()
export class BranchRepository {
  findAll(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId?: string,
  ): Promise<BranchRow[]> {
    if (branchId !== undefined && !isUuid(branchId)) {
      return Promise.resolve([]);
    }
    return connection
      .query<BranchRow>(
        `SELECT id, tenant_id, name, address, phone, timezone, is_active, created_at
           FROM branches
          WHERE tenant_id = $1
            AND ($2::uuid IS NULL OR id = $2)
          ORDER BY created_at, id`,
        [tenantId, branchId ?? null],
      )
      .then((result) => result.rows);
  }

  findById(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<BranchRow | null> {
    if (!isUuid(branchId)) {
      return Promise.resolve(null);
    }
    return connection
      .query<BranchRow>(
        `SELECT id, tenant_id, name, address, phone, timezone, is_active, created_at
           FROM branches
          WHERE id = $1 AND tenant_id = $2`,
        [branchId, tenantId],
      )
      .then((result) => result.rows[0] ?? null);
  }

  create(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreateBranchInput,
  ): Promise<BranchRow> {
    return connection
      .query<BranchRow>(
        `INSERT INTO branches (tenant_id, name, address, phone, timezone)
         VALUES ($1, $2, $3, $4, 'UTC')
         RETURNING id, tenant_id, name, address, phone, timezone, is_active, created_at`,
        [tenantId, input.name, input.address ?? null, input.phone ?? null],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('branches insert returned no row');
        }
        return row;
      });
  }

  update(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    patch: UpdateBranchInput,
  ): Promise<BranchRow | null> {
    const sets: string[] = [];
    const values: unknown[] = [branchId, tenantId];

    const columns: Array<keyof UpdateBranchInput> = [
      'name',
      'address',
      'phone',
      'timezone',
    ];
    for (const column of columns) {
      if (patch[column] !== undefined) {
        values.push(patch[column]);
        sets.push(`${column} = $${values.length}`);
      }
    }

    if (sets.length === 0) {
      return this.findById(connection, tenantId, branchId);
    }

    return connection
      .query<BranchRow>(
        `UPDATE branches
            SET ${sets.join(', ')}
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, name, address, phone, timezone, is_active, created_at`,
        values,
      )
      .then((result) => result.rows[0] ?? null);
  }

  deactivate(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<BranchRow | null> {
    return connection
      .query<BranchRow>(
        `UPDATE branches
            SET is_active = false
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, name, address, phone, timezone, is_active, created_at`,
        [branchId, tenantId],
      )
      .then((result) => result.rows[0] ?? null);
  }

  countActive(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<number> {
    return connection
      .query<{ count: number }>(
        'SELECT count(*)::int AS count FROM branches WHERE tenant_id = $1 AND is_active = true',
        [tenantId],
      )
      .then((result) => result.rows[0]?.count ?? 0);
  }

  /** The tenant's plan `max_branches` (1 when the tenant has no plan). */
  async planBranchLimit(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<number> {
    const result = await connection.query<{ max_branches: number | null }>(
      `SELECT p.max_branches
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
        WHERE t.id = $1`,
      [tenantId],
    );
    return result.rows[0]?.max_branches ?? 1;
  }

  listTables(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<TableRow[]> {
    return connection
      .query<TableRow>(
        `SELECT id, tenant_id, branch_id, label, seats, status, created_at
           FROM tables
          WHERE tenant_id = $1 AND branch_id = $2
          ORDER BY label`,
        [tenantId, branchId],
      )
      .then((result) => result.rows);
  }

  /**
   * Flips a table's occupancy.
   *
   * The single write path for `tables.status` in the codebase, shared by the
   * receptionist-facing endpoints and by `OrderService`'s table side-effects
   * (order placed -> `occupied`, order completed/cancelled -> `free`). Keeping
   * one method means the rule "who is allowed to mark a table busy" cannot
   * drift between the two callers.
   */
  setTableStatus(
    connection: TenantScopedConnection,
    tenantId: string,
    tableId: string,
    status: TableStatus,
  ): Promise<TableRow | null> {
    if (!isUuid(tableId)) {
      return Promise.resolve(null);
    }
    return connection
      .query<TableRow>(
        `UPDATE tables
            SET status = $3
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, branch_id, label, seats, status, created_at`,
        [tableId, tenantId, status],
      )
      .then((result) => result.rows[0] ?? null);
  }

  createTable(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    input: CreateTableInput,
  ): Promise<TableRow> {
    return connection
      .query<TableRow>(
        `INSERT INTO tables (tenant_id, branch_id, label, seats)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, branch_id, label, seats, status, created_at`,
        [tenantId, branchId, input.label.trim(), input.seats ?? 2],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('tables insert returned no row');
        }
        return row;
      });
  }
}
