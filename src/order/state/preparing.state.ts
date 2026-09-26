import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `preparing` — items are on the pass / in the fryer.
 *
 * `cancelled` here is the "guest walked out mid-cook" case, which is why the
 * cancellation edge exists on this status in particular.
 */
export class PreparingState extends CancellableOrderState {
  readonly status: OrderStatus = 'preparing';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['ready'];
  }
}
