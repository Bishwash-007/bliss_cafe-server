import { Injectable } from '@nestjs/common';
import type { NotificationAdapter } from '../channels/notification-channel.interface';
import type { NotificationChannelName } from '../notification.types';
import { EmailAdapter } from './email.adapter';
import { SmsAdapter } from './sms.adapter';
import { PushAdapter } from './push.adapter';

@Injectable()
export class NotificationAdapterFactory {
  constructor(
    private readonly emailAdapter: EmailAdapter,
    private readonly smsAdapter: SmsAdapter,
    private readonly pushAdapter: PushAdapter,
  ) {}

  getAdapter(channel: NotificationChannelName): NotificationAdapter {
    if (channel === 'email') {
      return this.emailAdapter;
    }
    if (channel === 'sms') {
      return this.smsAdapter;
    }
    if (channel === 'push') {
      return this.pushAdapter;
    }
    throw new Error(`No adapter configured for channel: ${channel as string}`);
  }
}
