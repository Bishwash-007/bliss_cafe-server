import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ORDER_EVENTS, type OrderStatusChangedEvent } from '../../order';
import { NotificationService } from '../notification.service';

/**
 * `order.status_changed` -> notify the customer when the order is `ready`.
 *
 * ## Why this is an Observer, not a call from the order module
 *
 * The order transaction has already committed when this runs. Notification is
 * a side effect of a sale, not part of it: a provider outage must never fail a
 * kitchen transition, and `OrderModule` must not learn about SMS providers.
 * The only thing imported from Order is the event contract (one constant and
 * one type), exactly like the Inventory and CRM listeners.
 *
 * ## Why the handler swallows its own errors
 *
 * `EventEmitter2` is synchronous and in-process. A throw here would propagate
 * into the publisher after commit, where there is nothing to roll back — only
 * a confusing error on a request that already succeeded. Failures are logged,
 * and a queued job's own retry policy takes over from there.
 */
@Injectable()
export class OrderReadyNotificationListener {
  private readonly logger = new Logger(OrderReadyNotificationListener.name);

  constructor(private readonly notifications: NotificationService) {}

  @OnEvent(ORDER_EVENTS.statusChanged)
  async onOrderStatusChanged(event: OrderStatusChangedEvent): Promise<void> {
    if (event?.newStatus !== 'ready') {
      return;
    }

    try {
      const outcome = await this.notifications.notifyOrderReady(event);
      if (outcome.queued === 0) {
        this.logger.debug(
          `No "ready" notification for order ${event.orderId}: ${outcome.skipped}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not queue the "ready" notification for order ${event?.orderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
