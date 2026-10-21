/**
 * Calendar-day helpers for birthdays.
 *
 * A birthday is a DAY, not an instant. Passing `1994-04-12` through
 * `new Date(...)` would turn it into midnight in the server's zone and make the
 * stored value depend on where the process runs, so the string components are
 * validated directly and the database column is `DATE`.
 */

const CALENDAR_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Returns the day in `YYYY-MM-DD` form when it is a real calendar day, or null
 * for anything else (including `1994-02-31`, which JavaScript would roll into
 * March).
 */
export function parseCalendarDay(value: string): string | null {
  const match = CALENDAR_DAY_RE.exec(value);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

/**
 * The UTC calendar day of an instant.
 *
 * Used for "today" until tenants have a timezone. The campaign endpoint accepts
 * an explicit day so a scheduler in a local zone can override this without any
 * other code changing.
 */
export function utcCalendarDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}
