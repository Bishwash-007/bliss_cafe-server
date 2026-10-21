import {
  CLOCK_IN_WINDOW_ENV,
  CLOCK_IN_WINDOW_MINUTES,
  ClockInPolicy,
  DEFAULT_CLOCK_IN_WINDOW_MINUTES,
  clockInWindowFromEnv,
} from './clock-in-policy';

/** An environment with only the keys a test cares about. */
function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [CLOCK_IN_WINDOW_ENV]: value };
}

describe('clockInWindowFromEnv', () => {
  it('defaults to 30 minutes when the variable is absent', () => {
    expect(clockInWindowFromEnv(env())).toBe(DEFAULT_CLOCK_IN_WINDOW_MINUTES);
    expect(DEFAULT_CLOCK_IN_WINDOW_MINUTES).toBe(30);
  });

  it('reads a configured window', () => {
    expect(clockInWindowFromEnv(env('45'))).toBe(45);
  });

  it('treats an empty value as absent', () => {
    expect(clockInWindowFromEnv(env(''))).toBe(DEFAULT_CLOCK_IN_WINDOW_MINUTES);
    expect(clockInWindowFromEnv(env('   '))).toBe(
      DEFAULT_CLOCK_IN_WINDOW_MINUTES,
    );
  });

  it('falls back rather than refusing to boot on a malformed value', () => {
    // A typo in an optional tuning knob must not stop the whole API: the
    // fallback is the documented default, and the warning says so.
    for (const value of ['30min', 'abc', '1.5', '0', '-30']) {
      expect(clockInWindowFromEnv(env(value))).toBe(
        DEFAULT_CLOCK_IN_WINDOW_MINUTES,
      );
    }
  });

  it('accepts a window of one minute', () => {
    expect(clockInWindowFromEnv(env('1'))).toBe(1);
  });
});

describe('ClockInPolicy', () => {
  const start = new Date('2026-10-21T09:00:00Z');
  const policy = new ClockInPolicy(30);

  it('exposes the window it was given', () => {
    expect(policy.minutes).toBe(30);
  });

  it('is symmetric around the start', () => {
    expect(policy.earliestFor(start).toISOString()).toBe(
      '2026-10-21T08:30:00.000Z',
    );
    expect(policy.latestFor(start).toISOString()).toBe(
      '2026-10-21T09:30:00.000Z',
    );
  });

  it('accepts a clock-in inside the window', () => {
    expect(policy.accepts(start, new Date('2026-10-21T09:05:00Z'))).toBe(true);
    expect(policy.accepts(start, new Date('2026-10-21T08:45:00Z'))).toBe(true);
  });

  it('accepts both edges, because a window that excluded its edge is a boundary nobody remembers', () => {
    expect(policy.accepts(start, new Date('2026-10-21T08:30:00Z'))).toBe(true);
    expect(policy.accepts(start, new Date('2026-10-21T09:30:00Z'))).toBe(true);
  });

  it('refuses a clock-in one millisecond outside the window', () => {
    expect(policy.accepts(start, new Date('2026-10-21T08:29:59.999Z'))).toBe(
      false,
    );
    expect(policy.accepts(start, new Date('2026-10-21T09:30:00.001Z'))).toBe(
      false,
    );
  });

  it('refuses a clock-in hours away in either direction', () => {
    expect(policy.accepts(start, new Date('2026-10-21T06:00:00Z'))).toBe(false);
    expect(policy.accepts(start, new Date('2026-10-21T14:00:00Z'))).toBe(false);
  });

  it('honours a narrower window', () => {
    const strict = new ClockInPolicy(5);

    expect(strict.accepts(start, new Date('2026-10-21T09:04:00Z'))).toBe(true);
    expect(strict.accepts(start, new Date('2026-10-21T09:06:00Z'))).toBe(false);
  });
});

describe('the DI token', () => {
  it('is a stable string every provider can agree on', () => {
    expect(typeof CLOCK_IN_WINDOW_MINUTES).toBe('string');
  });
});
