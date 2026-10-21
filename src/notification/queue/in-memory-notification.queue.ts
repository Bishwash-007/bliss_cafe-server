import { Logger, OnModuleDestroy } from '@nestjs/common';
import type { NotificationRetryPolicy } from '../notification.config';
import type {
  NotificationDeadLetter,
  NotificationJob,
  NotificationQueueReceipt,
} from '../notification.types';
import type { NotificationQueue } from './notification.queue';
import type { NotificationProcessor } from './notification.processor';

/**
 * Single-process queue used when `REDIS_URL` is not configured.
 *
 * It is not a toy: it reproduces the BullMQ semantics the acceptance criteria
 * care about — asynchronous send, exponential backoff, a configurable attempt
 * count, dead-lettering after the last attempt, and idempotency by `eventKey`.
 * What it does NOT reproduce is durability. A restart drops queued work, and
 * two API replicas have independent queues, so it is a development/test
 * fallback only. The module logs the driver at boot so that is never a
 * surprise.
 *
 * Timers are `unref()`ed: a queued notification must not keep Jest (or a
 * shutting-down process) alive. `close()` clears them explicitly as well.
 */
export class InMemoryNotificationQueue
  implements NotificationQueue, OnModuleDestroy
{
  readonly driver = 'memory' as const;
  private readonly logger = new Logger(InMemoryNotificationQueue.name);
  private readonly deadLetters: NotificationDeadLetter[] = [];
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  /** eventKey -> whether it is still queued/running or already finished. */
  private readonly seen = new Set<string>();
  private closed = false;

  constructor(
    private readonly processor: NotificationProcessor,
    private readonly retry: NotificationRetryPolicy,
  ) {}

  enqueue(job: NotificationJob): Promise<NotificationQueueReceipt> {
    if (this.closed) {
      return Promise.reject(new Error('Notification queue is closed.'));
    }

    // A duplicate delivery of the same event is a no-op. That includes a second
    // delivery that arrives while the first is still retrying, and one that
    // arrives after it dead-lettered: redelivery must not create a second
    // dead letter for the same failure.
    if (this.seen.has(job.eventKey)) {
      return Promise.resolve({
        id: job.eventKey,
        driver: this.driver,
        duplicate: true,
      });
    }
    this.seen.add(job.eventKey);

    this.schedule(job, 1, 0);
    return Promise.resolve({
      id: job.eventKey,
      driver: this.driver,
      duplicate: false,
    });
  }

  listDeadLetters(
    tenantId: string,
    limit: number,
  ): Promise<NotificationDeadLetter[]> {
    return Promise.resolve(
      this.deadLetters
        .filter((entry) => entry.job.tenantId === tenantId)
        .slice(0, Math.max(1, Math.min(limit, 200))),
    );
  }

  close(): Promise<void> {
    this.closed = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    return Promise.resolve();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }

  /** Test/diagnostic visibility. Not part of the queue contract. */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** Test/diagnostic visibility. Not part of the queue contract. */
  get deadLetterCount(): number {
    return this.deadLetters.length;
  }

  private schedule(job: NotificationJob, attempt: number, delayMs: number) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(job, attempt);
    }, delayMs);
    // Do not hold the process open for a queued notification.
    (timer as { unref?: () => void }).unref?.();
    this.timers.add(timer);
  }

  private async attempt(job: NotificationJob, attempt: number): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      await this.processor.process(job);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (attempt >= this.retry.attempts) {
        this.deadLetters.unshift({
          id: job.eventKey,
          job,
          failedReason: reason,
          attemptsMade: attempt,
          deadLetteredAt: new Date().toISOString(),
        });
        this.logger.error(
          `Notification ${job.eventKey} exhausted ${attempt} attempts; moved to the dead-letter queue: ${reason}`,
        );
        return;
      }

      // Exponential: backoff, 2x, 4x, … after attempt 1, 2, 3, …
      const delay = this.retry.backoffMs * 2 ** (attempt - 1);
      this.logger.warn(
        `Notification ${job.eventKey} failed (attempt ${attempt}/${this.retry.attempts}); retrying in ${delay}ms: ${reason}`,
      );
      this.schedule(job, attempt + 1, delay);
    }
  }
}
