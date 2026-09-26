import { AbstractOrderState } from './order-state';
import type { OrderStatus } from './order-state';

/**
 * `cancelled` — TERMINAL. The order never happened (or was called off before
 * payment).
 *
 * Like `completed`, it has no outgoing edges — reviving a cancelled ticket
 * would re-trigger every downstream subscriber (inventory deduction,
 * notifications, KDS) for work they already performed or already abandoned.
 */
export class CancelledState extends AbstractOrderState {
  readonly status: OrderStatus = 'cancelled';

  protected transitions(): readonly OrderStatus[] {
    return [];
  }
}
