import { Inject, Injectable, Logger } from '@nestjs/common';

/**
 * Minutes before and after a scheduled start within which a clock-in is
 * accepted.
 *
 * The default, when the environment does not say otherwise.
 */
export const DEFAULT_CLOCK_IN_WINDOW_MINUTES = 30;

/**
 * DI token for the window, so the value is data rather than a constant baked
 * into the service — and so a test can supply its own without touching the
 * environment.
 */
export const CLOCK_IN_WINDOW_MINUTES = 'CLOCK_IN_WINDOW_MINUTES';

/**
 * The environment variable that overrides the window.
 */
export const CLOCK_IN_WINDOW_ENV = 'STAFF_CLOCK_IN_WINDOW_MINUTES';

/**
 * Reads the window from the environment, falling back to the default.
 *
 * A malformed value is a warning, not a boot failure: this knob tunes how
 * forgiving the clock-in check is, and refusing to start the whole API because
 * somebody typed `STAFF_CLOCK_IN_WINDOW_MINUTES=30min` would be a far worse
 * outcome than using the default and saying so loudly.
 *
 * Zero is rejected for the same reason — a window of zero means a clock-in must
 * land on the exact second of the shift start, which is not a policy anybody
 * wants and is almost certainly a mistake.
 */
export function clockInWindowFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[CLOCK_IN_WINDOW_ENV];
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_CLOCK_IN_WINDOW_MINUTES;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    new Logger('ClockInPolicy').warn(
      `${CLOCK_IN_WINDOW_ENV} is '${raw}', which is not a positive whole ` +
        `number of minutes. Falling back to ${DEFAULT_CLOCK_IN_WINDOW_MINUTES}.`,
    );
    return DEFAULT_CLOCK_IN_WINDOW_MINUTES;
  }
  return parsed;
}

/**
 * # ClockInPolicy
 *
 * Decides whether a clock-in is close enough to the scheduled start to be
 * believable.
 *
 * The window is symmetric: a shift starting at 09:00 accepts a clock-in from
 * 08:30 to 09:30. Being early is as much a scheduling error as being late, and
 * an attendance record nobody checked is the kind of bad data that makes a
 * payroll wrong without anybody noticing.
 *
 * The policy is asked about the WINDOW, never about the clock itself. The
 * service passes in the instant of the clock-in, which makes the whole
 * decision a pure function of its arguments — and that is what lets the
 * boundary cases (exactly on the edge) be tested without waiting for a
 * particular minute of the day.
 */
@Injectable()
export class ClockInPolicy {
  constructor(
    @Inject(CLOCK_IN_WINDOW_MINUTES)
    private readonly windowMinutes: number,
  ) {}

  /** The window, in minutes, before and after the scheduled start. */
  get minutes(): number {
    return this.windowMinutes;
  }

  /** The earliest acceptable clock-in for a shift starting at `startTime`. */
  earliestFor(startTime: Date): Date {
    return new Date(startTime.getTime() - this.windowMinutes * 60_000);
  }

  /** The latest acceptable clock-in for a shift starting at `startTime`. */
  latestFor(startTime: Date): Date {
    return new Date(startTime.getTime() + this.windowMinutes * 60_000);
  }

  /**
   * Whether a clock-in at `at` is inside the window for a shift starting at
   * `startTime`.
   *
   * Both edges are INCLUSIVE: a clock-in exactly at the earliest allowed
   * instant is accepted. A window described as "±30 minutes" that rejected
   * the 30th minute would be a boundary nobody could remember.
   */
  accepts(startTime: Date, at: Date): boolean {
    const time = at.getTime();
    return (
      time >= this.earliestFor(startTime).getTime() &&
      time <= this.latestFor(startTime).getTime()
    );
  }
}
