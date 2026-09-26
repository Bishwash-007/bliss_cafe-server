import { AbstractOrderState } from './order-state';
import type { OrderStatus } from './order-state';

/**
 * `paid` — the provider has confirmed settlement.
 *
 * This status is NOT cancellable, and that asymmetry with every earlier state
 * is deliberate. Before `paid`, cancelling is a free business decision; after
 * `paid`, taking the order back would mean taking back money, which is a
 * refund (PaymentModule) and must leave an auditable record. Extending
 * `AbstractOrderState` rather than `CancellableOrderState` is how that
 * guarantee is expressed — there is no `cancelled` edge to inherit.
 *
 * The only way out is `completed` (goods handed over, till reconciled).
 */
export class PaidState extends AbstractOrderState {
  readonly status: OrderStatus = 'paid';

  protected transitions(): readonly OrderStatus[] {
    return ['completed'];
  }
}
