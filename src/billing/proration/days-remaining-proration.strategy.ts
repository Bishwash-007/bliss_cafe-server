import { BILLING_CYCLE_DAYS, round2, type BillingPlan } from '../billing.types';
import type { ProrationStrategy } from './proration.strategy';

/**
 * Mid-cycle proration by days remaining.
 *
 * The tenant is charged the price difference for the portion of the current
 * cycle that is left:
 *
 *   amount = (newPlan − oldPlan) × daysRemaining / cycleDays
 *
 * An upgrade (positive difference) produces a charge. A downgrade produces a
 * negative amount, which the service reports as a credit rather than sending a
 * negative "charge" to a gateway that only accepts positive amounts.
 *
 * ## Why it is a separate class
 *
 * This is one of several legitimate billing policies. "Downgrade takes effect
 * next cycle" would return `0` here and schedule the new plan for renewal; a
 * promotional strategy could cap the charge. The service does not care — it
 * only asks for a number.
 */
export class DaysRemainingProrationStrategy implements ProrationStrategy {
  calculate(
    oldPlan: BillingPlan,
    newPlan: BillingPlan,
    daysRemainingInCycle: number,
  ): number {
    const days = Math.min(
      BILLING_CYCLE_DAYS,
      Math.max(0, Math.trunc(daysRemainingInCycle)),
    );
    if (days === 0) {
      return 0;
    }

    const difference = newPlan.priceMonthly - oldPlan.priceMonthly;
    return round2((difference * days) / BILLING_CYCLE_DAYS);
  }
}
