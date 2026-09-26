import type { PricedMenuItem } from './priced-menu-item';

/**
 * The Decorator half of the pricing story. Wraps a `PricedMenuItem` (the base,
 * or another `ModifierDecorator`) and STACKS one modifier variant's
 * `extra_price` onto whatever it wraps.
 *
 * Stacking works because each wrapper re-exposes `getPrice()` as
 * `wrapped.getPrice() + this.extraPrice`: wrapping the same base item N times
 * (once per modifier) yields `base + Σ extra_price` — "Large, oat milk, extra
 * shot" needs no combinatorial schema columns, just three small wrappers.
 */
export class ModifierDecorator implements PricedMenuItem {
  /**
   * Carried through UNCHANGED from the innermost base, so any layer of the
   * chain can still report the undecorated menu row price.
   */
  readonly basePrice: number;

  /** Wrapped total + this modifier's `extra_price`. */
  readonly price: number;

  constructor(
    private readonly item: PricedMenuItem,
    private readonly extraPrice: number,
    private readonly label = 'modifier',
  ) {
    this.basePrice = item.basePrice;
    this.price = item.getPrice() + extraPrice;
  }

  getPrice(): number {
    return this.price;
  }

  get labelName(): string {
    return this.label;
  }
}
