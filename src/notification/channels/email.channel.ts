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
 * Email transport.
 *
 * Email is the only channel with a real subject line, so a title is required
 * here (and for push, where the OS shows it as the notification heading). The
 * recipient check is intentionally shallow — RFC 5322 is not worth
 * reimplementing — but it catches the common bug of an empty or malformed
 * address before a job enters the retry loop.
 */
@Injectable()
export class EmailChannel implements NotificationChannel {
  readonly name = 'email' as const;

  constructor(
    @Inject(NOTIFICATION_DELIVERY_GATEWAY)
    private readonly gateway: NotificationDeliveryGateway,
  ) {}

  async send(recipient: string, message: NotificationMessage): Promise<void> {
    assertNotificationMessage(message, { requireTitle: true });
    assertEmail(recipient);
    await this.gateway.deliver(
      deliveryFor(this.name, recipient.trim(), message),
    );
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function assertEmail(recipient: string): void {
  const trimmed = recipient?.trim() ?? '';
  if (trimmed.length > 254 || !EMAIL_RE.test(trimmed)) {
    throw new InvalidNotificationRecipientException(
      'email',
      'expected an email address',
    );
  }
}
