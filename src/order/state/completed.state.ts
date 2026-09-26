import { AbstractOrderState } from './order-state';
import type { OrderStatus } from './order-state';

/**
 * `completed` — TERMINAL. The order is closed history; the table it occupied is
 * released and reporting treats it as settled revenue.
 *
 * No outgoing edges, on purpose. Nothing (a stale mobile client replaying an
 * offline action queue, a double-submitted button press) can reopen a closed
 * order; a correction is a new order.
 */
export class CompletedState extends AbstractOrderState {
  readonly status: OrderStatus = 'completed';

  protected transitions(): readonly OrderStatus[] {
    return [];
  }
}
