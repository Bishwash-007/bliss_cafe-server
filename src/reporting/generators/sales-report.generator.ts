import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import {
  money,
  type ReportingRepository,
  type SalesRaw,
} from '../reporting.repository';
import type { ReportBody, ResolvedDateRange } from '../reporting.types';
import { ReportGenerator } from './report-generator';

/**
 * Sales rows, split by day and by order type, for one branch.
 *
 * The reporting period is applied to `orders.created_at` — when the order was
 * placed — not to `updated_at`. The schema has no `paid_at` on `orders` (only
 * `payments` does), so using `updated_at` would make a report change when an
 * unrelated status edit touched an old row. Revenue is `total_amount` after
 * discount and including tax, for orders in `REVENUE_ORDER_STATUSES`.
 */
export class SalesReportGenerator extends ReportGenerator<SalesRaw> {
  constructor(
    private readonly repository: ReportingRepository,
    private readonly connection: TenantScopedConnection,
    private readonly branchId: string,
    private readonly range: ResolvedDateRange,
  ) {
    super();
  }

  protected fetchData(): Promise<SalesRaw> {
    return this.repository.fetchSales(
      this.connection,
      this.branchId,
      this.range,
    );
  }

  protected aggregate(data: SalesRaw): ReportBody {
    const totals = data.totals;
    const revenue = money(totals.revenue);
    const orderCount = totals.order_count;

    return {
      type: 'sales',
      title: 'Sales report',
      branchId: this.branchId,
      range: { from: this.range.from, to: this.range.to },
      summary: {
        orderCount,
        itemCount: totals.item_count,
        subtotal: money(totals.subtotal),
        discounts: money(totals.discount_amount),
        tax: money(totals.tax_amount),
        revenue,
        averageOrderValue: orderCount === 0 ? 0 : money(revenue / orderCount),
      },
      tables: [
        {
          key: 'daily',
          title: 'Revenue by day',
          columns: [
            { key: 'date', label: 'Date' },
            { key: 'orderCount', label: 'Orders' },
            { key: 'revenue', label: 'Revenue' },
          ],
          rows: data.byDay.map((row) => ({
            date: row.key,
            orderCount: row.order_count,
            revenue: money(row.revenue),
          })),
          totals: {
            date: 'TOTAL',
            orderCount,
            revenue,
          },
        },
        {
          key: 'order-types',
          title: 'Revenue by order type',
          columns: [
            { key: 'orderType', label: 'Order type' },
            { key: 'orderCount', label: 'Orders' },
            { key: 'revenue', label: 'Revenue' },
          ],
          rows: data.byOrderType.map((row) => ({
            orderType: row.key,
            orderCount: row.order_count,
            revenue: money(row.revenue),
          })),
          totals: {
            orderType: 'TOTAL',
            orderCount,
            revenue,
          },
        },
      ],
    };
  }
}
