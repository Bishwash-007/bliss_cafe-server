/**
 * Money arithmetic for the CRM module.
 *
 * Deliberately the same grid as `src/staff/staff.types.ts`: whole cents, with
 * the conversion happening once. The two modules are independent features, so
 * this is a 20-line duplicate rather than a cross-feature import — a CRM
 * discount calculation has no business reaching into the payroll module, and
 * importing it would make either module's schema change the other's problem.
 *
 * The reason cents matter here is the same as there: `250.50 * 12.5 / 100` is
 * `31.312500000000004` in binary floating point, and a discount that is a
 * fraction of a cent is a receipt that does not add up.
 */

const HUNDRED = 100;

/** A money amount in whole cents. */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `Cannot convert a non-finite amount to cents: ${value}`,
    );
  }
  return Math.round(value * HUNDRED);
}

/** Whole cents back to a money amount. */
export function fromCents(cents: number): number {
  return cents / HUNDRED;
}

/** Rounds to 2 decimal places, half away from zero. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * HUNDRED)) / HUNDRED;
}

/**
 * Reads a Postgres `NUMERIC` (string) as a number of money.
 *
 * Read through the cents grid so a value stored as `12.50` is 12.5 and not
 * 12.500000000000002.
 */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return fromCents(toCents(Number(value)));
}
