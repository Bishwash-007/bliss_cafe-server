import { EmailChannel } from './email.channel';
import type { NotificationChannel } from './notification-channel.interface';
import type { NotificationDeliveryGateway } from './notification-delivery.gateway';
import { PushChannel } from './push.channel';
import { SmsChannel } from './sms.channel';

/**
 * The shared channel contract.
 *
 * The brief asks that every channel expose the SAME method signature and the
 * same return type. Repeating tests per class is not enough — a future channel
 * could pass its own tests while breaking the contract every caller relies on.
 * This suite runs the identical assertions against every implementation.
 */
function gateway() {
  const deliver = jest.fn<
    Promise<void>,
    [Parameters<NotificationDeliveryGateway['deliver']>[0]]
  >();
  deliver.mockResolvedValue(undefined);
  return { deliver } satisfies NotificationDeliveryGateway;
}

const MESSAGE = {
  title: 'Your order is ready',
  body: 'Order #1234 is ready. It is ready for pickup.',
  data: { orderId: 'order-1' },
};

interface ChannelCase {
  name: string;
  channel: NotificationChannel;
  recipient: string;
  invalidRecipient: string;
}

describe('NotificationChannel implementations', () => {
  let delivery: ReturnType<typeof gateway>;
  let cases: ChannelCase[];

  beforeEach(() => {
    delivery = gateway();
    cases = [
      {
        name: 'SmsChannel',
        channel: new SmsChannel(delivery),
        recipient: ' +977 980-0000000 ',
        invalidRecipient: 'not a phone',
      },
      {
        name: 'EmailChannel',
        channel: new EmailChannel(delivery),
        recipient: ' asha@example.test ',
        invalidRecipient: 'asha@',
      },
      {
        name: 'PushChannel',
        channel: new PushChannel(delivery),
        recipient: ' device-token-123 ',
        invalidRecipient: 'device token with spaces',
      },
    ];
  });

  describe.each([
    ['SmsChannel', 0],
    ['EmailChannel', 1],
    ['PushChannel', 2],
  ] as const)('%s', (_label, index) => {
    it('exposes the shared send(recipient, message): Promise<void> contract', async () => {
      const { channel, recipient } = cases[index];

      expect(typeof channel.send).toBe('function');
      expect(channel.send.length).toBe(2);
      await expect(channel.send(recipient, MESSAGE)).resolves.toBeUndefined();
    });

    it('passes the trimmed recipient and message to the gateway', async () => {
      const { channel, recipient } = cases[index];

      await channel.send(recipient, MESSAGE);

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(delivery.deliver).toHaveBeenCalledWith({
        channel: channel.name,
        recipient: recipient.trim(),
        title: MESSAGE.title,
        body: MESSAGE.body,
        data: MESSAGE.data,
      });
    });

    it('rejects a recipient that the channel cannot deliver to', async () => {
      const { channel, invalidRecipient } = cases[index];

      await expect(channel.send(invalidRecipient, MESSAGE)).rejects.toThrow(
        /Invalid .* recipient/,
      );
      expect(delivery.deliver).not.toHaveBeenCalled();
    });

    it('rejects an empty body before it reaches the gateway', async () => {
      const { channel, recipient } = cases[index];

      await expect(
        channel.send(recipient, { ...MESSAGE, body: '   ' }),
      ).rejects.toThrow(/body must not be empty/);
      expect(delivery.deliver).not.toHaveBeenCalled();
    });
  });

  it('requires a title for the channels that render one', async () => {
    for (const index of [1, 2]) {
      const { channel, recipient } = cases[index];
      await expect(
        channel.send(recipient, { ...MESSAGE, title: '' }),
      ).rejects.toThrow(/title must not be empty/);
    }

    // SMS has no subject line; a missing title is not an error there.
    await expect(
      cases[0].channel.send(cases[0].recipient, { ...MESSAGE, title: '' }),
    ).resolves.toBeUndefined();
  });
});
