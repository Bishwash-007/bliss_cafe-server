import { fromCents, money, round2, sumMoney, toCents } from './staff.types';

describe('toCents / fromCents', () => {
  it('converts a money amount to whole cents', () => {
    expect(toCents(100)).toBe(10000);
    expect(toCents(12.35)).toBe(1235);
    expect(toCents(0)).toBe(0);
  });

  it('recovers the amount it converted', () => {
    for (const value of [0, 0.01, 7.5, 12.35, 99.99, 1000]) {
      expect(fromCents(toCents(value))).toBe(value);
    }
  });

  it('does not drift on amounts that a float multiply would miss', () => {
    // 12.35 * 100 is 1234.9999999999998 in binary floating point. Rounding the
    // cents is what recovers 12.35 rather than 12.34.
    expect(toCents(12.35)).toBe(1235);
    expect(toCents(0.07)).toBe(7);
    expect(toCents(29.99)).toBe(2999);
  });

  it('refuses a non-finite amount instead of producing NaN', () => {
    expect(() => toCents(Number.NaN)).toThrow(RangeError);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('sumMoney', () => {
  it('adds amounts exactly, without float drift', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point. A payroll
    // total that is wrong in the fourteenth decimal place is a total that does
    // not add up on a payslip.
    expect(sumMoney([0.1, 0.2])).toBe(0.3);
    expect(sumMoney([750, 250.5, 99.99])).toBe(1100.49);
  });

  it('is zero for an empty list', () => {
    expect(sumMoney([])).toBe(0);
  });
});

describe('money', () => {
  it('reads a Postgres NUMERIC string', () => {
    expect(money('100.00')).toBe(100);
    expect(money('12.35')).toBe(12.35);
  });

  it('reads a number', () => {
    expect(money(42)).toBe(42);
  });

  it('reads NULL as zero', () => {
    expect(money(null)).toBe(0);
    expect(money(undefined)).toBe(0);
  });
});

describe('round2', () => {
  it('rounds to two decimal places, half away from zero', () => {
    expect(round2(7.5)).toBe(7.5);
    expect(round2(7.983333333333333)).toBe(7.98);
    expect(round2(7.985)).toBe(7.99);
    expect(round2(-7.985)).toBe(-7.99);
  });

  it('refuses a non-finite value', () => {
    expect(() => round2(Number.NaN)).toThrow(RangeError);
  });
});
