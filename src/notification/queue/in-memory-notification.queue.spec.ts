import type { NotificationJob } from '../notification.types';
import { InMemoryNotificationQueue } from './in-memory-notification.queue';
function job(overrides: Partial<NotificationJob> = {}): NotificationJob {
  return {
    tenantId: 'tenant-1',
    channel: 'sms',
    recipient: '9800000000',
    message: { title: 'Ready', body: 'Your order is ready.' },
    eventKey: 'order-ready:order-1:sms',
    source: 'order.ready',
    context: { orderId: 'order-1' },
    enqueuedAt: '2026-10-21T12:00:00.000Z',
    ...overrides,
  };
}

function processor() {
  return {
    process: jest.fn<Promise<void>, [NotificationJob]>(),
  };
}

describe('InMemoryNotificationQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('runs a successful send off the enqueue call and keeps no dead letter', async () => {
    const send = processor();
    send.process.mockResolvedValue(undefined);
    const queue = new InMemoryNotificationQueue(send as never, {
      attempts: 3,
      backoffMs: 100,
    });

    const receipt = await queue.enqueue(job());
    expect(receipt).toMatchObject({ driver: 'memory', duplicate: false });
    // Not sent inline.
    expect(send.process).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(0);

    expect(send.process).toHaveBeenCalledTimes(1);
    expect(send.process).toHaveBeenCalledWith(job());
    await expect(queue.listDeadLetters('tenant-1', 10)).resolves.toEqual([]);
    expect(queue.deadLetterCount).toBe(0);
  });

  it('retries with exponential backoff and dead-letters after the final attempt', async () => {
    const send = processor();
    send.process.mockRejectedValue(new Error('provider down'));
    const queue = new InMemoryNotificationQueue(send as never, {
      attempts: 3,
      backoffMs: 100,
    });

    await queue.enqueue(job());

    await jest.advanceTimersByTimeAsync(0);
    expect(send.process).toHaveBeenCalledTimes(1);

    // The first retry waits the base delay, not zero.
    await jest.advanceTimersByTimeAsync(99);
    expect(send.process).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(send.process).toHaveBeenCalledTimes(2);

    // The second retry waits twice the base delay.
    await jest.advanceTimersByTimeAsync(199);
    expect(send.process).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(send.process).toHaveBeenCalledTimes(3);

    const deadLetters = await queue.listDeadLetters('tenant-1', 10);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      id: 'order-ready:order-1:sms',
      failedReason: 'provider down',
      attemptsMade: 3,
    });
    expect(deadLetters[0].job).toEqual(job());
  });

  it('treats a duplicate event key as a no-op', async () => {
    const send = processor();
    send.process.mockResolvedValue(undefined);
    const queue = new InMemoryNotificationQueue(send as never, {
      attempts: 3,
      backoffMs: 100,
    });

    const first = await queue.enqueue(job());
    const second = await queue.enqueue(job());
    await jest.advanceTimersByTimeAsync(0);

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(send.process).toHaveBeenCalledTimes(1);
  });

  it('filters dead letters by tenant', async () => {
    const send = processor();
    send.process.mockRejectedValue(new Error('nope'));
    const queue = new InMemoryNotificationQueue(send as never, {
      attempts: 1,
      backoffMs: 1,
    });

    await queue.enqueue(job({ tenantId: 'tenant-1', eventKey: 'a' }));
    await queue.enqueue(job({ tenantId: 'tenant-2', eventKey: 'b' }));
    await jest.advanceTimersByTimeAsync(0);

    await expect(queue.listDeadLetters('tenant-1', 10)).resolves.toHaveLength(
      1,
    );
    await expect(queue.listDeadLetters('tenant-2', 10)).resolves.toHaveLength(
      1,
    );
    await expect(queue.listDeadLetters('tenant-3', 10)).resolves.toEqual([]);
  });

  it('clears pending retries when the module shuts down', async () => {
    const send = processor();
    send.process.mockRejectedValue(new Error('still down'));
    const queue = new InMemoryNotificationQueue(send as never, {
      attempts: 3,
      backoffMs: 100,
    });

    await queue.enqueue(job());
    await jest.advanceTimersByTimeAsync(0);
    await queue.close();
    await jest.advanceTimersByTimeAsync(1_000);

    expect(send.process).toHaveBeenCalledTimes(1);
    await expect(
      queue.enqueue(job({ eventKey: 'after-close' })),
    ).rejects.toThrow(/closed/);
  });
});
