import type { PricedMenuItem } from './priced-menu-item';

/**
 * The UNDECORATED starting figure: `menu_items.price`. Callers that want a bare
 * item (no modifiers applied) read exactly this. Every `ModifierDecorator` in
 * the chain wraps an instance of this (or another decorator), so the chain
 * ALWAYS terminates at the real base row price.
 */
export class BasePricedMenuItem implements PricedMenuItem {
  readonly basePrice: number;

  /** Undecorated, so `basePrice === price` for a bare item. */
  readonly price: number;

  constructor(basePrice: number) {
    this.basePrice = basePrice;
    this.price = basePrice;
  }

  getPrice(): number {
    return this.price;
  }
}
