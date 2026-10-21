import { fromCents, toCents } from '../money';
import type { DiscountStrategy } from './discount.strategy';

/**
 * # PercentageDiscountStrategy
 *
 * A `discount_value` of `12.5` means 12.5% off the subtotal.
 *
 * The percentage is held as a number of percent, not a fraction, because that
 * is how the `promotions` row stores it and how a manager types it. Converting
 * it to `0.125` in one place would be a second convention for the same value.
 *
 * ## Clamping
 *
 * `apply` never returns less than zero or more than the subtotal. The service
 * validates a new promotion's percentage into `0..100`, but rows written before
 * that validation existed are still in the table, and a 150% promotion that
 * turned a bill into a credit would be much worse than one that simply cannot
 * discount more than the bill. Clamping is the backstop; validation is the
 * primary rule.
 */
export class PercentageDiscountStrategy implements DiscountStrategy {
  readonly discountType = 'percentage';

  constructor(private readonly percentage: number) {
    if (!Number.isFinite(percentage)) {
      throw new RangeError(
        `A percentage discount must be a finite number, got ${percentage}`,
      );
    }
  }

  apply(subtotal: number): number {
    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      return 0;
    }

    const cents = toCents(subtotal);
    const percentage = Math.min(100, Math.max(0, this.percentage));
    const discountCents = Math.round((cents * percentage) / 100);

    return fromCents(Math.min(cents, Math.max(0, discountCents)));
  }
}
