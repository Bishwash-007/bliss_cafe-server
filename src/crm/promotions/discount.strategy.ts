/**
 * How a promotion turns a subtotal into a discount.
 *
 * ## Why this is an interface
 *
 * The `promotions` table stores a `discount_type` and a `discount_value`, and
 * the obvious implementation is `if (type === 'percentage') … else if (type ===
 * 'flat') …`. That branch is the thing this interface removes: a new type
 * (`buy_one_get_one`, `free_delivery`) becomes a class and an entry in
 * `PromotionService`'s factory, not an edit to every place that prices a
 * promotion. An unknown type is refused rather than defaulting to one of the
 * two, because applying the wrong kind of discount is a receipt the tenant
 * cannot explain.
 *
 * ## `apply` returns the DISCOUNT, not the final total
 *
 * Named for the question the caller actually asks ("how much comes off?"), and
 * because a strategy that returned a total would have to know about tax and
 * every other line item to be correct. The caller subtracts.
 */
export interface DiscountStrategy {
  /** The `discount_type` this strategy implements. */
  readonly discountType: string;

  /**
   * The amount to subtract from `subtotal`.
   *
   * Always in `[0, subtotal]`: never negative (a promotion must not increase a
   * bill) and never more than the subtotal (a discount must not turn a bill
   * into a credit). Rounding is to the nearest cent, half away from zero.
   */
  apply(subtotal: number): number;
}

/** The `discount_type` values this module can calculate. */
export const DISCOUNT_TYPES = ['percentage', 'flat'] as const;

export type DiscountType = (typeof DISCOUNT_TYPES)[number];

export function isDiscountType(value: unknown): value is DiscountType {
  return (
    typeof value === 'string' &&
    (DISCOUNT_TYPES as readonly string[]).includes(value)
  );
}
