import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `served` — handed to the guest (or the courier).
 *
 * The module brief calls out `served -> placed` as the transition that must be
 * structurally impossible; it is simply not in this table. The only ways out
 * are forward to `awaiting_payment`, or calling the order off before it is
 * paid for.
 */
export class ServedState extends CancellableOrderState {
  readonly status: OrderStatus = 'served';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['awaiting_payment'];
  }
}
