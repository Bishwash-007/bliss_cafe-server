import { Inject, Injectable } from '@nestjs/common';
import { InvalidNotificationRecipientException } from '../notification.exceptions';
import type { NotificationMessage } from '../notification.types';
import {
  deliveryFor,
  NOTIFICATION_DELIVERY_GATEWAY,
  type NotificationDeliveryGateway,
} from './notification-delivery.gateway';
import type { NotificationChannel } from './notification-channel.interface';
import { assertNotificationMessage } from './validate-message';

/**
 * Push transport.
 *
 * The recipient is an opaque device token issued by the platform, not a
 * customer id: a token is what FCM/APNs can actually address, and a customer
 * with two phones has two. `customers.push_token` (migration 016) stores the
 * most recent registration; a real implementation would move tokens to their
 * own table to support multi-device delivery.
 *
 * A title is required because both Android and iOS render it as the
 * notification heading.
 */
@Injectable()
export class PushChannel implements NotificationChannel {
  readonly name = 'push' as const;

  constructor(
    @Inject(NOTIFICATION_DELIVERY_GATEWAY)
    private readonly gateway: NotificationDeliveryGateway,
  ) {}

  async send(recipient: string, message: NotificationMessage): Promise<void> {
    assertNotificationMessage(message, { requireTitle: true });
    assertPushToken(recipient);
    await this.gateway.deliver(
      deliveryFor(this.name, recipient.trim(), message),
    );
  }
}

function assertPushToken(recipient: string): void {
  const trimmed = recipient?.trim() ?? '';
  if (!trimmed || trimmed.length > 4096 || /\s/.test(trimmed)) {
    throw new InvalidNotificationRecipientException(
      'push',
      'expected a non-empty device token without whitespace',
    );
  }
}
