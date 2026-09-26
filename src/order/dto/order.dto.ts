import type { OrderType } from '../events/order-events';

/**
 * Order write payloads.
 *
 * This project runs no `class-validator` pipe, so these stay plain interfaces
 * and the *semantic* rules (is that a real menu item? is that status known? is
 * that transition legal?) are enforced in `OrderService`, where they can be
 * tested directly and reused by non-HTTP callers.
 *
 * ## Money is NOT accepted from the client
 *
 * There is deliberately no `unitPrice`, `subtotal` or `total` field anywhere in
 * these DTOs. Every monetary figure is derived server-side from `menu_items`
 * and `menu_item_modifiers` at order time (see `OrderService.price`), and the
 * result is frozen onto the order row — which is why historic orders keep
 * showing what they were sold at after the menu is edited. A client that could
 * post its own `totalAmount` would be a client that can sell a flat white for
 * one cent.
 */

/** One line on the ticket. `menuItemId` may be the org-wide id or the branch override id. */
export interface CreateOrderItemDto {
  menuItemId: string;
  quantity?: number;
  notes?: string | null;
  modifiers?: CreateOrderModifierDto[];
}

/**
 * A chosen modifier variant. Identified the way the menu stores it — the
 * (`name`, `optionName`) pair, e.g. `('Size', 'Large')` — and priced
 * server-side from `menu_item_modifiers.extra_price`. `modifierId` is optional
 * and only a fast path: the order row snapshots it when supplied so history can
 * be joined back to the live modifier.
 */
export interface CreateOrderModifierDto {
  name: string;
  optionName: string;
  modifierId?: string | null;
}

export interface CreateOrderDto {
  /** Which branch's kitchen this ticket belongs to (the KDS room). */
  branchId: string;
  /** Required for `dine_in`; ignored for takeaway/delivery. */
  tableId?: string | null;
  customerId?: string | null;
  orderType?: OrderType;
  /**
   * Idempotency key from the mobile offline action queue.
   *
   * Supplying it makes creation safe to retry: a second POST carrying the same
   * key returns the ORIGINAL order instead of failing on the
   * `idx_orders_client_action` unique index.
   */
  clientActionId?: string | null;
  items: CreateOrderItemDto[];
  /**
   * Known gap, called out here so nobody mistakes it for a finished feature:
   * the schema has no tenant-level tax rate or currency setting yet (the
   * `tax_amount` column exists, `tenants` has no `tax_rate`), so there is no
   * server-side source of truth to compute tax from. Until that settings
   * column lands, callers may pass the amount their POS already calculated;
   * when omitted it is 0. Same story for `discountAmount` — a real
   * implementation belongs with the per-tenant tax/discount rules and the
   * audit log the design calls for.
   */
  taxAmount?: number;
  discountAmount?: number;
}

/** Requested target status for `POST /orders/:id/transition`. */
export interface TransitionOrderDto {
  status: string;
}
