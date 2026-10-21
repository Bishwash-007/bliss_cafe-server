import {
  AbstractSubscriptionState,
  type SubscriptionAction,
  type SubscriptionStatus,
} from './subscription-state';

/**
 * `cancelled` — TERMINAL.
 *
 * A cancelled subscription permits no actions. Reviving it would resurrect an
 * old `started_at`/`ends_at` history and make the renewal sweep see a period
 * that was explicitly ended. A returning tenant goes through onboarding and
 * receives a new subscription row.
 */
export class CancelledState extends AbstractSubscriptionState {
  readonly status: SubscriptionStatus = 'cancelled';

  protected actions(): readonly SubscriptionAction[] {
    return [];
  }
}
