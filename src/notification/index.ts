/**
 * Public barrel for the Notification module.
 *
 * ## What is implemented
 *
 *  - **Three channels** behind one `NotificationChannel` interface
 *    (`send(recipient, message): Promise<void>`): `SmsChannel`,
 *    `EmailChannel`, `PushChannel`. `NotificationFactory.create(channel)` is the
 *    only place that maps a name to a class.
 *  - **Observer listeners** for `order.status_changed` (only `ready`),
 *    `inventory.low_stock`, and the CRM `crm.promotion` / `crm.birthday`
 *    contract. No listener is called synchronously from another module's
 *    business logic, and no second event bus exists.
 *  - **Queueing** with BullMQ when `REDIS_URL` is set: 3 attempts
 *    (configurable) with exponential backoff, then a copy into
 *    `notifications-dlq`. Without Redis an in-memory driver provides the same
 *    retry/dead-letter behaviour in one process (development and tests only).
 *  - **Opt-out** honoured for every customer-facing message through
 *    `customers.notification_opt_out` (migration 016). Staff low-stock mail is
 *    not a customer preference and is not filtered.
 *  - **Dead-letter inspection** at `GET /notifications/dead-letter`, filtered
 *    by tenant and restricted to owner/branch-manager roles.
 *
 * ## Delivery path
 *
 * ```text
 * POST /orders/:id/status  ->  order.status_changed (after commit)
 *                                      |
 *                                      v
 *                          OrderReadyNotificationListener
 *                                      |
 *                          NotificationService (opt-out, channel, recipient)
 *                                      |
 *                          BullMQ "notifications"  --fail x3--> "notifications-dlq"
 *                                      |
 *                          NotificationProcessor -> channel -> gateway (stub)
 * ```
 *
 * ## Provider integrations are stubs — on purpose
 *
 * `LoggingNotificationDeliveryGateway` logs and resolves. No Twilio, SendGrid or
 * FCM credentials exist in this repository, and the channel/queue/opt-out logic
 * is real regardless. Replace the gateway (one provider binding) when a
 * provider is chosen; nothing above it changes.
 *
 * ## Deliberate gaps
 *
 *  - **No notification history table.** The queue's dead-letter set is for
 *    failures, not a per-customer delivery log. Adding one needs a retention
 *    policy and a decision about storing message bodies that contain PII.
 *  - **The event bus is in-process and best-effort**, exactly like the order
 *    and inventory buses (see `src/order/events/order-events.ts`). If the API
 *    dies between the domain commit and `enqueue`, that notification is lost.
 *    A transactional outbox is the upgrade path; it is not built because
 *    nothing requires at-least-once customer messaging yet.
 *  - **No retry/delete endpoint for dead letters.** Replaying a failed send
 *    must re-check opt-out and relevance; a blind replay button is a footgun.
 *  - **No campaign scheduler or segments.** CRM publishes
 *    `crm.promotion`/`crm.birthday` from explicit operator endpoints
 *    (`POST /promotions/:id/announce`, `POST /customers/birthdays/announce`),
 *    and this listener consumes them. Choosing a recurring moment or a segment
 *    remains the CRM layer's job; notification only applies opt-out and channel
 *    choice per customer.
 *  - **No preference-editing API.** `customers.notification_channel` and
 *    `notification_opt_out` are read; a customer-facing preferences screen
 *    would need authentication for customers, which the auth module does not
 *    provide yet.
 *  - **Push is one device per customer.** `customers.push_token` is the latest
 *    registration; multi-device delivery needs a token table.
 *  - **No template rendering.** Messages are composed in
 *    `NotificationService` so the content is testable in code. Localisation and
 *    per-tenant templates are a later feature with their own schema.
 */

export { NotificationModule } from './notification.module';
export { NotificationService } from './notification.service';
export { NotificationController } from './notification.controller';
export { NotificationRepository } from './notification.repository';
export type {
  CustomerContactRow,
  OrderNotificationContextRow,
  BranchManagerRow,
} from './notification.repository';

export {
  NOTIFICATION_CHANNELS,
  isNotificationChannel,
  NOTIFICATION_SOURCES,
  type NotificationChannelName,
  type NotificationDeadLetter,
  type NotificationJob,
  type NotificationMessage,
  type NotificationQueueDriver,
  type NotificationQueueReceipt,
  type NotificationSource,
} from './notification.types';
export type {
  NotificationDispatchResult,
  NotificationSkipReason,
} from './notification.service';
export {
  DEFAULT_NOTIFICATION_ATTEMPTS,
  DEFAULT_NOTIFICATION_BACKOFF_MS,
  DEFAULT_NOTIFICATION_DLQ,
  DEFAULT_NOTIFICATION_QUEUE,
  readNotificationQueueConfig,
  type NotificationQueueConfig,
  type NotificationRetryPolicy,
} from './notification.config';
export {
  InvalidNotificationRecipientException,
  UnsupportedNotificationChannelException,
} from './notification.exceptions';

export type { NotificationChannel } from './channels/notification-channel.interface';
export { NotificationFactory } from './channels/notification.factory';
export { SmsChannel } from './channels/sms.channel';
export { EmailChannel } from './channels/email.channel';
export { PushChannel } from './channels/push.channel';
export {
  LoggingNotificationDeliveryGateway,
  NOTIFICATION_DELIVERY_GATEWAY,
  maskRecipient,
  type NotificationDelivery,
  type NotificationDeliveryGateway,
} from './channels/notification-delivery.gateway';

export {
  NOTIFICATION_QUEUE,
  type NotificationQueue,
} from './queue/notification.queue';
export { NotificationProcessor } from './queue/notification.processor';
export { InMemoryNotificationQueue } from './queue/in-memory-notification.queue';
export {
  BullNotificationQueue,
  hasExhaustedAttempts,
  notificationJobId,
  retryOptions,
  type BullNotificationQueueOptions,
} from './queue/bullmq-notification.queue';

export { OrderReadyNotificationListener } from './listeners/order-ready.listener';
export { InventoryLowStockNotificationListener } from './listeners/inventory-low-stock.listener';
export { CrmCustomerNotificationListener } from './listeners/crm-customer.listener';
