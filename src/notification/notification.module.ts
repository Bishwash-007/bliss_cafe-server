import { Logger, Module, type Provider } from '@nestjs/common';
import { EmailChannel } from './channels/email.channel';
import {
  LoggingNotificationDeliveryGateway,
  NOTIFICATION_DELIVERY_GATEWAY,
} from './channels/notification-delivery.gateway';
import { NotificationFactory } from './channels/notification.factory';
import { PushChannel } from './channels/push.channel';
import { SmsChannel } from './channels/sms.channel';
import { CrmCustomerNotificationListener } from './listeners/crm-customer.listener';
import { InventoryLowStockNotificationListener } from './listeners/inventory-low-stock.listener';
import { OrderReadyNotificationListener } from './listeners/order-ready.listener';
import { readNotificationQueueConfig } from './notification.config';
import { NotificationController } from './notification.controller';
import { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { BullNotificationQueue } from './queue/bullmq-notification.queue';
import { InMemoryNotificationQueue } from './queue/in-memory-notification.queue';
import { NotificationProcessor } from './queue/notification.processor';
import {
  NOTIFICATION_QUEUE,
  type NotificationQueue,
} from './queue/notification.queue';

const logger = new Logger('NotificationModule');

/**
 * Picks the queue driver once, from the environment.
 *
 * A provider factory (rather than two modules or a runtime `if` in every
 * caller) keeps the driver choice an infrastructure detail: listeners inject
 * `NOTIFICATION_QUEUE`, and nothing above it knows whether Redis is present.
 */
const notificationQueueProvider: Provider = {
  provide: NOTIFICATION_QUEUE,
  inject: [NotificationProcessor],
  useFactory: (processor: NotificationProcessor): NotificationQueue => {
    const config = readNotificationQueueConfig();

    if (config.redisUrl) {
      logger.log(
        `Using BullMQ queues "${config.queueName}" / "${config.deadLetterQueueName}".`,
      );
      return new BullNotificationQueue({
        redisUrl: config.redisUrl,
        queueName: config.queueName,
        deadLetterQueueName: config.deadLetterQueueName,
        retry: config.retry,
        processor,
      });
    }

    logger.warn(
      'REDIS_URL is not set: notifications use the in-memory queue. Jobs are ' +
        'not durable and are not shared across replicas. Set REDIS_URL in any ' +
        'deployed environment.',
    );
    return new InMemoryNotificationQueue(processor, config.retry);
  },
};

/**
 * # NotificationModule
 *
 * SMS, email and push, delivered off the request path.
 *
 * ## The pipeline
 *
 * ```
 * order.status_changed / inventory.low_stock / crm.*
 *        │  (Observer listeners, no second event bus)
 *        ▼
 * NotificationService — recipient, channel, opt-out (one place)
 *        │
 *        ▼
 * NOTIFICATION_QUEUE — BullMQ when REDIS_URL is set, memory otherwise
 *        │  retries with exponential backoff; exhausted -> dead letter
 *        ▼
 * NotificationProcessor -> NotificationFactory -> Sms/Email/PushChannel
 *        │
 *        ▼
 * NOTIFICATION_DELIVERY_GATEWAY — provider adapter seam (logging stub today)
 * ```
 *
 * ## What this module imports
 *
 * Only event contracts: `ORDER_EVENTS`, `INVENTORY_EVENTS`, `CRM_EVENTS` and
 * their payload types. It does not import `OrderModule`, `InventoryModule` or
 * `CrmModule`, and it never calls their services. `EventEmitterModule` is
 * registered globally in `AppModule`; the tenant foundation is `@Global` too.
 *
 * ## What is deliberately not here
 *
 * No persisted notification history, no per-template editing, no delivery
 * receipts/webhooks, and no campaign scheduler. CRM now publishes one event per
 * customer from its announce endpoints; choosing a recurring moment or segment
 * stays a CRM concern. `customers.notification_channel` records a preference;
 * there is no customer-facing preference-editing endpoint yet (CRM can record a
 * birthday via `PATCH /customers/:id`, but notification preferences are still
 * written directly).
 */
@Module({
  controllers: [NotificationController],
  providers: [
    NotificationRepository,
    NotificationService,
    NotificationProcessor,
    NotificationFactory,

    SmsChannel,
    EmailChannel,
    PushChannel,
    {
      provide: NOTIFICATION_DELIVERY_GATEWAY,
      useClass: LoggingNotificationDeliveryGateway,
    },

    notificationQueueProvider,

    OrderReadyNotificationListener,
    InventoryLowStockNotificationListener,
    CrmCustomerNotificationListener,
  ],
  exports: [
    NotificationService,
    NotificationFactory,
    NOTIFICATION_QUEUE,
    NOTIFICATION_DELIVERY_GATEWAY,
  ],
})
export class NotificationModule {}
