import { BasePricedMenuItem } from './base-priced-menu-item';
import { ModifierDecorator } from './modifier.decorator';
import type { PricedMenuItem } from './priced-menu-item';

describe('menu pricing (Decorator)', () => {
  describe('BasePricedMenuItem', () => {
    it('returns the raw menu row price', () => {
      expect(new BasePricedMenuItem(3.5).getPrice()).toBe(3.5);
    });

    it('reports basePrice === price for an undecorated item', () => {
      const base = new BasePricedMenuItem(3.5);

      expect(base.basePrice).toBe(3.5);
      expect(base.price).toBe(3.5);
    });
  });

  describe('ModifierDecorator stacking', () => {
    it('adds a single modifier onto the base', () => {
      const priced = new ModifierDecorator(new BasePricedMenuItem(3.5), 0.75);

      expect(priced.getPrice()).toBeCloseTo(4.25, 2);
    });

    it('sums three stacked modifiers onto one base', () => {
      // "Large, oat milk, extra shot" — no combinatorial variant rows.
      const priced = new ModifierDecorator(
        new ModifierDecorator(
          new ModifierDecorator(new BasePricedMenuItem(3.5), 0.4), // extra shot
          0.6, // oat milk
        ),
        0.75, // large
      );

      expect(priced.getPrice()).toBeCloseTo(5.25, 2);
    });

    it('is order-independent for the total', () => {
      const forwards = new ModifierDecorator(
        new ModifierDecorator(new BasePricedMenuItem(10), 1),
        2,
      );
      const backwards = new ModifierDecorator(
        new ModifierDecorator(new BasePricedMenuItem(10), 2),
        1,
      );

      expect(forwards.getPrice()).toBe(backwards.getPrice());
      expect(forwards.getPrice()).toBe(13);
    });

    it('propagates the UNDECORATED basePrice through every layer', () => {
      const priced = new ModifierDecorator(
        new ModifierDecorator(new BasePricedMenuItem(3.5), 0.6),
        0.75,
      );

      expect(priced.basePrice).toBe(3.5);
      expect(priced.price).toBeCloseTo(4.85, 2);
    });

    it('treats a zero-extra modifier as a no-op on the total', () => {
      const priced = new ModifierDecorator(new BasePricedMenuItem(3.5), 0);

      expect(priced.getPrice()).toBe(3.5);
    });

    it('exposes the modifier label for the rendered output', () => {
      const priced = new ModifierDecorator(
        new BasePricedMenuItem(3.5),
        0.75,
        'Large',
      );

      expect(priced.labelName).toBe('Large');
    });

    it('defaults the label when none is supplied', () => {
      expect(
        new ModifierDecorator(new BasePricedMenuItem(1), 1).labelName,
      ).toBe('modifier');
    });

    it('stays assignable to PricedMenuItem so it can decorate further', () => {
      const asInterface: PricedMenuItem = new BasePricedMenuItem(2);

      expect(asInterface).toBeInstanceOf(BasePricedMenuItem);
    });
  });
});
