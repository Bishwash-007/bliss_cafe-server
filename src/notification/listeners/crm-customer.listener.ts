import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  CRM_EVENTS,
  type CrmBirthdayEvent,
  type CrmPromotionEvent,
} from '../../crm';
import { NotificationService } from '../notification.service';

/**
 * CRM promotion/birthday events -> the customer's preferred channel.
 *
 * `CrmEventPublisher` emits these from the announce endpoints; this listener
 * is the subscriber side of the contract, so a future campaign scheduler only
 * has to call the publisher and no notification code changes. Two explicit
 * `@OnEvent` handlers rather than one wildcard keep the routing visible: a
 * promotion and a birthday have different message copy and different dedupe
 * keys, and only the service knows that.
 *
 * Errors are swallowed for the same reason as the other listeners: the event
 * fires after the publisher's write committed, and an SMS failure must not
 * make a CRM operation look unsuccessful.
 */
@Injectable()
export class CrmCustomerNotificationListener {
  private readonly logger = new Logger(CrmCustomerNotificationListener.name);

  constructor(private readonly notifications: NotificationService) {}

  @OnEvent(CRM_EVENTS.promotion)
  async onPromotion(event: CrmPromotionEvent): Promise<void> {
    await this.dispatch(event);
  }

  @OnEvent(CRM_EVENTS.birthday)
  async onBirthday(event: CrmBirthdayEvent): Promise<void> {
    await this.dispatch(event);
  }

  private async dispatch(
    event: CrmPromotionEvent | CrmBirthdayEvent,
  ): Promise<void> {
    try {
      const outcome = await this.notifications.notifyCrmEvent(event);
      if (outcome.queued === 0) {
        this.logger.debug(
          `No ${event?.event} notification for customer ${event?.customerId}: ${outcome.skipped}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Could not queue ${event?.event} for customer ${event?.customerId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
