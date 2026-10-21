/**
 * Public barrel for the BillingModule.
 *
 * Only the module, its service and the lifecycle vocabulary are exported.
 * Gateway construction stays in Payment; the repository stays internal so a
 * schema change cannot ripple out through the module boundary.
 */
export { BillingModule } from './billing.module';
export { SubscriptionService } from './subscription.service';
export { SubscriptionRenewalScheduler } from './subscription-renewal.scheduler';
export {
  SUBSCRIPTION_ACTIONS,
  SUBSCRIPTION_STATUSES,
  isSubscriptionAction,
  isSubscriptionStatus,
} from './state/subscription-state';
export type {
  SubscriptionAction,
  SubscriptionState,
  SubscriptionStatus,
} from './state/subscription-state';
export { subscriptionStateFor } from './state/subscription-state.factory';
export { ActiveState } from './state/active.state';
export { TrialingState } from './state/trialing.state';
export { PastDueState } from './state/past-due.state';
export { CancelledState } from './state/cancelled.state';
export type { ProrationStrategy } from './proration/proration.strategy';
export { DaysRemainingProrationStrategy } from './proration/days-remaining-proration.strategy';
export type {
  BillingPlan,
  PlanChangeResult,
  RenewalOutcome,
  RenewalRunSummary,
  SubscriptionActionResult,
  SubscriptionView,
} from './billing.types';
export {
  InvalidPlanChangeException,
  InvalidSubscriptionActionException,
  MissingPlanChangeTargetException,
  PlanNotFoundException,
  SubscriptionChargeFailedException,
  SubscriptionNotFoundException,
  UnknownSubscriptionStatusException,
} from './exceptions/billing.exceptions';
