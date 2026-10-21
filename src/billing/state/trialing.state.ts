import {
  AbstractSubscriptionState,
  type SubscriptionAction,
  type SubscriptionStatus,
} from './subscription-state';

/**
 * `trialing` — the tenant is inside a free trial.
 *
 * A trial may convert (`renew` charges the plan and moves to `active`), change
 * plan, or be cancelled. It is deliberately treated as a live subscription for
 * billing purposes, which is why the renewal job includes it.
 */
export class TrialingState extends AbstractSubscriptionState {
  readonly status: SubscriptionStatus = 'trialing';

  protected actions(): readonly SubscriptionAction[] {
    return ['upgrade', 'downgrade', 'renew', 'cancel'];
  }
}
