import { UnknownSubscriptionStatusException } from '../exceptions/billing.exceptions';
import { ActiveState } from './active.state';
import { CancelledState } from './cancelled.state';
import { PastDueState } from './past-due.state';
import {
  isSubscriptionStatus,
  type SubscriptionState,
  type SubscriptionStatus,
} from './subscription-state';
import { TrialingState } from './trialing.state';

/**
 * ## The registry — the ONLY way to obtain a `SubscriptionState`
 *
 * `Record<SubscriptionStatus, …>` makes the compiler reject a new status without
 * a state class. A status written by a newer deploy (or edited by hand) fails
 * loudly with `UnknownSubscriptionStatusException` instead of behaving like a
 * state with no actions — which would look like "the tenant may do nothing"
 * and silently stop billing.
 *
 * Instances are stateless, so they are cached for the life of the process.
 */
const REGISTRY: Readonly<Record<SubscriptionStatus, () => SubscriptionState>> =
  {
    trialing: () => new TrialingState(),
    active: () => new ActiveState(),
    past_due: () => new PastDueState(),
    cancelled: () => new CancelledState(),
  };

const cache = new Map<string, SubscriptionState>();

export function subscriptionStateFor(status: string): SubscriptionState {
  const cached = cache.get(status);
  if (cached) {
    return cached;
  }
  if (!isSubscriptionStatus(status)) {
    throw new UnknownSubscriptionStatusException(status);
  }
  const state = REGISTRY[status]();
  cache.set(status, state);
  return state;
}
