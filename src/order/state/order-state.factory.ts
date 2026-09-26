import { UnknownOrderStatusException } from '../exceptions/order.exceptions';
import { AwaitingPaymentState } from './awaiting-payment.state';
import { CancelledState } from './cancelled.state';
import { CompletedState } from './completed.state';
import { ConfirmedState } from './confirmed.state';
import { isOrderStatus, type OrderState } from './order-state';
import { PaidState } from './paid.state';
import { PlacedState } from './placed.state';
import { PreparingState } from './preparing.state';
import { ReadyState } from './ready.state';
import { ServedState } from './served.state';

/**
 * ## The registry — the ONLY way to obtain an `OrderState`
 *
 * `OrderService` never constructs a state class directly; it calls
 * `orderStateFor(order.status)`. Two reasons that matters:
 *
 *   1. The lookup is exhaustive by construction. Adding a status to
 *      `ORDER_STATUSES` forces an entry here, and TypeScript fails the build if
 *      you forget — a new status cannot be a silent no-op that rejects every
 *      transition with "unknown status".
 *   2. A stored status that this build does not recognise (written by a newer
 *      deploy, or hand-edited) fails loudly at the boundary with a dedicated
 *      exception instead of quietly behaving like a state with no outgoing
 *      edges.
 *
 * Instances are stateless and immutable, so they are created fresh per lookup
 * and cached per process — there is no per-order state to keep in sync.
 */
const REGISTRY: Readonly<Record<string, () => OrderState>> = {
  placed: () => new PlacedState(),
  confirmed: () => new ConfirmedState(),
  preparing: () => new PreparingState(),
  ready: () => new ReadyState(),
  served: () => new ServedState(),
  awaiting_payment: () => new AwaitingPaymentState(),
  paid: () => new PaidState(),
  completed: () => new CompletedState(),
  cancelled: () => new CancelledState(),
};

const cache = new Map<string, OrderState>();

/**
 * Resolves the state object for a stored/requested status. Throws
 * `UnknownOrderStatusException` for anything outside the nine known values.
 */
export function orderStateFor(status: string): OrderState {
  const cached = cache.get(status);
  if (cached) {
    return cached;
  }
  if (!isOrderStatus(status)) {
    throw new UnknownOrderStatusException(status);
  }
  const state = REGISTRY[status]();
  cache.set(status, state);
  return state;
}
