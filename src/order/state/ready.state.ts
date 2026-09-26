import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `ready` — plated and waiting for handover.
 *
 * For a takeaway/delivery order this is where it waits for the courier, so this
 * state can legitimately sit open for a long time; that is a business fact, not
 * a reason to add a "skip to served" edge.
 */
export class ReadyState extends CancellableOrderState {
  readonly status: OrderStatus = 'ready';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['served'];
  }
}
