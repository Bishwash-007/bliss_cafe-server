import type { BillingPlan } from '../billing.types';

/** DI token for the strategy used by `SubscriptionService`. */
export const PRORATION_STRATEGY = 'BILLING_PRORATION_STRATEGY';

/**
 * ## Strategy pattern — plan-change arithmetic
 *
 * The calculation depends on *when* the change takes effect. Keeping it behind
 * an interface means the service never grows a branch of date arithmetic, and a
 * future no-proration or next-cycle strategy is a new class plus one provider
 * registration.
 */
export interface ProrationStrategy {
  /**
   * The amount to charge for a plan change.
   *
   * Positive = charge the tenant now. Negative = credit the tenant. Zero means
   * the change is value-neutral and needs no gateway call.
   */
  calculate(
    oldPlan: BillingPlan,
    newPlan: BillingPlan,
    daysRemainingInCycle: number,
  ): number;
}
