import { FlatDiscountStrategy } from './flat-discount.strategy';
import { PercentageDiscountStrategy } from './percentage-discount.strategy';

describe('PercentageDiscountStrategy', () => {
  it('takes the stated percentage of the subtotal', () => {
    const strategy = new PercentageDiscountStrategy(10);

    expect(strategy.discountType).toBe('percentage');
    expect(strategy.apply(100)).toBe(10);
    expect(strategy.apply(250.5)).toBe(25.05);
  });

  it('handles a fractional percentage exactly', () => {
    // 12.5% of 99.99 is 12.49875, which must land on a whole cent.
    expect(new PercentageDiscountStrategy(12.5).apply(99.99)).toBe(12.5);
  });

  it('rounds to the nearest cent, not to the nearest unit', () => {
    // 33.33% of 10.00 is 3.333; a money amount cannot carry the third decimal.
    expect(new PercentageDiscountStrategy(33.33).apply(10)).toBe(3.33);
  });

  it('never discounts more than the subtotal', () => {
    expect(new PercentageDiscountStrategy(100).apply(42.42)).toBe(42.42);
    // A legacy row with an out-of-range value is clamped rather than turning
    // the bill into a credit.
    expect(new PercentageDiscountStrategy(150).apply(42.42)).toBe(42.42);
  });

  it('never returns a negative discount', () => {
    const strategy = new PercentageDiscountStrategy(-10);

    expect(strategy.apply(42.42)).toBe(0);
    expect(strategy.apply(0)).toBe(0);
    expect(strategy.apply(-5)).toBe(0);
  });
});

describe('FlatDiscountStrategy', () => {
  it('takes a fixed amount off', () => {
    const strategy = new FlatDiscountStrategy(5);

    expect(strategy.discountType).toBe('flat');
    expect(strategy.apply(20)).toBe(5);
    expect(strategy.apply(20.5)).toBe(5);
  });

  it('never discounts a bill below zero', () => {
    // A 5.00 promotion on a 3.00 coffee takes 3.00 off, not 5.00.
    expect(new FlatDiscountStrategy(5).apply(3)).toBe(3);
    expect(new FlatDiscountStrategy(5).apply(5)).toBe(5);
  });

  it('never returns a negative discount for a negative amount', () => {
    expect(new FlatDiscountStrategy(-5).apply(20)).toBe(0);
  });

  it('is zero for a zero subtotal', () => {
    expect(new FlatDiscountStrategy(5).apply(0)).toBe(0);
  });
});
