import {
  isStockMovementType,
  quantity,
  roundQuantity,
  toNumeric,
  STOCK_MOVEMENT_TYPES,
} from './inventory.types';

describe('roundQuantity', () => {
  it('leaves an already-exact value alone', () => {
    expect(roundQuantity(2)).toBe(2);
    expect(roundQuantity(2.5)).toBe(2.5);
  });

  it('rounds to the NUMERIC(12,3) grid the columns use', () => {
    expect(roundQuantity(1.2345)).toBe(1.235);
    expect(roundQuantity(0.0005)).toBe(0.001);
  });

  it('rounds half AWAY from zero on both signs', () => {
    // `Math.round(-0.5)` is -0, which would silently turn a -0.5 correction into
    // no correction at all. A stocktake that came up 0.5 kg short must move.
    expect(roundQuantity(0.5)).toBe(0.5);
    expect(roundQuantity(-0.5)).toBe(-0.5);
    expect(roundQuantity(-1.2345)).toBe(-1.235);
    expect(Object.is(roundQuantity(-0.001), -0.001)).toBe(true);
  });

  it('fixes the float error that decimal arithmetic would otherwise leak in', () => {
    // 0.1 * 3 === 0.30000000000000004 in binary floating point. The database would
    // round that to 0.300, but only by luck; the point is the value is corrected
    // here, once, at the boundary.
    expect(0.1 * 3).not.toBe(0.3);
    expect(roundQuantity(0.1 * 3)).toBe(0.3);
    expect(roundQuantity(0.07 * 3)).toBe(0.21);
    expect(roundQuantity(1.1 * 3)).toBe(3.3);
  });

  it('rejects a non-finite quantity instead of writing NaN to a NUMERIC column', () => {
    // Postgres would reject this, but the error would name the column rather than
    // the arithmetic that produced it.
    expect(() => roundQuantity(NaN)).toThrow(RangeError);
    expect(() => roundQuantity(Infinity)).toThrow(RangeError);
  });
});

describe('quantity (Postgres NUMERIC -> number)', () => {
  it('parses the strings that pg returns for NUMERIC columns', () => {
    // pg hands NUMERIC back as a string because it cannot know the value fits a
    // JS number. Trusting it to return numbers is a silent-corruption bug.
    expect(quantity('12.500')).toBe(12.5);
    expect(quantity('0')).toBe(0);
  });

  it('treats a null column as zero rather than NaN', () => {
    expect(quantity(null)).toBe(0);
    expect(quantity(undefined)).toBe(0);
  });

  it('accepts a number that was already converted', () => {
    expect(quantity(3.5)).toBe(3.5);
  });
});

describe('toNumeric', () => {
  it('is the explicit write-side counterpart to quantity()', () => {
    expect(toNumeric(1.23456)).toBe(1.235);
  });
});

describe('isStockMovementType', () => {
  it('accepts every type the schema check constraint allows', () => {
    for (const type of STOCK_MOVEMENT_TYPES) {
      expect(isStockMovementType(type)).toBe(true);
    }
  });

  it('rejects anything else, so an unknown type is caught before the database', () => {
    // The column has a CHECK, so this would fail anyway — but as a constraint
    // violation with no clue which value was wrong.
    expect(isStockMovementType('steal')).toBe(false);
    expect(isStockMovementType('')).toBe(false);
    expect(isStockMovementType(42)).toBe(false);
    expect(isStockMovementType(null)).toBe(false);
  });
});
