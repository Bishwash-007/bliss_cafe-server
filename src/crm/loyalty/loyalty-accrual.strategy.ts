/**
 * How loyalty points are earned from a paid order.
 *
 * ## Why this is an interface
 *
 * "One point per 100 spent" is a rule this tenant happens to use, not a law of
 * the domain. A second tenant may want a point per visit, a bonus multiplier
 * for a tier, or no accrual at all. Each of those is a different formula, and
 * the alternative to this interface is a `switch (ruleType)` inside
 * `CrmService` that every new rule has to be added to — and that every caller
 * has to remember exists.
 *
 * The strategy is stateless: it is handed the order total and returns a whole
 * number of points. It does not read the database, does not know the customer
 * and does not know the account. That is what makes the accrual arithmetic
 * testable without a connection, and what keeps the idempotency gate (the
 * `loyalty_credits` ledger) in one place rather than duplicated in every rule.
 */
/**
 * DI token for the accrual rule.
 *
 * The module binds it to `PointsPerCurrencyStrategy`. A tenant that earns
 * points per visit, or not at all, is a different binding — `CrmService` never
 * branches on the rule.
 */
export const LOYALTY_ACCRUAL_STRATEGY = 'LOYALTY_ACCRUAL_STRATEGY';

export interface LoyaltyAccrualStrategy {
  /** The strategy's registered name. */
  readonly name: string;

  /**
   * Points earned for an order of `orderTotal`.
   *
   * Returns a whole, non-negative number. Any fraction of a point is not
   * awarded — a loyalty balance is an integer column, and rounding UP would
   * hand out points for money the customer did not spend.
   */
  calculatePoints(orderTotal: number): number;
}
