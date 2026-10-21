import { BadRequestException } from '@nestjs/common';
import type { DateRange, ResolvedDateRange } from './reporting.types';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parses one inclusive calendar date as a UTC midnight instant.
 *
 * Calendar dates are used rather than arbitrary timestamps because a report is
 * about "10 January", not about an instant that means different days in
 * different branches. UTC is the common grid: branch time zones are not part
 * of the reporting contract yet, and pretending they are would make the same
 * date range produce different answers depending on the caller.
 */
export function parseCalendarDate(value: string, field: string): Date {
  const match = DATE_RE.exec(value);
  if (!match) {
    throw new BadRequestException(
      `${field} must be a calendar date in YYYY-MM-DD form`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  // Reject dates that JavaScript silently normalises, e.g. 2026-02-31.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new BadRequestException(`${field} is not a real calendar date`);
  }

  return date;
}

/**
 * Validates an inclusive `[from, to]` range and turns it into the half-open
 * instant range `[from 00:00, to + 1 day 00:00)` used by every query.
 */
export function resolveDateRange(range: DateRange): ResolvedDateRange {
  const fromInstant = parseCalendarDate(range.from, 'from');
  const toInstant = parseCalendarDate(range.to, 'to');

  if (fromInstant.getTime() > toInstant.getTime()) {
    throw new BadRequestException('from must be on or before to');
  }

  return {
    from: range.from,
    to: range.to,
    fromInstant,
    toInstant: new Date(toInstant.getTime() + 24 * 60 * 60 * 1000),
  };
}

/** True when a string is a UUID. Report paths take opaque ids from callers. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  );
}
