import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `confirmed` — the ticket has been accepted and is queued for the kitchen.
 *
 * Only `preparing` follows. `placed` is not reachable: re-acknowledging a
 * ticket is a no-op, not a transition, and silently modelling it as one would
 * let a client ping-pong an order between two statuses to generate arbitrary
 * `order.status_changed` events downstream.
 */
export class ConfirmedState extends CancellableOrderState {
  readonly status: OrderStatus = 'confirmed';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['preparing'];
  }
}
