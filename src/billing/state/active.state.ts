import {
  AbstractSubscriptionState,
  type SubscriptionAction,
  type SubscriptionStatus,
} from './subscription-state';

/**
 * `active` — the current period is paid and the tenant is in good standing.
 *
 * Plan changes, an early/manual renewal and cancellation are all legal. No
 * other status can reach a charged renewal without passing through here.
 */
export class ActiveState extends AbstractSubscriptionState {
  readonly status: SubscriptionStatus = 'active';

  protected actions(): readonly SubscriptionAction[] {
    return ['upgrade', 'downgrade', 'renew', 'cancel'];
  }
}
