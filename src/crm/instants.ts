import { InvalidInstantException } from './exceptions/crm.exceptions';

/**
 * An ISO-8601 instant that carries an explicit UTC offset.
 *
 * `2026-10-21T09:00:00` (no offset) is deliberately rejected: JavaScript parses
 * it as LOCAL time in the server's zone, so the same promotion start would mean
 * a different instant in a container in UTC and on a laptop in Kathmandu. A
 * promotion window that silently moves by hours is exactly the kind of bug that
 * only shows up on the one day it matters.
 */
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/i;

/**
 * Parses an ISO-8601 instant, refusing anything without an explicit offset.
 */
export function parseIsoInstant(value: string, label: string): Date {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) {
    throw new InvalidInstantException(
      `${label} must be an ISO-8601 instant with an explicit UTC offset ` +
        `(for example '2026-10-21T09:00:00Z' or '2026-10-21T09:00:00+05:30'), ` +
        `but was '${value}'.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidInstantException(
      `${label} '${value}' is not a real instant.`,
    );
  }
  return date;
}
