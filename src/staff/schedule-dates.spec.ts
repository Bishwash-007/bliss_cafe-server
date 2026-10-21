import { InvalidDateRangeException } from './exceptions/staff.exceptions';
import {
  formatDateOnly,
  parseDateOnly,
  parseIsoInstant,
  periodBounds,
  periodLengthInDays,
  weekBounds,
} from './schedule-dates';

describe('parseDateOnly', () => {
  it('reads a date as UTC midnight', () => {
    const date = parseDateOnly('2026-10-21');

    expect(date.toISOString()).toBe('2026-10-21T00:00:00.000Z');
  });

  it('rejects a date that is not in YYYY-MM-DD', () => {
    expect(() => parseDateOnly('21/10/2026')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('rejects a date with a time on it', () => {
    expect(() => parseDateOnly('2026-10-21T09:00:00Z')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('rejects a day that does not exist', () => {
    // The shape is right and the calendar is wrong. `Date.UTC` would roll it
    // over to the 2nd of March and the caller would never know.
    expect(() => parseDateOnly('2026-02-30')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('rejects a month that does not exist', () => {
    expect(() => parseDateOnly('2026-13-01')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('accepts a leap day in a leap year', () => {
    expect(parseDateOnly('2028-02-29').toISOString()).toBe(
      '2028-02-29T00:00:00.000Z',
    );
  });

  it('rejects a leap day in a common year', () => {
    expect(() => parseDateOnly('2026-02-29')).toThrow(
      InvalidDateRangeException,
    );
  });
});

describe('parseIsoInstant', () => {
  it('reads an instant with a Z offset', () => {
    expect(parseIsoInstant('2026-10-21T09:00:00Z').toISOString()).toBe(
      '2026-10-21T09:00:00.000Z',
    );
  });

  it('reads an instant with a numeric offset', () => {
    expect(parseIsoInstant('2026-10-21T09:00:00+05:30').toISOString()).toBe(
      '2026-10-21T03:30:00.000Z',
    );
  });

  it('rejects an instant with no offset', () => {
    // JavaScript would read this as LOCAL time, and `2026-10-21` as UTC
    // midnight — two dates in one request in two timezones.
    expect(() => parseIsoInstant('2026-10-21T09:00:00')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('rejects a date on its own', () => {
    expect(() => parseIsoInstant('2026-10-21')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('rejects nonsense', () => {
    expect(() => parseIsoInstant('tomorrow')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('names the field that was wrong', () => {
    expect(() => parseIsoInstant('nope', 'startTime')).toThrow(/startTime/);
  });
});

describe('formatDateOnly', () => {
  it('writes the UTC day', () => {
    expect(formatDateOnly(new Date('2026-10-21T23:59:59Z'))).toBe('2026-10-21');
  });
});

describe('weekBounds', () => {
  it('starts the week on Monday', () => {
    // A Wednesday belongs to the week that began on the Monday before it.
    const bounds = weekBounds(parseDateOnly('2026-10-21'));

    expect(bounds.weekStart).toBe('2026-10-19');
    expect(bounds.weekEnd).toBe('2026-10-25');
  });

  it('puts a Monday in its own week', () => {
    const bounds = weekBounds(parseDateOnly('2026-10-19'));

    expect(bounds.weekStart).toBe('2026-10-19');
    expect(bounds.weekEnd).toBe('2026-10-25');
  });

  it('puts a Sunday in the week that began six days earlier', () => {
    // Not the week starting the NEXT day: a week that starts on Sunday splits
    // the weekend, and the people who work the weekend are the same ones who
    // work the start of the week.
    const bounds = weekBounds(parseDateOnly('2026-10-25'));

    expect(bounds.weekStart).toBe('2026-10-19');
    expect(bounds.weekEnd).toBe('2026-10-25');
  });

  it('covers exactly seven days', () => {
    const bounds = weekBounds(parseDateOnly('2026-10-21'));

    expect((bounds.end.getTime() - bounds.start.getTime()) / 86_400_000).toBe(
      7,
    );
  });

  it('crosses a month boundary', () => {
    const bounds = weekBounds(parseDateOnly('2026-11-01'));

    expect(bounds.weekStart).toBe('2026-10-26');
    expect(bounds.weekEnd).toBe('2026-11-01');
  });
});

describe('periodBounds', () => {
  it('starts the period on the first day', () => {
    const bounds = periodBounds('2026-10-01', '2026-10-31');

    expect(bounds.from.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('ends the period after the last day, so the last day is included', () => {
    const bounds = periodBounds('2026-10-01', '2026-10-31');

    expect(bounds.to.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('covers a single day exactly', () => {
    const bounds = periodBounds('2026-10-21', '2026-10-21');

    expect(periodLengthInDays(bounds.from, bounds.to)).toBe(1);
  });

  it('covers a whole month', () => {
    const bounds = periodBounds('2026-10-01', '2026-10-31');

    expect(periodLengthInDays(bounds.from, bounds.to)).toBe(31);
  });

  it('refuses a period that ends before it starts', () => {
    expect(() => periodBounds('2026-10-31', '2026-10-01')).toThrow(
      InvalidDateRangeException,
    );
  });

  it('refuses a period with a malformed day', () => {
    expect(() => periodBounds('2026-10-01', '31/10/2026')).toThrow(
      InvalidDateRangeException,
    );
  });
});
