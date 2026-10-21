import type { Job } from 'bullmq';
import type { NotificationProcessor } from './notification.processor';
import {
  BullNotificationQueue,
  hasExhaustedAttempts,
  notificationJobId,
  retryOptions,
} from './bullmq-notification.queue';
import type { NotificationJob } from '../notification.types';

function job(): NotificationJob {
  return {
    tenantId: 'tenant-1',
    channel: 'email',
    recipient: 'manager@cafe.test',
    message: { title: 'Low stock: Milk', body: 'Milk is out of stock.' },
    eventKey: 'inventory-low-stock:item-1:movement-1:manager-1',
    source: 'inventory.low_stock',
    context: { inventoryItemId: 'item-1' },
    enqueuedAt: '2026-10-21T12:00:00.000Z',
  };
}

describe('BullMQ notification policy', () => {
  it('configures three attempts with exponential backoff by default', () => {
    expect(retryOptions({ attempts: 3, backoffMs: 5_000 })).toEqual({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000 },
    });
  });

  it('treats only the final attempt as exhausted', () => {
    const at = (attemptsMade: number, attempts: number) =>
      ({ attemptsMade, opts: { attempts } }) as Pick<
        Job,
        'attemptsMade' | 'opts'
      >;

    expect(hasExhaustedAttempts(at(1, 3))).toBe(false);
    expect(hasExhaustedAttempts(at(2, 3))).toBe(false);
    expect(hasExhaustedAttempts(at(3, 3))).toBe(true);
    expect(hasExhaustedAttempts(at(1, 1))).toBe(true);
  });

  it('builds a colon-free, deterministic BullMQ job id from the event key', () => {
    const first = notificationJobId('order-ready:order-1:sms');
    const second = notificationJobId('order-ready:order-1:sms');

    expect(first).toBe(second);
    expect(first).not.toContain(':');
    expect(first).toMatch(/^order-ready-order-1-sms-[0-9a-f]{10}$/);
    expect(notificationJobId('order-ready:order-2:sms')).not.toBe(first);
    // Two keys that sanitise to the same slug still differ because of the hash.
    expect(notificationJobId('a:b')).not.toBe(notificationJobId('a-b'));
  });
});

/**
 * Real-Redis proof that retries and DLQ are not just configuration.
 *
 * Skipped unless REDIS_URL is set, so the default unit run needs no server.
 * Run it with:
 *   REDIS_URL=redis://localhost:6379 npx jest src/notification/queue
 */
const redisUrl = process.env.REDIS_URL?.trim();
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('BullNotificationQueue (Redis integration)', () => {
  jest.setTimeout(30_000);

  it('retries the configured number of times and then copies the job to the DLQ', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const process = jest.fn<Promise<void>, [NotificationJob]>();
    process.mockRejectedValue(new Error('provider down'));

    const queue = new BullNotificationQueue({
      redisUrl: redisUrl!,
      queueName: `notifications-test-${suffix}`,
      deadLetterQueueName: `notifications-dlq-test-${suffix}`,
      retry: { attempts: 3, backoffMs: 20 },
      processor: { process } as unknown as NotificationProcessor,
    });

    try {
      await queue.start();
      await queue.enqueue(job());

      const entries = await waitFor(async () => {
        const found = await queue.listDeadLetters('tenant-1', 10);
        return found.length > 0 ? found : null;
      });

      expect(process).toHaveBeenCalledTimes(3);
      expect(entries[0]).toMatchObject({
        failedReason: 'provider down',
        attemptsMade: 3,
        job: job(),
      });
      await expect(queue.listDeadLetters('tenant-2', 10)).resolves.toEqual([]);
    } finally {
      await queue.obliterate().catch(() => undefined);
      await queue.close();
    }
  });

  it('dedupes a second job with the same event key', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const process = jest.fn<Promise<void>, [NotificationJob]>();
    process.mockResolvedValue(undefined);

    const queue = new BullNotificationQueue({
      redisUrl: redisUrl!,
      queueName: `notifications-test-${suffix}`,
      deadLetterQueueName: `notifications-dlq-test-${suffix}`,
      retry: { attempts: 1, backoffMs: 20 },
      processor: { process } as unknown as NotificationProcessor,
    });

    try {
      await queue.start();
      const first = await queue.enqueue(job());
      const second = await queue.enqueue(job());

      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      await waitFor(() => (process.mock.calls.length >= 1 ? true : null));
      // Give a would-be second delivery time to show up.
      await sleep(150);
      expect(process).toHaveBeenCalledTimes(1);
    } finally {
      await queue.obliterate().catch(() => undefined);
      await queue.close();
    }
  });
});

async function waitFor<T>(
  check: () => T | null | Promise<T | null>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== null) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error('Timed out waiting for the notification queue.');
    }
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
