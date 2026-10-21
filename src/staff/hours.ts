/**
 * Working-time arithmetic, shared by the payroll strategy and the roster.
 *
 * The arithmetic is done in whole MINUTES, and the reason is not tidiness.
 *
 * Subtracting two timestamps gives a whole number of milliseconds, and
 * dividing that by the number of milliseconds in an hour gives a fraction like
 * 7.499999999999999. Multiply that by an hourly rate and the result is
 * 749.9999999999999, which rounds to 750.00 — so the error hides until the
 * rate is one that does not round cleanly, and then a 7.5-hour shift is paid
 * as 7.49 hours. Minutes are whole numbers, so the division happens exactly
 * once, at the end: 450 minutes is 7.5 hours exactly.
 */

/**
 * Minutes in an hour.
 */
export const MINUTES_PER_HOUR = 60;

/**
 * Milliseconds in a minute.
 */
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Whole minutes between two instants.
 *
 * Truncated, never rounded: rounding would pay for time that was not worked
 * (a shift of 7h 59m 40s would become 8 whole hours). The cost is that
 * somebody who worked 59 seconds over the hour is paid for 0 minutes — which
 * is the direction an employer can live with, and the direction a payroll
 * dispute is not likely to be about.
 *
 * A negative or zero span is 0 minutes. The service refuses a clock-out
 * before a clock-in, and the database has a CHECK for it, but clamping here
 * means a record that somehow arrived malformed contributes nothing rather
 * than a negative wage.
 */
export function minutesBetween(from: Date, to: Date): number {
  const milliseconds = to.getTime() - from.getTime();
  if (milliseconds <= 0) {
    return 0;
  }
  return Math.floor(milliseconds / MILLISECONDS_PER_MINUTE);
}

/**
 * Hours between two instants, truncated to whole minutes.
 *
 * Kept as a fraction of an hour rather than a rounded number of hours: a
 * 7.5-hour shift must read as 7.5 hours, not as 8, and rounding it here
 * would be exactly the bug the acceptance criterion names.
 */
export function hoursBetween(from: Date, to: Date): number {
  return minutesBetween(from, to) / MINUTES_PER_HOUR;
}
