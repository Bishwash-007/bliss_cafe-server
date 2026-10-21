/**
 * ## State pattern (GoF) — a subscription's lifecycle
 *
 * `tenant_subscriptions.status` is a plain `VARCHAR(20)` in
 * `db/migrations/002_tenants_and_plans.sql`, and stays that way: no enum and no
 * database trigger. The rules about *which* actions a subscription permits
 * live here, in one transition table, rather than being scattered through
 * controllers and the renewal job.
 *
 * The important asymmetry is deliberate:
 *
 *   - `past_due` can `retry_payment` or `cancel`, but NOT `upgrade`/
 *     `downgrade`. A tenant who has not paid cannot buy a bigger plan.
 *   - `cancelled` is terminal. Reactivation is onboarding a new subscription,
 *     not reviving the old one with its historical billing dates.
 *
 * Each concrete status owns only its own allowed actions, so a reviewer asking
 * "what can a past-due tenant do?" reads `PastDueState` and nothing else.
 */

/** The canonical subscription statuses, mirroring the schema comment. */
export const SUBSCRIPTION_STATUSES = [
  'trialing',
  'active',
  'past_due',
  'cancelled',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Narrows an untrusted string to a known subscription status. */
export function isSubscriptionStatus(
  value: unknown,
): value is SubscriptionStatus {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_STATUSES as readonly string[]).includes(value)
  );
}

/** Every action a caller may ask the subscription service to perform. */
export const SUBSCRIPTION_ACTIONS = [
  'upgrade',
  'downgrade',
  'renew',
  'retry_payment',
  'cancel',
] as const;

export type SubscriptionAction = (typeof SUBSCRIPTION_ACTIONS)[number];

/** Narrows an untrusted string to a known subscription action. */
export function isSubscriptionAction(
  value: unknown,
): value is SubscriptionAction {
  return (
    typeof value === 'string' &&
    (SUBSCRIPTION_ACTIONS as readonly string[]).includes(value)
  );
}

/** One node of the subscription lifecycle graph. */
export interface SubscriptionState {
  readonly status: SubscriptionStatus;
  allowedActions(): SubscriptionAction[];
  can(action: string): boolean;
}

/**
 * Shared implementation: a subclass declares its status and the actions it
 * permits. The returned array is a copy so a caller cannot mutate the table by
 * writing into it.
 */
export abstract class AbstractSubscriptionState implements SubscriptionState {
  abstract readonly status: SubscriptionStatus;
  protected abstract actions(): readonly SubscriptionAction[];

  allowedActions(): SubscriptionAction[] {
    return [...this.actions()];
  }

  can(action: string): boolean {
    return (this.actions() as readonly string[]).includes(action);
  }
}
