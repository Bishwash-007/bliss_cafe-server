import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import {
  quantity,
  type InventoryConsumptionRow,
  type ReportingRepository,
} from '../reporting.repository';
import type { ReportBody, ResolvedDateRange } from '../reporting.types';
import { ReportGenerator } from './report-generator';

/**
 * Stock consumed (recipe usage) and lost (wastage) at one branch.
 *
 * Cost is deliberately absent: the schema has no unit cost on
 * `inventory_items` and no price on `suppliers`, so a "consumption value"
 * column would have to be invented. Quantities are the honest answer from the
 * current tables; adding valuation would need a purchase-cost column first.
 */
export class InventoryReportGenerator extends ReportGenerator<
  InventoryConsumptionRow[]
> {
  constructor(
    private readonly repository: ReportingRepository,
    private readonly connection: TenantScopedConnection,
    private readonly branchId: string,
    private readonly range: ResolvedDateRange,
  ) {
    super();
  }

  protected fetchData(): Promise<InventoryConsumptionRow[]> {
    return this.repository.fetchInventoryConsumption(
      this.connection,
      this.branchId,
      this.range,
    );
  }

  protected aggregate(data: InventoryConsumptionRow[]): ReportBody {
    const rows = data.map((row) => ({
      inventoryItemId: row.inventory_item_id,
      name: row.name,
      unit: row.unit,
      usageQuantity: quantity(row.usage_quantity),
      wastageQuantity: quantity(row.wastage_quantity),
      consumedQuantity: quantity(row.consumed_quantity),
      movementCount: row.movement_count,
    }));

    const sum = (
      key:
        | 'usageQuantity'
        | 'wastageQuantity'
        | 'consumedQuantity'
        | 'movementCount',
    ) => rows.reduce((total, row) => total + row[key], 0);

    return {
      type: 'inventory-consumption',
      title: 'Inventory consumption report',
      branchId: this.branchId,
      range: { from: this.range.from, to: this.range.to },
      summary: {
        itemCount: rows.length,
        usageQuantity: quantity(sum('usageQuantity')),
        wastageQuantity: quantity(sum('wastageQuantity')),
        consumedQuantity: quantity(sum('consumedQuantity')),
        movementCount: sum('movementCount'),
      },
      tables: [
        {
          key: 'items',
          title: 'Consumption by inventory item',
          columns: [
            { key: 'name', label: 'Item' },
            { key: 'unit', label: 'Unit' },
            { key: 'usageQuantity', label: 'Usage' },
            { key: 'wastageQuantity', label: 'Wastage' },
            { key: 'consumedQuantity', label: 'Consumed' },
            { key: 'movementCount', label: 'Movements' },
          ],
          rows,
          totals: {
            name: 'TOTAL',
            usageQuantity: quantity(sum('usageQuantity')),
            wastageQuantity: quantity(sum('wastageQuantity')),
            consumedQuantity: quantity(sum('consumedQuantity')),
            movementCount: sum('movementCount'),
          },
        },
      ],
    };
  }
}
