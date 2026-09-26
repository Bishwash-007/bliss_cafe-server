import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `placed` — the order exists and is visible on the KDS, but no one has
 * accepted it yet.
 *
 * The single forward edge is `confirmed`: a waiter/cashier (or the kitchen)
 * acknowledging the ticket. Everything else, including going back to `placed`,
 * is absent from the table and therefore unwritable.
 */
export class PlacedState extends CancellableOrderState {
  readonly status: OrderStatus = 'placed';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['confirmed'];
  }
}
