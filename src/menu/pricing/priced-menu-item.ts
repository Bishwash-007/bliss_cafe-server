/**
 * Decorator: stack purchasable "modifiers" (size, sugar level, add-ons) onto a
 * base menu item without the base item knowing about any specific combination.
 *
 * A single modifier variant (e.g. "Large", "+50% sugar") carries an
 * `extra_price`; wrapping the base item's price with one `ModifierDecorator`
 * per modifier yields `base + Σ extra_price`. Decorators compose by wrapping
 * the SAME base over and over, so "Large, oat milk, extra shot" is just
 * `ModifierDecorator(ModifierDecorator(ModifierDecorator(base, shot), oat),
 * large)` — no combinatorial schema rows required.
 */
export interface PricedMenuItem {
  /** Base `menu_items.price` figure BEFORE any modifier was stacked. */
  basePrice: number;
  /** "Decorated" total: base + every stacked modifier's extra price. */
  price: number;
  getPrice(): number;
}
