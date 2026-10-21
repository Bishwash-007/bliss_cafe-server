import { Injectable } from '@nestjs/common';
import { UnsupportedNotificationChannelException } from '../notification.exceptions';
import type { NotificationChannelName } from '../notification.types';
import { EmailChannel } from './email.channel';
import type { NotificationChannel } from './notification-channel.interface';
import { PushChannel } from './push.channel';
import { SmsChannel } from './sms.channel';

/**
 * Factory (GoF) — the one place that knows the concrete channels.
 *
 * Callers ask for a channel by name and get an object implementing
 * `NotificationChannel`. The queue processor, the listeners and any future
 * "send a test notification" endpoint never import `SmsChannel` directly, so a
 * new channel is a class plus one line in the map below.
 *
 * The parameter is typed as the union but checked at runtime: job data comes
 * from Redis and may have been written by an older (or newer) deploy, so a
 * union type alone would be a lie.
 */
@Injectable()
export class NotificationFactory {
  private readonly channels: Readonly<
    Record<NotificationChannelName, NotificationChannel>
  >;

  constructor(sms: SmsChannel, email: EmailChannel, push: PushChannel) {
    this.channels = { sms, email, push };
  }

  create(channel: string): NotificationChannel {
    const factory = this.channels as Readonly<
      Record<string, NotificationChannel | undefined>
    >;
    const created = factory[channel];
    if (!created) {
      throw new UnsupportedNotificationChannelException(channel);
    }
    return created;
  }

  /** The channel names this factory can create, in a stable order. */
  get supportedChannels(): readonly NotificationChannelName[] {
    return Object.keys(this.channels) as NotificationChannelName[];
  }
}
