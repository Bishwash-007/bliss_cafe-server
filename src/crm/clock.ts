import { Injectable } from '@nestjs/common';

/**
 * The source of "now" for promotion validity.
 *
 * Injected rather than calling `new Date()` inline so a request has ONE notion
 * of now (a promotion cannot be "expired" for the start check and "live" for
 * the end check a microsecond later), and so a unit test can place itself
 * before, inside and after a promotion window without waiting for a date.
 */
export const CRM_CLOCK = 'CRM_CLOCK';

export interface CrmClock {
  now(): Date;
}

@Injectable()
export class SystemClock implements CrmClock {
  now(): Date {
    return new Date();
  }
}
