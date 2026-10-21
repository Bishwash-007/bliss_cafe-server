import { Injectable, Logger } from '@nestjs/common';
import type {
  NotificationChannelName,
  NotificationMessage,
} from '../notification.types';

/**
 * The seam between a channel and a real provider.
 *
 * `SmsChannel`, `EmailChannel` and `PushChannel` own the channel-specific
 * validation and formatting. Everything below that — Twilio, SendGrid, FCM — is
 * deliberately a stub today: no credentials exist in this repository, and
 * inventing an HTTP contract for a provider that has not been chosen would be
 * harder to replace than an empty seam.
 *
 * ## Why a gateway rather than logging inside each channel
 *
 * Tests need to force a delivery failure to exercise retry and the dead-letter
 * queue. They override this provider with a scripted fake; the channels, the
 * queue and the retry policy stay exactly as they run in production. The same
 * seam is where a real provider adapter will go.
 */
export interface NotificationDelivery {
  readonly channel: NotificationChannelName;
  readonly recipient: string;
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, string>>;
}

export interface NotificationDeliveryGateway {
  deliver(delivery: NotificationDelivery): Promise<void>;
}

export const NOTIFICATION_DELIVERY_GATEWAY = Symbol(
  'NOTIFICATION_DELIVERY_GATEWAY',
);

/**
 * The default gateway: logs the send and resolves.
 *
 * TODO(notification-providers): replace this with provider adapters when
 * credentials are available —
 *   - SMS: Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`)
 *   - email: SendGrid (`SENDGRID_API_KEY`, `SENDGRID_FROM`)
 *   - push: FCM (`FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON`)
 *
 * Resolving is the correct stub behaviour: the queue, retry policy,
 * dead-letter path and opt-out checks are real, so everything above this line
 * can be exercised end to end without a provider account.
 */
@Injectable()
export class LoggingNotificationDeliveryGateway implements NotificationDeliveryGateway {
  private readonly logger = new Logger(LoggingNotificationDeliveryGateway.name);

  deliver(delivery: NotificationDelivery): Promise<void> {
    this.logger.log(
      `[${delivery.channel} stub] to ${maskRecipient(delivery.recipient)}: ${delivery.title || delivery.body}`,
    );
    return Promise.resolve();
  }
}

/**
 * Masks a recipient for logs.
 *
 * A delivery log is not an audit trail and should not become a directory of
 * every customer's phone number and email address. Enough is kept to debug a
 * support ticket ("was it *@example.com?") without writing the full value to
 * every log sink.
 */
export function maskRecipient(recipient: string): string {
  const trimmed = recipient.trim();
  const at = trimmed.indexOf('@');
  if (at > 0) {
    const name = trimmed.slice(0, at);
    const domain = trimmed.slice(at + 1);
    const visible = name.slice(0, Math.min(2, name.length));
    return `${visible}***@${domain}`;
  }
  if (trimmed.length <= 4) {
    return '***';
  }
  return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
}

/** Used by the service when building the generic delivery payload. */
export function deliveryFor(
  channel: NotificationChannelName,
  recipient: string,
  message: NotificationMessage,
): NotificationDelivery {
  return {
    channel,
    recipient,
    title: message.title,
    body: message.body,
    data: message.data ?? {},
  };
}
