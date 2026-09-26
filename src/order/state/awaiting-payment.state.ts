import { CancellableOrderState } from './cancellable-order.state';
import type { OrderStatus } from './order-state';

/**
 * `awaiting_payment` — the guest has the bill / a dynamic QR is showing, and
 * the payment provider has not confirmed anything yet.
 *
 * Per the system design (§2.6) every checkout parks the order here — including
 * cash and card — and only a provider webhook (PaymentModule, module 9) moves
 * it to `paid`. That keeps "the order says paid" and "the money arrived" the
 * same statement, instead of a client being able to assert the latter.
 */
export class AwaitingPaymentState extends CancellableOrderState {
  readonly status: OrderStatus = 'awaiting_payment';

  protected forwardTransitions(): readonly OrderStatus[] {
    return ['paid'];
  }
}
