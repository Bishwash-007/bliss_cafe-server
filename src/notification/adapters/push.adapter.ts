import { Injectable } from '@nestjs/common';
import type {
  DeliveryResult,
  NotificationAdapter,
} from '../channels/notification-channel.interface';
import type { NotificationMessage } from '../notification.types';

@Injectable()
export class PushAdapter implements NotificationAdapter {
  readonly name = 'push-stub';
  readonly channel = 'push' as const;

  send(
    _recipient: string,
    _message: NotificationMessage,
  ): Promise<DeliveryResult> {
    // Stub adapter - integrate with FCM/APNs in production
    return Promise.resolve({
      status: 'delivered',
      messageId: `push-${Date.now()}`,
      retryable: false,
    });
  }
}
