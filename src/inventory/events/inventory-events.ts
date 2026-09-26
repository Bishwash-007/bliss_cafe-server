/**
 * # The inventory event bus — the CONTRACT for downstream modules
 *
 * This module is a SUBSCRIBER first and a publisher second, and the asymmetry is
 * deliberate:
 *
 *   - It consumes `order.status_changed` from `OrderModule` (imported from
 *     `../order`, never from `OrderService`) and reacts to `completed`.
 *   - It publishes exactly one event, `inventory.low_stock`, which
 *     `NotificationModule` (10) consumes. This module does not email anybody.
 *
 * A subscriber should need these names and payload types and nothing else from
 * `InventoryModule` — not the repository, not the alert strategies.
 *
 * ## Timing
 *
 * `inventory.low_stock` is published AFTER the triggering transaction has
 * committed, via `TenantScopedConnection.onCommit` — the same guarantee the order
 * events give. It would be tempting to publish inline "so the caller knows
 * whether an alert fired", but that is wrong in a way that only shows up later:
 * a `NotificationModule` subscriber that re-reads the item on its own connection
 * would not see the new level, because the write is not committed yet. So a
 * subscriber would see `quantityOnHand: 3` (the committed, pre-movement value)
 * sitting next to a `quantityOnHand: 0` in the payload, and no amount of
 * re-reading would fix it.
 *
 * Publishing after commit also means an alert can never describe a movement that
 * was rolled back.
 *
 * ## Idempotency
 *
 * `order.status_changed` is best-effort and in-process, so a subscriber must be
 * safe to run twice. The `orderId` on the payload is the key: the deduction
 * ledger enforces exactly-once per order, so redelivery is a no-op rather than a
 * second deduction.
 */

/** Event names published by `InventoryModule`. */
export const INVENTORY_EVENTS = {
  /**
   * An item is at or below its reorder point.
   *
   * Asked of the tenant's `ReorderAlertStrategy` after each movement, so this
   * fires on EVERY movement that leaves the item low — a second delivery while
   * still low is a fresh one, not a duplicate. The strategy interface is
   * deliberately stateless (`shouldAlert(item): boolean`, no history argument),
   * which is what lets a future predictive strategy be dropped in without
   * changing a single call site. A subscriber that must not be repeated should
   * dedupe on `(inventoryItemId, triggeredByMovementId)`, which is unique per
   * movement and therefore per event.
   */
  lowStock: 'inventory.low_stock',
} as const;

export type InventoryEventName =
  (typeof INVENTORY_EVENTS)[keyof typeof INVENTORY_EVENTS];

/** Severity of a low-stock condition, so a subscriber can route it. */
export const LOW_STOCK_SEVERITY = {
  /**
   * At or below the reorder threshold. A reorder is due; the item may still be
   * sellable.
   */
  reorder: 'reorder',
  /**
   * Quantity has gone to zero or below — the recipe cannot actually be made any
   * more. Distinct from `reorder` because "order more flour" and "you have run
   * out of flour" are different messages to whoever receives them.
   */
  outOfStock: 'out_of_stock',
} as const;

export type LowStockSeverity =
  (typeof LOW_STOCK_SEVERITY)[keyof typeof LOW_STOCK_SEVERITY];

export interface InventoryLowStockEvent {
  readonly event: typeof INVENTORY_EVENTS.lowStock;
  readonly inventoryItemId: string;
  readonly tenantId: string;
  readonly branchId: string;
  readonly name: string;
  readonly unit: string;
  readonly quantityOnHand: number;
  readonly reorderThreshold: number;
  readonly severity: LowStockSeverity;
  /** The movement that crossed the threshold, for context in a notification. */
  readonly triggeredByMovementId: string | null;
  readonly occurredAt: string;
}
