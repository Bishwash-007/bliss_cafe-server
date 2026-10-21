/**
 * Shapes shared by the notification pipeline.
 *
 * A notification is always the same three facts no matter which transport
 * eventually carries it: WHO receives it, WHAT the text is, and WHICH channel
 * should carry it. Keeping that shape in one place is what lets the queue,
 * the factory, the worker and the dead-letter inspector agree without any of
 * them knowing a provider SDK.
 *
 * Money does not appear here, and neither does a gateway credential. A job is
 * plain JSON because BullMQ stores it in Redis; anything that cannot survive
 * `JSON.stringify` does not belong in a notification.
 */

/** The channels the factory knows how to build. */
export const NOTIFICATION_CHANNELS = ['sms', 'email', 'push'] as const;

export type NotificationChannelName = (typeof NOTIFICATION_CHANNELS)[number];

/** Narrows untrusted input (a job body, a preference column) to a channel. */
export function isNotificationChannel(
  value: unknown,
): value is NotificationChannelName {
  return (
    typeof value === 'string' &&
    (NOTIFICATION_CHANNELS as readonly string[]).includes(value)
  );
}

/**
 * The renderable part of a notification.
 *
 * `title` is meaningless to SMS but meaningful to email and push, so it is
 * required here rather than added per channel: a listener writes one message
 * and the channel decides which fields its provider uses. That is the whole
 * point of the shared interface.
 *
 * `data` is provider-neutral metadata (ids a client can deep-link from). It is
 * string-valued because push providers and queue payloads are JSON.
 */
export interface NotificationMessage {
  readonly title: string;
  readonly body: string;
  readonly data?: Readonly<Record<string, string>>;
}

/** Where the event that produced a job came from, for operators reading a DLQ. */
export const NOTIFICATION_SOURCES = [
  'order.ready',
  'inventory.low_stock',
  'crm.promotion',
  'crm.birthday',
] as const;

export type NotificationSource = (typeof NOTIFICATION_SOURCES)[number];

/**
 * One unit of queued work.
 *
 * `eventKey` is the idempotency key. The order bus and the inventory bus are
 * in-process and best-effort, so the same event can arrive twice; both queue
 * drivers use this key as the job id and ignore a second delivery. It must
 * therefore include the recipient: a promotion sent to two customers is two
 * jobs, while one customer receiving the same promotion twice is one.
 */
export interface NotificationJob {
  readonly tenantId: string;
  readonly channel: NotificationChannelName;
  readonly recipient: string;
  readonly message: NotificationMessage;
  readonly eventKey: string;
  readonly source: NotificationSource;
  /** Non-secret correlation ids (orderId, customerId, itemId, …). */
  readonly context: Readonly<Record<string, string>>;
  /** ISO-8601, stamped when the event was observed. */
  readonly enqueuedAt: string;
}

/** What `enqueue` reports. A duplicate is a normal, successful outcome. */
export interface NotificationQueueReceipt {
  readonly id: string;
  readonly driver: NotificationQueueDriver;
  readonly duplicate: boolean;
}

export type NotificationQueueDriver = 'bullmq' | 'memory';

/**
 * A job that exhausted its retries.
 *
 * The payload is kept verbatim so an operator can see the recipient and the
 * message that could not be delivered. That also means a dead letter contains
 * personal data: the HTTP inspector is restricted to tenant staff, and the
 * queue itself should be treated as production data.
 */
export interface NotificationDeadLetter {
  readonly id: string;
  readonly job: NotificationJob;
  readonly failedReason: string;
  readonly attemptsMade: number;
  readonly deadLetteredAt: string;
}
