import { fromCents, toCents } from '../money';
import type { DiscountStrategy } from './discount.strategy';

/**
 * # FlatDiscountStrategy
 *
 * A `discount_value` of `5.00` means 5.00 off the subtotal, regardless of what
 * was ordered.
 *
 * The amount is clamped to the subtotal: a 5.00 promotion on a 3.00 coffee
 * takes 3.00 off and the bill is 0.00, never -2.00. A negative total would be a
 * refund the customer never asked for, and every payment provider downstream
 * would treat it as one.
 */
export class FlatDiscountStrategy implements DiscountStrategy {
  readonly discountType = 'flat';

  constructor(private readonly amount: number) {
    if (!Number.isFinite(amount)) {
      throw new RangeError(
        `A flat discount must be a finite amount, got ${amount}`,
      );
    }
  }

  apply(subtotal: number): number {
    if (!Number.isFinite(subtotal) || subtotal <= 0) {
      return 0;
    }

    const cents = toCents(subtotal);
    const discountCents = Math.max(0, toCents(this.amount));

    return fromCents(Math.min(cents, discountCents));
  }
}
