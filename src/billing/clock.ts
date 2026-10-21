import { Injectable } from '@nestjs/common';

/** DI token for the billing module's source of "now". */
export const BILLING_CLOCK = 'BILLING_CLOCK';

/**
 * The source of the current instant.
 *
 * A seam, not ceremony: proration depends on how many days are left in the
 * cycle and the renewal sweep depends on which subscriptions are due. A unit
 * test that has to wait for a real day boundary is a test nobody runs.
 */
export interface BillingClock {
  now(): Date;
}

@Injectable()
export class SystemBillingClock implements BillingClock {
  now(): Date {
    return new Date();
  }
}
