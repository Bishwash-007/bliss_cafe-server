import type { AttendanceRecord } from '../staff.types';
import { HourlyWageStrategy } from './hourly-wage.strategy';

const TENANT = 'tenant-1';

/**
 * An attendance record from `clockIn` to `clockOut`.
 *
 * `clockOut` is null for a record that is still open — a period that has not
 * ended, and so is not payable yet.
 */
function record(clockIn: string, clockOut: string | null): AttendanceRecord {
  return {
    id: `attendance-${clockIn}-${clockOut ?? 'open'}`,
    tenantId: TENANT,
    shiftId: 'shift-1',
    clockIn: new Date(clockIn),
    clockOut: clockOut === null ? null : new Date(clockOut),
  };
}

/**
 * The wage a correct implementation must produce, computed with INTEGERS.
 *
 * The wage in cents is `minutes * rateCents / 60`, and rounding that to the
 * nearest cent, half away from zero, is `floor((minutes * rateCents + 30) /
 * 60)`.
 *
 * Computing the expectation this way — rather than with the same floating
 * point arithmetic the implementation uses — is the point. An expectation
 * computed the same way as the code proves nothing, because both would be
 * wrong in the same direction.
 */
function expectedWage(minutes: number, rate: number): number {
  const rateCents = Math.round(rate * 100);
  const cents = Math.floor((minutes * rateCents + 30) / 60);
  return cents / 100;
}

describe('HourlyWageStrategy', () => {
  const strategy = new HourlyWageStrategy();

  it('is named after the pay type it implements', () => {
    expect(strategy.name).toBe('hourly');
  });

  it('pays nothing for no records', () => {
    expect(strategy.calculate([], 100)).toBe(0);
  });

  it('pays a whole day at the hourly rate', () => {
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T17:00:00Z')];
    expect(strategy.calculate(records, 25)).toBe(200);
  });

  it('pays a partial-hour shift at the exact fraction of an hour', () => {
    // 09:00 to 16:30 is 7.5 hours. At 100 an hour that is 750 exactly.
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T16:30:00Z')];
    expect(strategy.calculate(records, 100)).toBe(750);
  });

  it('does not round a partial-hour shift up to a whole hour', () => {
    // 7.5 hours at 100 is 750. Rounding the hours to 8 would pay 800.
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T16:30:00Z')];
    expect(strategy.calculate(records, 100)).not.toBe(800);
  });

  it('sums several shifts', () => {
    const records = [
      record('2026-10-21T09:00:00Z', '2026-10-21T12:00:00Z'), // 3 hours
      record('2026-10-21T13:00:00Z', '2026-10-21T17:00:00Z'), // 4 hours
    ];
    expect(strategy.calculate(records, 50)).toBe(350);
  });

  it('ignores a record that is still open', () => {
    const records = [
      record('2026-10-21T09:00:00Z', '2026-10-21T17:00:00Z'),
      record('2026-10-21T18:00:00Z', null),
    ];
    expect(strategy.calculate(records, 25)).toBe(200);
  });

  it('pays nothing at all when every record is still open', () => {
    const records = [record('2026-10-21T18:00:00Z', null)];
    expect(strategy.calculate(records, 25)).toBe(0);
  });

  it('truncates a shift to whole minutes rather than rounding up', () => {
    // 7h 59m 40s is 479 whole minutes, so it is paid as 479 minutes and not
    // rounded up to 480. Paying for time that was not worked is the direction
    // an employer cannot afford.
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T16:59:40Z')];
    const minutes = 479;
    expect(strategy.calculate(records, 60)).toBe(expectedWage(minutes, 60));
  });

  it('pays a zero rate as zero', () => {
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T17:00:00Z')];
    expect(strategy.calculate(records, 0)).toBe(0);
  });

  it('always returns a finite number', () => {
    const records = [record('2026-10-21T09:00:00Z', '2026-10-21T17:00:00Z')];
    for (const rate of [0, 12.345, 99.99, 1000]) {
      expect(Number.isFinite(strategy.calculate(records, rate))).toBe(true);
    }
  });

  it('agrees with an exact integer calculation for every partial hour', () => {
    // The property that matters: a shift of any number of minutes is paid
    // exactly `minutes/60` of the rate, rounded to the cent, with no drift
    // from the floating point arithmetic and no rounding of the hours.
    const rates = [7.5, 12.345, 25, 33.33, 99.99, 100];
    const minuteCounts = [1, 7, 15, 59, 60, 61, 225, 450, 451, 479, 720];

    for (const rate of rates) {
      for (const minutes of minuteCounts) {
        const start = new Date('2026-10-21T09:00:00Z');
        const end = new Date(start.getTime() + minutes * 60_000);
        const records = [record(start.toISOString(), end.toISOString())];
        expect(strategy.calculate(records, rate)).toBe(
          expectedWage(minutes, rate),
        );
      }
    }
  });

  it('treats a clock-out before the clock-in as zero minutes', () => {
    // The service refuses this, and the database has a CHECK for it, but the
    // strategy must not pay a negative wage if such a record ever arrives.
    const records = [record('2026-10-21T17:00:00Z', '2026-10-21T09:00:00Z')];
    expect(strategy.calculate(records, 100)).toBe(0);
  });
});
