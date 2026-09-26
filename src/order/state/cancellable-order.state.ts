import { AbstractOrderState, type OrderStatus } from './order-state';

/**
 * Shared rule for every status that can still be called off: "cancellable"
 * means the pre-payment states (plus `cancelled` as the no-op escape hatch for
 * read-only history).
 *
 * Factoring it here rather than repeating `['cancelled']` in seven classes is
 * the point of the pattern: the rule "you may cancel until money moves" is
 * stated ONCE. Adding a new pre-payment status cannot accidentally ship
 * without the cancel edge, and adding a post-payment status cannot
 * accidentally inherit one.
 */
export abstract class CancellableOrderState extends AbstractOrderState {
  /** The status-specific, forward-only edges. */
  protected abstract forwardTransitions(): readonly OrderStatus[];

  protected transitions(): readonly OrderStatus[] {
    return [...this.forwardTransitions(), 'cancelled'];
  }
}
