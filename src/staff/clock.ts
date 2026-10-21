import { Injectable } from '@nestjs/common';

/**
 * # Clock
 *
 * The source of "now".
 *
 * An interface with one method, injected wherever the current time matters,
 * for two reasons that are both about testability:
 *
 *  - the clock-in window and the clock-out ordering are rules about TIME. A
 *    test that has to wait for a particular minute of the day to prove a rule
 *    is a test nobody runs. With the clock injected, a test can place two
 *    events 30 seconds apart and assert the rule holds;
 *  - "now" called in three places of one request can be three different
 *    instants. A shift that starts at `now` and a clock-in at `now` can straddle
 *    a second boundary and fail a window check that should have passed. One
 *    clock, read once per operation, removes the class of bug entirely.
 */
export interface Clock {
  now(): Date;
}

/**
 * DI token for the clock.
 */
export const CLOCK = 'CLOCK';

/**
 * The real clock.
 */
@Injectable()
export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}
