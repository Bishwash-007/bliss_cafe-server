import { hoursBetween, minutesBetween } from './hours';

const at = (iso: string): Date => new Date(iso);

describe('minutesBetween', () => {
  it('counts whole minutes between two instants', () => {
    expect(
      minutesBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T17:00:00Z')),
    ).toBe(480);
    expect(
      minutesBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T16:30:00Z')),
    ).toBe(450);
  });

  it('counts a partial minute as zero rather than rounding it up', () => {
    // Truncating is what stops a 7h 59m 40s shift from being paid as 8 hours.
    expect(
      minutesBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T09:00:59Z')),
    ).toBe(0);
    expect(
      minutesBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T10:00:59Z')),
    ).toBe(60);
  });

  it('is zero for a zero or negative span', () => {
    expect(
      minutesBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T09:00:00Z')),
    ).toBe(0);
    expect(
      minutesBetween(at('2026-10-21T10:00:00Z'), at('2026-10-21T09:00:00Z')),
    ).toBe(0);
  });
});

describe('hoursBetween', () => {
  it('keeps the half hour, instead of rounding to the nearest hour', () => {
    // The acceptance criterion, as arithmetic: 7.5 hours must not become 8.
    expect(
      hoursBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T16:30:00Z')),
    ).toBe(7.5);
  });

  it('is the minutes over sixty', () => {
    expect(
      hoursBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T09:15:00Z')),
    ).toBe(0.25);
    expect(
      hoursBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T10:20:00Z')),
    ).toBe(1.3333333333333333);
  });

  it('is zero when nothing was worked', () => {
    expect(
      hoursBetween(at('2026-10-21T09:00:00Z'), at('2026-10-21T09:00:00Z')),
    ).toBe(0);
  });
});
