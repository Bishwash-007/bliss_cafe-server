import { Injectable } from '@nestjs/common';
import { minutesBetween, MINUTES_PER_HOUR } from '../hours';
import { fromCents, toCents, type AttendanceRecord } from '../staff.types';
import type { WageCalculationStrategy } from './wage-calculation.strategy';

/**
 * # HourlyWageStrategy
 *
 * Hours worked times the hourly rate. The only strategy implemented today, and
 * the reference for the ones that will follow.
 *
 * ## The arithmetic is done in whole cents
 *
 * The obvious implementation is `((clockOut - clockIn) / 3_600_000) * rate`, and
 * it is wrong in a way that is very hard to see. Subtracting two timestamps
 * gives a whole number of milliseconds, and dividing by 3 600 000 gives a
 * fraction like 7.499999999999999. Multiply that by an hourly rate and the
 * result is 749.9999999999999 — which rounds to 750.00, so the error hides
 * until the rate is one that does not round cleanly, and then a 7.5-hour shift
 * is paid as 7.49 hours.
 *
 * So the calculation happens in two whole-number steps:
 *
 *   minutes  = whole minutes worked          (an integer)
 *   cents    = minutes * rateCents / 60       (an integer, rounded once)
 *
 * 450 minutes is 7.5 hours exactly, and 450 minutes at 100 an hour is 45000
 * cents, which is 750.00 exactly. No binary floating point is involved at
 * any point, so the answer is the same on every machine and in every
 * language.
 *
 * ## What is counted
 *
 * Only records with a clock-out. A record still open is a period that has not
 * ended, and paying for it would mean paying for time that has not happened.
 * The payroll service reports how many records are open, so the gap is visible
 * rather than silent.
 */
@Injectable()
export class HourlyWageStrategy implements WageCalculationStrategy {
  readonly name = 'hourly';

  /**
   * An integer division, rounded half away from zero.
   *
   * The divisor is 60 — whole minutes in an hour — so half a cent is exactly
   * representable and the rounding is a plain `Math.floor` of the shifted
   * numerator.
   */
  private static centsFor(minutes: number, rateCents: number): number {
    const numerator = minutes * rateCents;
    const sign = numerator < 0 ? -1 : 1;
    const absolute = Math.abs(numerator);
    return (
      sign * Math.floor((absolute + MINUTES_PER_HOUR / 2) / MINUTES_PER_HOUR)
    );
  }

  calculate(
    attendanceRecords: readonly AttendanceRecord[],
    rate: number,
  ): number {
    const minutes = attendanceRecords.reduce((total, record) => {
      if (record.clockOut === null) {
        return total;
      }
      return total + minutesBetween(record.clockIn, record.clockOut);
    }, 0);

    return fromCents(HourlyWageStrategy.centsFor(minutes, toCents(rate)));
  }
}
