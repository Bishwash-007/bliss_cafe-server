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
 * SMS transport.
 *
 * The recipient is a phone number in whatever shape the customer typed it
 * ("+977 980-0000000", "9800000000"). Providers normalise it themselves, so
 * this channel only rejects strings that cannot be a number at all; silently
 * rewriting a number risks changing which phone rings.
 *
 * SMS has no subject, so the title is carried to the gateway as metadata but a
 * provider adapter would send `body` alone.
 */
@Injectable()
export class SmsChannel implements NotificationChannel {
  readonly name = 'sms' as const;

  constructor(
    @Inject(NOTIFICATION_DELIVERY_GATEWAY)
    private readonly gateway: NotificationDeliveryGateway,
  ) {}

  async send(recipient: string, message: NotificationMessage): Promise<void> {
    assertNotificationMessage(message, { requireTitle: false });
    assertPhone(recipient);
    await this.gateway.deliver(
      deliveryFor(this.name, recipient.trim(), message),
    );
  }
}

const PHONE_CHARS = /^\+?[0-9][0-9\s().-]*$/;

function assertPhone(recipient: string): void {
  const trimmed = recipient?.trim() ?? '';
  const digits = trimmed.replace(/\D/g, '');
  if (!PHONE_CHARS.test(trimmed) || digits.length < 7 || digits.length > 15) {
    throw new InvalidNotificationRecipientException(
      'sms',
      'expected a phone number with 7 to 15 digits',
    );
  }
}
