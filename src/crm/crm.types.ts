/**
 * Row and domain shapes for the CRM module.
 *
 * Same two conventions as the inventory, staff and menu modules:
 *
 *  - RAW rows are the database shape: `snake_case`, `NUMERIC` columns as
 *    strings, `TIMESTAMPTZ` columns as `Date`. The API returns rows in this
 *    shape deliberately, so a client reads what the database stores.
 *  - DOMAIN shapes are `camelCase` with money already parsed into numbers, and
 *    only exist where the module computes something the database does not
 *    store (a discount, a points credit).
 *
 * `customers` and `promotions` were created in migrations 006 and 008 and are
 * already covered by the RLS policy from 010. `loyalty_credits` is new in 014.
 */

/** Raw row of `customers`. Phone is nullable in the schema, not in the API. */
export interface CustomerRow {
  id: string;
  tenant_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  created_at: Date;
}

/** Raw row of `loyalty_accounts`. */
export interface LoyaltyAccountRow {
  id: string;
  tenant_id: string;
  customer_id: string;
  points_balance: number;
  tier: string;
  updated_at: Date;
}

/** Raw row of `promotions`. */
export interface PromotionRow {
  id: string;
  tenant_id: string;
  code: string;
  description: string | null;
  discount_type: string;
  discount_value: string;
  starts_at: Date | null;
  ends_at: Date | null;
  is_active: boolean;
}

/** Raw row of `loyalty_credits`. */
export interface LoyaltyCreditRow {
  id: string;
  tenant_id: string;
  order_id: string;
  customer_id: string;
  points: number;
  created_at: Date;
}

/** A customer together with their loyalty account, when one exists. */
export interface CustomerProfile {
  customer: CustomerRow;
  loyalty: LoyaltyAccountRow | null;
}

/**
 * The outcome of a lookup-or-create.
 *
 * `created` is what lets a checkout screen say "new customer" rather than
 * silently reusing somebody else's profile that happened to share a phone
 * number — the difference matters at the counter even though it does not
 * change the row.
 */
export interface CustomerLookupResult extends CustomerProfile {
  created: boolean;
}

/**
 * The outcome of crediting one paid order.
 *
 * `credited: false` is a normal result, not an error: the event was a duplicate,
 * the order had no customer, or the order was not visible. The listener logs the
 * reason and moves on; nothing about a loyalty credit should fail a checkout
 * that has already committed.
 */
export type LoyaltyAccrualOutcome =
  | {
      credited: true;
      points: number;
      account: LoyaltyAccountRow | null;
      orderId: string;
      customerId: string;
    }
  | {
      credited: false;
      points: 0;
      account: null;
      orderId: string;
      reason: 'duplicate' | 'order_not_found' | 'no_customer';
      customerId: string | null;
    };

/** The result of applying a promotion to a subtotal. */
export interface PromotionApplication {
  promotionId: string;
  code: string;
  discountType: string;
  /** The subtotal the promotion was applied to, as sent. */
  subtotal: number;
  /** The amount to subtract. Never negative and never more than `subtotal`. */
  discountAmount: number;
  /** `subtotal - discountAmount`, rounded to the cent. */
  total: number;
}
