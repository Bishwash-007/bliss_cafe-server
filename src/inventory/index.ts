/**
 * # InventoryModule — public surface
 *
 * Deliberately small, and sized by what a caller actually needs:
 *
 *   - `InventoryService` — to move stock deliberately (a purchase order landing,
 *     a stocktake, a recipe correction).
 *   - `INVENTORY_EVENTS` and `InventoryLowStockEvent` — for `NotificationModule`
 *     (10) to subscribe to reorder alerts. That is the whole reason this event
 *     exists; nothing in this module emails anybody.
 *   - `ReorderStrategyRegistry` — only for a future settings surface that needs
 *     to list or change a tenant's strategy.
 *
 * A caller should NOT need `InventoryRepository` (data access stays internal, so
 * a future schema change cannot ripple out) or the deduction listener (a module
 * that wants stock consumed for an order publishes the order event; it does not
 * call the deduction directly).
 *
 * ```ts
 * // subscriber
 * import { INVENTORY_EVENTS, type InventoryLowStockEvent } from '../inventory';
 *
 * @OnEvent(INVENTORY_EVENTS.lowStock)
 * onLowStock(event: InventoryLowStockEvent): void { ... }
 * ```
 *
 * `inventory.low_stock` fires only after the triggering transaction has COMMITTED
 * (registered through `TenantScopedConnection.onCommit`), so a subscriber may
 * re-read the item on its own connection and will see the level in the payload.
 * See `./events/inventory-events` for the full timing contract.
 *
 * ## Branch scoping
 *
 * Every item-addressed call takes an `InventoryActor`. A caller whose token names
 * a branch (a `branch_manager`) may only touch that branch's stock; a caller with
 * no branch in its token (`org_owner`, `super_admin`) may work anywhere in the
 * tenant. RLS cannot do this — branches of one cafe share a tenant — so the check
 * is in the service, not only at the HTTP edge, and it is enforced before any
 * write rather than after.
 *
 * ## Deliberately not implemented: purchase orders
 *
 * The module's scope line names "purchase orders", and this module does not
 * implement them. It has no `purchase_orders` table, no draft → ordered → received
 * workflow, and no receiving-against-a-PO logic.
 *
 * That is a deliberate deferral rather than an oversight. The schema the module is
 * specified against (`db/migrations/007_inventory.sql`) contains no purchase-order
 * table, and the module's own task list asks only for a stock-in endpoint, not for
 * a purchase-order entity. A delivery is therefore recorded as a stock-in tagged
 * `movement_type = 'purchase'`, which is the part the deduction path and the
 * reorder alerts actually depend on.
 *
 * Building the rest — a PO table, statuses, a "receive against PO" flow that
 * creates the movements a PO implies — is a schema and product decision, not a
 * gap that can be closed inside this module.
 */

// The event contract — the names, payloads and timing a subscriber codes against.
export {
  INVENTORY_EVENTS,
  LOW_STOCK_SEVERITY,
  type InventoryEventName,
  type InventoryLowStockEvent,
  type LowStockSeverity,
} from './events/inventory-events';

// Callable surface.
export { InventoryService, type DeductionOutcome } from './inventory.service';

// Reorder strategy seam, for a tenant settings surface.
export {
  DEFAULT_REORDER_STRATEGY,
  ReorderStrategyRegistry,
  type ReorderStrategyConfig,
} from './alerting/reorder-strategy.registry';
export type { ReorderAlertStrategy } from './alerting/reorder-alert.strategy';

// Domain vocabulary, for callers that need to name a movement or a status.
export {
  DEDUCTION_STATUSES,
  STOCK_MOVEMENT_TYPES,
  type DeductionStatus,
  type InventoryItem,
  type StockMovement,
  type StockMovementType,
} from './inventory.types';

// Failures a caller may want to branch on.
export {
  BranchAccessDeniedException,
  InvalidQuantityException,
  InventoryItemNotFoundException,
  RecipeNotFoundException,
  SupplierInUseException,
  SupplierNotFoundException,
} from './exceptions/inventory.exceptions';
