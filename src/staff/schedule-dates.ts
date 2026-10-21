import { InvalidDateRangeException } from './exceptions/staff.exceptions';

/**
 * Date handling for the staff module.
 *
 * Every function here is pure, and every one of them either returns a value the
 * caller can trust or throws `InvalidDateRangeException`. That matters more
 * than it looks: a misread date does not crash, it quietly produces a payroll
 * for the wrong days — a number that looks plausible and is wrong.
 */

/**
 * `YYYY-MM-DD`, the only date format accepted for a day.
 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An ISO-8601 instant WITH an explicit UTC offset.
 *
 * The offset is required on purpose. JavaScript parses `2026-10-21T09:00` as
 * LOCAL time and `2026-10-21` as UTC midnight, so accepting both would mean
 * two dates in the same request could be interpreted in two different
 * timezones — and the difference between them is hours, which is exactly the
 * scale a payroll error lives at.
 *
 * `Z` and `+05:30` are both accepted; a bare local time is not.
 */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * Milliseconds in a day.
 *
 * Exported so a caller that has to step back one day — turning an exclusive
 * period end back into the last day the period covers — uses the same constant
 * the period was built with, rather than writing the number out again.
 */
export const DAYS_IN_MILLISECONDS = MILLISECONDS_PER_DAY;

/**
 * Parses a `YYYY-MM-DD` day into the UTC midnight that starts it.
 *
 * The day is interpreted in UTC throughout the module. A roster week is a
 * range of instants, and pinning it to UTC means the same request produces
 * the same roster on a server in Kathmandu and on one in San Francisco — a
 * cafe that opens at 09:00 local has to agree with itself on which day
 * "Monday" was.
 *
 * The date is checked for realness: `2026-02-30` is a shape the regex
 * accepts and the calendar does not, and `Date.UTC` would quietly roll it
 * over to March 2nd. The round-trip comparison is what catches it.
 */
export function parseDateOnly(value: string, label = 'date'): Date {
  if (typeof value !== 'string' || !DATE_ONLY_RE.test(value)) {
    throw new InvalidDateRangeException(
      `${label} must be a date in YYYY-MM-DD format, but was '${value}'.`,
    );
  }
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new InvalidDateRangeException(
      `${label} '${value}' is not a real date.`,
    );
  }
  return date;
}

/**
 * Parses an ISO-8601 instant that carries an explicit UTC offset.
 *
 * See `ISO_INSTANT_RE` for why the offset is required.
 */
export function parseIsoInstant(value: string, label = 'instant'): Date {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) {
    throw new InvalidDateRangeException(
      `${label} must be an ISO-8601 instant with an explicit UTC offset ` +
        `(for example '2026-10-21T09:00:00Z' or '2026-10-21T09:00:00+05:30'), ` +
        `but was '${value}'.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidDateRangeException(
      `${label} '${value}' is not a real instant.`,
    );
  }
  return date;
}

/**
 * Formats a `Date` as the `YYYY-MM-DD` day it falls on, in UTC.
 */
export function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The Monday-to-Sunday week that contains a day.
 *
 * Weeks run Monday to Sunday because that is what a cafe roster runs on: a
 * week that starts on Sunday splits the weekend, and the people who work the
 * weekend are the same ones who work the start of the week.
 *
 * The bounds are half-open — `[monday, nextMonday)` — so a shift that starts
 * exactly when the next week begins belongs to the next week and no shift is
 * ever in two weeks at once.
 */
export function weekBounds(day: Date): {
  start: Date;
  end: Date;
  weekStart: string;
  weekEnd: string;
} {
  const start = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()),
  );
  // `getUTCDay()` is 0 for Sunday; the shift makes Monday 0 and Sunday 6.
  const daysSinceMonday = (start.getUTCDay() + 6) % 7;
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start.getTime() + 7 * MILLISECONDS_PER_DAY);
  return {
    start,
    end,
    weekStart: formatDateOnly(start),
    weekEnd: formatDateOnly(new Date(end.getTime() - MILLISECONDS_PER_DAY)),
  };
}

/**
 * The instant range a pay period covers.
 *
 * The range is `[from, to + 1 day)` — half-open, and inclusive of the last
 * day. `from` and `to` are the first and last DAYS of the period, so a
 * single-day period from `2026-10-21` to `2026-10-21` covers exactly that
 * day and nothing else.
 *
 * The end is exclusive so that a record clocked in at the very last instant
 * of a day belongs to that day and not to the next one. With an inclusive end
 * the midnight of the following day would be counted in both periods, and two
 * adjacent pay runs would pay for the same hour twice.
 */
export function periodBounds(
  from: string,
  to: string,
): {
  from: Date;
  to: Date;
} {
  const start = parseDateOnly(from, 'from');
  const lastDay = parseDateOnly(to, 'to');
  if (lastDay.getTime() < start.getTime()) {
    throw new InvalidDateRangeException(
      `'to' (${to}) must not be before 'from' (${from}).`,
    );
  }
  return {
    from: start,
    to: new Date(lastDay.getTime() + MILLISECONDS_PER_DAY),
  };
}

/**
 * How long a period is, in whole days.
 *
 * A guard against a period that is absurdly large — a request for ten years
 * of payroll would scan every attendance record the tenant has ever written.
 */
export const MAX_PERIOD_DAYS = 366;

export function periodLengthInDays(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / MILLISECONDS_PER_DAY);
}
