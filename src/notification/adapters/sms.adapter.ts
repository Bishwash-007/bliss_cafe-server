import { Injectable } from '@nestjs/common';
import type {
  DeliveryResult,
  NotificationAdapter,
} from '../channels/notification-channel.interface';
import type { NotificationMessage } from '../notification.types';

@Injectable()
export class SmsAdapter implements NotificationAdapter {
  readonly name = 'sms-stub';
  readonly channel = 'sms' as const;

  send(
    _recipient: string,
    _message: NotificationMessage,
  ): Promise<DeliveryResult> {
    // Stub adapter - integrate with Twilio/MSG91 in production
    return Promise.resolve({
      status: 'delivered',
      messageId: `sms-${Date.now()}`,
      retryable: false,
    });
  }
}
