import { Injectable } from '@nestjs/common';
import { toCents } from '../money';
import type { LoyaltyAccrualStrategy } from './loyalty-accrual.strategy';

/**
 * # PointsPerCurrencyStrategy
 *
 * The default rule: one point per 100 units of currency spent.
 *
 * ## Arithmetic in cents
 *
 * The total arrives as a money amount (`250.50`), is converted to whole cents
 * once (`25050`), and the division happens on integers. Doing it as
 * `Math.floor(total / 100)` happens to work for round totals but not for a
 * bonus rule (`2 points per 100`): `Math.floor(1.5) * 2` is 2, while
 * `Math.floor(1.5 * 2)` is 3. The second is what "two points per hundred"
 * means once a customer has spent 150.
 *
 * ## The fraction is dropped, never rounded up
 *
 * Spending 99.99 earns 0 points. That is the direction a loyalty scheme can
 * defend: the threshold is stated, and a customer who has not reached it has
 * not reached it. Rounding up would award points for money not spent and would
 * make the balance impossible to reconcile against the credit ledger.
 */
@Injectable()
export class PointsPerCurrencyStrategy implements LoyaltyAccrualStrategy {
  readonly name = 'points_per_currency';

  /**
   * @param pointsPerCurrency points awarded per `currencyPerPoint` spent.
   * @param currencyPerPoint the spend threshold for those points.
   */
  constructor(
    private readonly pointsPerCurrency = 1,
    private readonly currencyPerPoint = 100,
  ) {
    if (!Number.isFinite(pointsPerCurrency) || pointsPerCurrency < 0) {
      throw new RangeError(
        `pointsPerCurrency must be a non-negative number, got ${pointsPerCurrency}`,
      );
    }
    if (!Number.isFinite(currencyPerPoint) || currencyPerPoint <= 0) {
      throw new RangeError(
        `currencyPerPoint must be a positive number, got ${currencyPerPoint}`,
      );
    }
  }

  calculatePoints(orderTotal: number): number {
    // A zero or negative order (a refund, a fully discounted ticket) earns
    // nothing rather than a negative balance.
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) {
      return 0;
    }

    const cents = toCents(orderTotal);
    const points = Math.floor(
      (cents * this.pointsPerCurrency) / (this.currencyPerPoint * 100),
    );
    return Math.max(0, points);
  }
}
