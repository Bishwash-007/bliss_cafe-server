import { EmailChannel } from './email.channel';
import type { NotificationDeliveryGateway } from './notification-delivery.gateway';
import { NotificationFactory } from './notification.factory';
import { PushChannel } from './push.channel';
import { SmsChannel } from './sms.channel';

describe('NotificationFactory', () => {
  const delivery = {
    deliver: jest.fn<
      Promise<void>,
      [Parameters<NotificationDeliveryGateway['deliver']>[0]]
    >(),
  } satisfies NotificationDeliveryGateway;

  const sms = new SmsChannel(delivery);
  const email = new EmailChannel(delivery);
  const push = new PushChannel(delivery);
  const factory = new NotificationFactory(sms, email, push);

  it('creates the concrete channel for each supported name', () => {
    expect(factory.create('sms')).toBeInstanceOf(SmsChannel);
    expect(factory.create('email')).toBeInstanceOf(EmailChannel);
    expect(factory.create('push')).toBeInstanceOf(PushChannel);
  });

  it('lists its channels in a stable order', () => {
    expect(factory.supportedChannels).toEqual(['sms', 'email', 'push']);
  });

  it('rejects an unknown channel instead of guessing', () => {
    expect(() => factory.create('fax')).toThrow(
      /Unsupported notification channel/,
    );
    expect(() => factory.create('')).toThrow(
      /Unsupported notification channel/,
    );
  });
});
