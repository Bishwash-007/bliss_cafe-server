import {
  type PlatformRaw,
  type PlatformReportingRepository,
} from '../platform-reporting.repository';
import { money } from '../reporting.repository';
import type { ReportBody, ResolvedDateRange } from '../reporting.types';
import { ReportGenerator } from './report-generator';

/**
 * The platform-wide view: every tenant, not one.
 *
 * It uses the same Template Method as the tenant reports, but its repository
 * runs on the platform pool because RLS would otherwise hide every order. This
 * is the deliberate exception described in `6. platform-level report`.
 */
export class PlatformReportGenerator extends ReportGenerator<PlatformRaw> {
  constructor(
    private readonly repository: PlatformReportingRepository,
    private readonly range: ResolvedDateRange | null,
  ) {
    super();
  }

  protected fetchData(): Promise<PlatformRaw> {
    return this.repository.fetchOverview(this.range);
  }

  protected aggregate(data: PlatformRaw): ReportBody {
    const rows = data.tiers.map((tier) => ({
      planTier: tier.plan_name,
      tenantCount: tier.tenant_count,
      activeTenantCount: tier.active_tenant_count,
      orderCount: tier.order_count,
      revenue: money(tier.revenue),
    }));

    const sum = (
      key: 'tenantCount' | 'activeTenantCount' | 'orderCount' | 'revenue',
    ) => rows.reduce((total, row) => total + row[key], 0);

    return {
      type: 'platform-overview',
      title: 'Platform overview report',
      branchId: null,
      range: this.range ? { from: this.range.from, to: this.range.to } : null,
      summary: {
        activeTenantCount: sum('activeTenantCount'),
        tenantCount: sum('tenantCount'),
        planTierCount: rows.length,
        totalOrderVolume: sum('orderCount'),
        totalRevenue: money(sum('revenue')),
      },
      tables: [
        {
          key: 'plan-tiers',
          title: 'Revenue by plan tier',
          columns: [
            { key: 'planTier', label: 'Plan tier' },
            { key: 'tenantCount', label: 'Tenants' },
            { key: 'activeTenantCount', label: 'Active tenants' },
            { key: 'orderCount', label: 'Orders' },
            { key: 'revenue', label: 'Revenue' },
          ],
          rows,
          totals: {
            planTier: 'TOTAL',
            tenantCount: sum('tenantCount'),
            activeTenantCount: sum('activeTenantCount'),
            orderCount: sum('orderCount'),
            revenue: money(sum('revenue')),
          },
        },
      ],
    };
  }
}
