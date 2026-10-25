import { Injectable } from '@nestjs/common';
import type {
  DeliveryResult,
  NotificationAdapter,
} from '../channels/notification-channel.interface';
import type { NotificationMessage } from '../notification.types';

@Injectable()
export class EmailAdapter implements NotificationAdapter {
  readonly name = 'email-stub';
  readonly channel = 'email' as const;

  send(
    _recipient: string,
    _message: NotificationMessage,
  ): Promise<DeliveryResult> {
    // Stub adapter - integrate with SES/SendGrid in production
    return Promise.resolve({
      status: 'delivered',
      messageId: `email-${Date.now()}`,
      retryable: false,
    });
  }
}
