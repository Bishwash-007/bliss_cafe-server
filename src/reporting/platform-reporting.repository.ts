import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { PLATFORM_POOL } from './platform-pool.provider';
import type { ResolvedDateRange } from './reporting.types';

export interface PlatformTierRow {
  plan_name: string;
  tenant_count: number;
  active_tenant_count: number;
  order_count: number;
  revenue: string;
}

export interface PlatformRaw {
  tiers: PlatformTierRow[];
}

/**
 * The platform report is the one query in this module that is intentionally
 * NOT tenant-scoped. It runs on `PLATFORM_POOL` for that reason, not on the
 * request's unscoped connection — the latter is pinned to a tenant id that
 * cannot exist, so RLS would hide every order.
 *
 * ## Attribution and scale
 *
 * A tenant's tier is its CURRENT `tenants.plan_id`. `tenant_subscriptions`
 * records a history, but attributing historical revenue to the plan that was
 * in force on each order date would require joining that table on its
 * `started_at`/`ends_at` window. That is a product decision (does an upgrade
 * mid-month retroactively change the dashboard?) rather than something this
 * query should guess.
 *
 * This is also the most expensive report in the system: with no date range it
 * scans every tenant's orders. A materialized daily rollup keyed by
 * `(tenant_id, day, plan_id)` would be the right next step once the table is
 * large enough to notice; it is not built here for the same reason as the
 * tenant rollups in `ReportingRepository`.
 */
@Injectable()
export class PlatformReportingRepository {
  constructor(@Inject(PLATFORM_POOL) private readonly pool: Pool) {}

  async fetchOverview(range: ResolvedDateRange | null): Promise<PlatformRaw> {
    const from = range?.fromInstant ?? null;
    const to = range?.toInstant ?? null;

    const result = await this.pool.query<PlatformTierRow>(
      `SELECT COALESCE(p.name, 'unassigned') AS plan_name,
              COUNT(DISTINCT t.id)::int AS tenant_count,
              COUNT(DISTINCT t.id)
                FILTER (WHERE t.status = 'active')::int AS active_tenant_count,
              COUNT(o.tenant_id)
                FILTER (WHERE o.status <> 'cancelled')::int AS order_count,
              COALESCE(SUM(o.total_amount)
                FILTER (WHERE o.status IN ('paid', 'completed')), 0)::text
                AS revenue
         FROM tenants t
         LEFT JOIN plans p ON p.id = t.plan_id
         LEFT JOIN orders o
           ON o.tenant_id = t.id
          AND ($1::timestamptz IS NULL OR o.created_at >= $1)
          AND ($2::timestamptz IS NULL OR o.created_at < $2)
        GROUP BY COALESCE(p.name, 'unassigned')
        ORDER BY plan_name`,
      [from, to],
    );

    return { tiers: result.rows };
  }
}
