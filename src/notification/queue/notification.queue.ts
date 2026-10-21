import type {
  NotificationDeadLetter,
  NotificationJob,
  NotificationQueueDriver,
  NotificationQueueReceipt,
} from '../notification.types';

/** DI token. Listeners and the inspector depend on the interface, not a driver. */
export const NOTIFICATION_QUEUE = Symbol('NOTIFICATION_QUEUE');

/**
 * The queue contract.
 *
 * Two implementations exist: `BullNotificationQueue` (Redis, the production
 * path) and `InMemoryNotificationQueue` (no-Redis development and unit tests).
 * Both provide the same guarantees for the lifetime of one process:
 *
 *   - `enqueue` returns immediately; the send happens off the request path;
 *   - a failed send is retried with exponential backoff, then moved to a dead
 *     letter rather than disappearing;
 *   - `eventKey` makes a duplicate delivery a no-op;
 *   - dead letters can be inspected per tenant.
 *
 * `close` is part of the contract so a driver cannot leak timers or Redis
 * sockets on shutdown.
 */
export interface NotificationQueue {
  readonly driver: NotificationQueueDriver;
  enqueue(job: NotificationJob): Promise<NotificationQueueReceipt>;
  listDeadLetters(
    tenantId: string,
    limit: number,
  ): Promise<NotificationDeadLetter[]>;
  close(): Promise<void>;
}
