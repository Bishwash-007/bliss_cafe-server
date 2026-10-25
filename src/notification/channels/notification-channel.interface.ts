import type {
  NotificationChannelName,
  NotificationMessage,
} from '../notification.types';

export type DeliveryStatus =
  'delivered' | 'pending' | 'failed' | 'bounced' | 'complained';

export interface DeliveryResult {
  status: DeliveryStatus;
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

/**
 * The one contract every transport implements.
 *
 * A listener, the queue processor and the factory all speak this interface and
 * nothing else. Adding a WhatsApp channel means adding a class and one factory
 * entry; no caller changes, and no caller starts branching on channel name.
 *
 * Implementations validate their own recipient because "a phone number" and
 * "a device token" are channel-specific facts. They do NOT know about retries,
 * opt-outs or tenants — those are pipeline concerns, handled once before a job
 * is enqueued.
 */
export interface NotificationChannel {
  readonly name: NotificationChannelName;
  send(
    recipient: string,
    message: NotificationMessage,
  ): Promise<void | DeliveryResult>;
}

export interface NotificationAdapter {
  readonly name: string;
  readonly channel: NotificationChannelName;
  send(
    recipient: string,
    message: NotificationMessage,
    context?: Record<string, string>,
  ): Promise<DeliveryResult>;
}
