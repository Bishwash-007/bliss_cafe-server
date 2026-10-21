import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { ResolvedDateRange } from './reporting.types';

export interface SalesTotalsRow {
  order_count: number;
  item_count: number;
  subtotal: string;
  discount_amount: string;
  tax_amount: string;
  revenue: string;
}

export interface SalesGroupRow {
  key: string;
  order_count: number;
  revenue: string;
}

export interface SalesRaw {
  totals: SalesTotalsRow;
  byDay: SalesGroupRow[];
  byOrderType: SalesGroupRow[];
}

export interface InventoryConsumptionRow {
  inventory_item_id: string;
  name: string;
  unit: string;
  usage_quantity: string;
  wastage_quantity: string;
  consumed_quantity: string;
  movement_count: number;
}

export interface StaffIdentityRow {
  id: string;
  full_name: string;
  role: string;
}

export interface StaffSalesRow {
  user_id: string;
  order_count: number;
  revenue: string;
}

export interface StaffAttendanceRow {
  user_id: string;
  shifts_scheduled: number;
  shifts_attended: number;
  open_shifts: number;
  hours_worked: string;
}

export interface StaffRaw {
  identities: StaffIdentityRow[];
  sales: StaffSalesRow[];
  attendance: StaffAttendanceRow[];
}

/** Money to the cent, so a SUM that came back as `"50.500"` reads as 50.5. */
export function money(value: string | number | null): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/** Stock quantities to three decimals, matching `NUMERIC(12,3)`. */
export function quantity(value: string | number | null): number {
  return Math.round(Number(value ?? 0) * 1000) / 1000;
}

/** Attendance hours to two decimals; payroll uses the same precision. */
export function hours(value: string | number | null): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/**
 * Read-only aggregation queries for tenant reports.
 *
 * Every method takes the request's tenant-scoped connection. There is no
 * repository-owned transaction and no write path: reporting is a projection of
 * data other modules already own.
 *
 * ## Scale notes (flagged, not solved)
 *
 * These queries are intentionally straightforward. At a branch with a long
 * history the two that will grow first are:
 *
 *  - **sales** — `orders(tenant_id, branch_id, created_at)` is not one index;
 *    the existing indexes stop at `(tenant_id)` and `(branch_id)`, so a date
 *    range is filtered after the index lookup. A composite index, or a daily
 *    per-branch rollup refreshed on order settlement, is the natural fix.
 *  - **inventory consumption** — `stock_movements` is indexed by tenant only.
 *    `(tenant_id, inventory_item_id, created_at)` or a daily per-item rollup
 *    would keep the scan proportional to the reported range.
 *
 * `staff` already benefits from `idx_attendance_clock_in` and
 * `idx_shifts_branch_start`. None of these are built preemptively: the numbers
 * are small enough until a real deployment demonstrates otherwise.
 */
@Injectable()
export class ReportingRepository {
  async fetchSales(
    connection: TenantScopedConnection,
    branchId: string,
    range: ResolvedDateRange,
  ): Promise<SalesRaw> {
    const totals = await connection.query<SalesTotalsRow>(
      `WITH scoped_orders AS (
         SELECT id, total_amount, subtotal, discount_amount, tax_amount,
                order_type, created_at
           FROM orders
          WHERE tenant_id = $1
            AND branch_id = $2
            AND created_at >= $3
            AND created_at < $4
            AND status IN ('paid', 'completed')
       ),
       item_totals AS (
         SELECT oi.order_id, SUM(oi.quantity)::int AS quantity
           FROM order_items oi
           JOIN scoped_orders so ON so.id = oi.order_id
          WHERE oi.tenant_id = $1
          GROUP BY oi.order_id
       )
       SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(it.quantity), 0)::int AS item_count,
              COALESCE(SUM(so.subtotal), 0)::text AS subtotal,
              COALESCE(SUM(so.discount_amount), 0)::text AS discount_amount,
              COALESCE(SUM(so.tax_amount), 0)::text AS tax_amount,
              COALESCE(SUM(so.total_amount), 0)::text AS revenue
         FROM scoped_orders so
         LEFT JOIN item_totals it ON it.order_id = so.id`,
      [
        connectionTenant(connection),
        branchId,
        range.fromInstant,
        range.toInstant,
      ],
    );

    const byDay = await connection.query<SalesGroupRow>(
      `SELECT to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS key,
              COUNT(*)::int AS order_count,
              COALESCE(SUM(total_amount), 0)::text AS revenue
         FROM orders
        WHERE tenant_id = $1
          AND branch_id = $2
          AND created_at >= $3
          AND created_at < $4
          AND status IN ('paid', 'completed')
        GROUP BY key
        ORDER BY key`,
      [
        connectionTenant(connection),
        branchId,
        range.fromInstant,
        range.toInstant,
      ],
    );

    const byOrderType = await connection.query<SalesGroupRow>(
      `SELECT order_type AS key,
              COUNT(*)::int AS order_count,
              COALESCE(SUM(total_amount), 0)::text AS revenue
         FROM orders
        WHERE tenant_id = $1
          AND branch_id = $2
          AND created_at >= $3
          AND created_at < $4
          AND status IN ('paid', 'completed')
        GROUP BY order_type
        ORDER BY order_type`,
      [
        connectionTenant(connection),
        branchId,
        range.fromInstant,
        range.toInstant,
      ],
    );

    return {
      totals: totals.rows[0],
      byDay: byDay.rows,
      byOrderType: byOrderType.rows,
    };
  }

  async fetchInventoryConsumption(
    connection: TenantScopedConnection,
    branchId: string,
    range: ResolvedDateRange,
  ): Promise<InventoryConsumptionRow[]> {
    const result = await connection.query<InventoryConsumptionRow>(
      `SELECT ii.id AS inventory_item_id,
              ii.name,
              ii.unit,
              COALESCE(SUM(CASE WHEN sm.movement_type = 'usage'
                                THEN -sm.quantity ELSE 0 END), 0)::text
                AS usage_quantity,
              COALESCE(SUM(CASE WHEN sm.movement_type = 'wastage'
                                THEN -sm.quantity ELSE 0 END), 0)::text
                AS wastage_quantity,
              COALESCE(SUM(-sm.quantity), 0)::text AS consumed_quantity,
              COUNT(*)::int AS movement_count
         FROM stock_movements sm
         JOIN inventory_items ii
           ON ii.id = sm.inventory_item_id
          AND ii.tenant_id = sm.tenant_id
        WHERE sm.tenant_id = $1
          AND ii.branch_id = $2
          AND sm.created_at >= $3
          AND sm.created_at < $4
          AND sm.movement_type IN ('usage', 'wastage')
        GROUP BY ii.id, ii.name, ii.unit
        ORDER BY ii.name`,
      [
        connectionTenant(connection),
        branchId,
        range.fromInstant,
        range.toInstant,
      ],
    );
    return result.rows;
  }

  async fetchStaff(
    connection: TenantScopedConnection,
    branchId: string,
    range: ResolvedDateRange,
  ): Promise<StaffRaw> {
    const tenantId = connectionTenant(connection);

    // Activity first, so the identity query can include somebody who worked at
    // this branch but whose `users.branch_id` has since changed.
    const sales = await connection.query<StaffSalesRow>(
      `SELECT created_by AS user_id,
              COUNT(*)::int AS order_count,
              COALESCE(SUM(total_amount), 0)::text AS revenue
         FROM orders
        WHERE tenant_id = $1
          AND branch_id = $2
          AND created_at >= $3
          AND created_at < $4
          AND status IN ('paid', 'completed')
          AND created_by IS NOT NULL
        GROUP BY created_by
        ORDER BY created_by`,
      [tenantId, branchId, range.fromInstant, range.toInstant],
    );

    const attendance = await connection.query<StaffAttendanceRow>(
      `SELECT s.user_id,
              COUNT(DISTINCT s.id)::int AS shifts_scheduled,
              COUNT(a.id)::int AS shifts_attended,
              COUNT(*) FILTER (WHERE a.id IS NOT NULL AND a.clock_out IS NULL)::int
                AS open_shifts,
              COALESCE(SUM(
                CASE WHEN a.clock_out IS NOT NULL
                     THEN EXTRACT(EPOCH FROM (a.clock_out - a.clock_in)) / 3600
                     ELSE 0 END
              ), 0)::text AS hours_worked
         FROM shifts s
         LEFT JOIN attendance_records a
           ON a.shift_id = s.id
          AND a.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.branch_id = $2
          AND s.start_time >= $3
          AND s.start_time < $4
        GROUP BY s.user_id
        ORDER BY s.user_id`,
      [tenantId, branchId, range.fromInstant, range.toInstant],
    );

    const activityUserIds = [
      ...new Set([
        ...sales.rows.map((row) => row.user_id),
        ...attendance.rows.map((row) => row.user_id),
      ]),
    ];

    const identities = await connection.query<StaffIdentityRow>(
      `SELECT u.id, u.full_name, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1
          AND r.name <> 'customer'
          AND (u.branch_id = $2 OR u.id = ANY($3::uuid[]))
        ORDER BY u.full_name, u.id`,
      [tenantId, branchId, activityUserIds],
    );

    return {
      identities: identities.rows,
      sales: sales.rows,
      attendance: attendance.rows,
    };
  }
}

/**
 * The connection knows which tenant it is pinned to; reading it from there
 * removes a parameter that could disagree with the RLS context.
 */
function connectionTenant(connection: TenantScopedConnection): string {
  const tenantId = connection.tenantId;
  if (!tenantId) {
    throw new Error('Reporting requires a tenant-scoped connection');
  }
  return tenantId;
}
