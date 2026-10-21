import {
  AbstractSubscriptionState,
  type SubscriptionAction,
  type SubscriptionStatus,
} from './subscription-state';

/**
 * `past_due` — a renewal charge failed and the subscription is not current.
 *
 * Exactly two actions are allowed:
 *
 *   - `retry_payment` — attempt the outstanding charge again;
 *   - `cancel` — stop billing altogether.
 *
 * `upgrade`/`downgrade` are intentionally absent. Letting a tenant who has not
 * paid move to a bigger plan would compound the debt, and letting them move
 * down would rewrite the price of a period they never paid for. They must
 * become current (or be re-onboarded) first.
 */
export class PastDueState extends AbstractSubscriptionState {
  readonly status: SubscriptionStatus = 'past_due';

  protected actions(): readonly SubscriptionAction[] {
    return ['retry_payment', 'cancel'];
  }
}
