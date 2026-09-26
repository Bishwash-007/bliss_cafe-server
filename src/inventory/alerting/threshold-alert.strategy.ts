import { Injectable } from '@nestjs/common';
import type { InventoryItem } from '../inventory.types';
import type { ReorderAlertStrategy } from './reorder-alert.strategy';

/**
 * The default strategy: alert when the item is AT or BELOW its reorder point.
 *
 * ## Why `<=` and not `<`
 *
 * This is the whole ballgame for a threshold strategy, so it is worth stating
 * plainly. `reorder_threshold` is the level at which a reorder becomes due. The
 * instant stock reaches that number the reorder IS due — so the boundary itself
 * must alert:
 *
 *   threshold 5, stock 6  -> no   (still above the line)
 *   threshold 5, stock 5  -> YES  (exactly due)
 *   threshold 5, stock 4  -> YES
 *
 * Using `<` instead would leave the item sitting at exactly its reorder point
 * raising nothing, and the reorder would only be triggered by whatever unrelated
 * movement happened to nudge the number down by a hair. For a `NUMERIC(12,3)`
 * quantity that is a rounding edge, not an abstraction: `4.9995` must not round up
 * into silence.
 *
 * Negative stock also alerts, which is correct — it means the recorded stock has
 * already diverged from reality (see `OrderDeductionListener` on why a deduction
 * does not block on insufficient stock).
 */
@Injectable()
export class ThresholdAlertStrategy implements ReorderAlertStrategy {
  readonly name = 'threshold';

  shouldAlert(item: InventoryItem): boolean {
    return item.quantityOnHand <= item.reorderThreshold;
  }
}
