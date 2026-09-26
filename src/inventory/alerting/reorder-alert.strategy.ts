import type { InventoryItem } from '../inventory.types';

/**
 * # Reorder alerting — the Strategy seam
 *
 * "Is this item low?" is the one question in inventory whose answer legitimately
 * differs per item. A perishable dairy item needs a generous safety margin long
 * before a shelf-stable syrup does, and later a predictive strategy may want to
 * compare the current level against the branch's recent consumption rate rather
 * than a fixed number.
 *
 * Every one of those is a different ANSWER to the same QUESTION. That is what
 * Strategy is for, and it is why the question is asked here — behind one
 * interface — instead of being open-coded at the call sites. Adding
 * `PredictiveAlertStrategy` later is a new class plus a provider entry; no
 * deduction, movement or controller code changes.
 *
 * The interface takes a whole item rather than a quantity so a strategy can use
 * whatever it needs (`unit`, `name`, and in future a consumption rate) without
 * the signature changing.
 */
export interface ReorderAlertStrategy {
  /**
   * Stable identifier used for tenant configuration and logging. Changing a
   * strategy's logic must NOT change its name: a tenant's saved choice has to
   * keep resolving.
   */
  readonly name: string;

  /**
   * True when the item should raise a reorder alert.
   *
   * Called only with an item the caller has just read, so implementations must be
   * pure and synchronous — no I/O, no clock, no randomness.
   */
  shouldAlert(item: InventoryItem): boolean;
}
