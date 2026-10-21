/**
 * Money arithmetic for the payment module.
 *
 * Same whole-cents grid as the staff and CRM modules. It is duplicated here
 * rather than imported across feature boundaries: a gateway adapter has no
 * business depending on payroll or promotions, and three copies of two
 * functions are cheaper than a feature module becoming a shared utility that
 * three others must not break.
 *
 * Gateway APIs take minor units (Stripe `amount` in cents, Razorpay
 * `payment_amount` in paise), so this is not a rounding nicety — it is the
 * representation.
 */

const HUNDRED = 100;

/** A money amount in whole cents/paise. */
export function toMinorUnits(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot convert a non-finite amount: ${value}`);
  }
  return Math.round(value * HUNDRED);
}

/** Minor units back to a money amount. */
export function fromMinorUnits(minor: number): number {
  return minor / HUNDRED;
}

/** Rounds to 2 decimal places, half away from zero. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * HUNDRED)) / HUNDRED;
}

/** Reads a Postgres `NUMERIC` (string) as a money number. */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return fromMinorUnits(toMinorUnits(Number(value)));
}
