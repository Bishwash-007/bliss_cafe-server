# Agent Prompt: InventoryModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/007_inventory.sql` before writing code. **This module depends on `OrderModule`'s event bus already existing** — confirm `order.status_changed` is being published (see the OrderModule prompt) before starting, and do not create a second event system.

## Scope
Stock levels, recipe-based automatic deduction, purchase orders, low-stock alerting.

## Design Patterns

**Observer** — this module is a *subscriber*, not a publisher. It listens to `OrderModule`'s existing event bus rather than being called directly and synchronously from order-completion code. This keeps `OrderService` from needing to know inventory exists at all.

**Strategy** — low-stock alert behavior can reasonably vary per item type (a perishable dairy item might need a threshold-based alert well before a shelf-stable syrup does). Isolate this so a future predictive/consumption-rate-based strategy doesn't require rewriting the alerting call sites.

## Task

1. Register a listener on `order.status_changed`. When an order's new status is `completed`:
   - For each `order_item`, look up `recipe_ingredients` for its `menu_item_id`.
   - Multiply each ingredient's `quantity_used` by the `order_item.quantity`.
   - Insert corresponding negative `stock_movements` rows (`movement_type = 'usage'`) and update `inventory_items.quantity_on_hand` — **all in one transaction**. If deduction fails, do not leave the order marked `completed` with inventory silently un-deducted; decide explicitly (with a comment explaining the choice) whether to roll back the order status or flag the discrepancy for manual review.
2. **Strategy pattern**: define `ReorderAlertStrategy` interface with a `shouldAlert(item: InventoryItem): boolean` method. Implement `ThresholdAlertStrategy` (fires when `quantity_on_hand <= reorder_threshold`) as the default. Structure this so a future `PredictiveAlertStrategy` can be swapped in via tenant config without touching the caller.
3. Manual endpoints: `POST /inventory/:id/stock-in` (purchase/receiving), `POST /inventory/:id/adjust` (wastage/audit correction) — both insert `stock_movements` with the appropriate `movement_type` and update `quantity_on_hand`.
4. Supplier CRUD (`suppliers` table) — simple, no special pattern needed.
5. When a low-stock alert strategy fires, publish an `inventory.low_stock` event — this is consumed by `NotificationModule` (see its prompt), not handled here.

## Acceptance Criteria (write tests for these)
- Completing an order with a multi-ingredient recipe deducts the exact correct quantities for each ingredient.
- The deduction and the order's `completed` status change are atomic — a forced failure in deduction does not leave a `completed` order with un-deducted stock silently.
- `ThresholdAlertStrategy` fires exactly at the threshold boundary, not one unit before or after.
- Manual stock-in and adjustment endpoints correctly update `quantity_on_hand` and leave an audit trail in `stock_movements`.
