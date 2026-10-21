import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { createHash } from 'node:crypto';
import { Redis } from 'ioredis';
import type { NotificationRetryPolicy } from '../notification.config';
import type {
  NotificationDeadLetter,
  NotificationJob,
  NotificationQueueReceipt,
} from '../notification.types';
import type { NotificationQueue } from './notification.queue';
import type { NotificationProcessor } from './notification.processor';

export interface BullNotificationQueueOptions {
  readonly redisUrl: string;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly retry: NotificationRetryPolicy;
  readonly processor: NotificationProcessor;
}

/**
 * BullMQ-backed queue — the production driver.
 *
 * ## Why the dead-letter queue is a second queue
 *
 * BullMQ keeps failed jobs in a failed set, but a set is not an operationally
 * useful inbox: it is easy to prune, it has no independent retention, and
 * "everything that ever failed, including jobs that later succeeded" is a
 * different question from "what exhausted its retries and needs a human?".
 * When the worker's `failed` event reports the LAST attempt, the job is copied
 * verbatim to `notifications-dlq`, where nothing consumes it. `GET
 * /notifications/dead-letter` reads that queue, filtered by tenant.
 *
 * The copy uses the original job id as its id. If the failed event is delivered
 * twice (a worker crash between retry exhaustion and the copy, for example) the
 * second add is a no-op rather than a duplicate dead letter.
 *
 * ## Connections
 *
 * A worker uses blocking Redis commands, so it gets its own connection; the two
 * queues share a third. BullMQ requires `maxRetriesPerRequest: null` on a worker
 * connection so a temporary Redis blip retries instead of failing the job
 * permanently.
 */
export class BullNotificationQueue
  implements NotificationQueue, OnModuleInit, OnModuleDestroy
{
  readonly driver = 'bullmq' as const;
  private readonly logger = new Logger(BullNotificationQueue.name);

  private queue?: Queue<NotificationJob>;
  private deadLetterQueue?: Queue<NotificationDeadLetter>;
  private worker?: Worker<NotificationJob>;
  private queueConnection?: Redis;
  private workerConnection?: Redis;
  private started = false;
  private closed = false;

  constructor(private readonly options: BullNotificationQueueOptions) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.start();
    } catch (error) {
      // A bad Redis URL must not prevent the HTTP API from starting. Enqueues
      // will fail loudly and the listeners log them; the rest of the product
      // keeps working.
      this.logger.error(
        `Notification queue failed to start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }

  /** Idempotent; called from Nest lifecycle and from `enqueue` in tests. */
  start(): Promise<void> {
    if (this.started || this.closed) {
      return Promise.resolve();
    }
    this.started = true;

    const redisOptions = {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    };
    this.queueConnection = new Redis(this.options.redisUrl, redisOptions);
    this.workerConnection = new Redis(this.options.redisUrl, redisOptions);
    this.attachRedisErrorLogging(this.queueConnection, 'queue');
    this.attachRedisErrorLogging(this.workerConnection, 'worker');

    this.queue = new Queue<NotificationJob>(this.options.queueName, {
      connection: this.queueConnection,
    });
    this.deadLetterQueue = new Queue<NotificationDeadLetter>(
      this.options.deadLetterQueueName,
      { connection: this.queueConnection },
    );

    this.worker = new Worker<NotificationJob>(
      this.options.queueName,
      async (job) => this.options.processor.process(job.data),
      {
        connection: this.workerConnection,
        concurrency: 5,
      },
    );

    this.worker.on('failed', (job, error) => {
      if (!job || !hasExhaustedAttempts(job)) {
        return;
      }
      void this.deadLetter(job, error).catch((deadLetterError: unknown) => {
        this.logger.error(
          `Could not move notification ${job.id} to the dead-letter queue: ${
            deadLetterError instanceof Error
              ? deadLetterError.message
              : String(deadLetterError)
          }`,
        );
      });
    });

    this.worker.on('error', (error) => {
      this.logger.error(
        `Notification worker error: ${error.message}`,
        error.stack,
      );
    });

    this.logger.log(
      `Notification queue "${this.options.queueName}" using BullMQ at ${redactRedisUrl(this.options.redisUrl)}.`,
    );
    return Promise.resolve();
  }

  async enqueue(job: NotificationJob): Promise<NotificationQueueReceipt> {
    await this.start();
    const queue = this.requireQueue();
    const id = notificationJobId(job.eventKey);
    const existing = await queue.getJob(id);

    await queue.add('notification', job, {
      jobId: id,
      ...retryOptions(this.options.retry),
      // Keep completed jobs long enough that a duplicate event is still a
      // no-op, without letting the queue grow forever.
      removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
      removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
    });

    return {
      id,
      driver: this.driver,
      duplicate: existing !== undefined,
    };
  }

  async listDeadLetters(
    tenantId: string,
    limit: number,
  ): Promise<NotificationDeadLetter[]> {
    await this.start();
    const dlq = this.requireDeadLetterQueue();
    const bounded = Math.max(1, Math.min(limit, 200));

    // The DLQ is shared by every tenant and has no consumer. Fetch a generous
    // recent window, then filter in memory: BullMQ cannot index custom job data
    // fields, and a per-tenant queue would make deployment/retention worse for
    // a list that an operator reads by hand.
    const window = Math.min(Math.max(bounded * 20, 100), 1_000);
    const jobs = await dlq.getJobs(
      ['waiting', 'delayed', 'paused', 'failed', 'completed'],
      0,
      window - 1,
      false,
    );

    return jobs
      .map((job) => job.data)
      .filter((entry) => entry?.job?.tenantId === tenantId)
      .slice(0, bounded);
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;

    try {
      await this.worker?.close();
    } catch (error) {
      this.logger.warn(
        `Closing notification worker failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await this.queue?.close();
    } catch (error) {
      this.logger.warn(
        `Closing notification queue failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    try {
      await this.deadLetterQueue?.close();
    } catch (error) {
      this.logger.warn(
        `Closing notification dead-letter queue failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    this.queueConnection?.disconnect();
    this.workerConnection?.disconnect();
    this.queueConnection = undefined;
    this.workerConnection = undefined;
  }

  /** Test-only cleanup: removes the queues and every job in them. */
  async obliterate(): Promise<void> {
    await this.start();
    await this.queue?.obliterate({ force: true });
    await this.deadLetterQueue?.obliterate({ force: true });
  }

  private async deadLetter(job: Job<NotificationJob>, error: Error) {
    const dlq = this.requireDeadLetterQueue();
    const id = job.id ?? notificationJobId(job.data.eventKey);
    const entry: NotificationDeadLetter = {
      id,
      job: job.data,
      failedReason: error?.message ?? 'unknown error',
      attemptsMade: job.attemptsMade,
      deadLetteredAt: new Date().toISOString(),
    };

    // One job, one dead letter. Using the original job id means a duplicate
    // `failed` event cannot create a second entry.
    await dlq.add('dead-letter', entry, {
      jobId: id,
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    });

    this.logger.error(
      `Notification ${job.id} exhausted ${job.attemptsMade} attempts; moved to "${this.options.deadLetterQueueName}": ${entry.failedReason}`,
    );
  }

  private requireQueue(): Queue<NotificationJob> {
    if (!this.queue) {
      throw new Error('Notification queue has not been started.');
    }
    return this.queue;
  }

  private requireDeadLetterQueue(): Queue<NotificationDeadLetter> {
    if (!this.deadLetterQueue) {
      throw new Error('Notification dead-letter queue has not been started.');
    }
    return this.deadLetterQueue;
  }

  private attachRedisErrorLogging(client: Redis, role: string): void {
    client.on('error', (error: Error) => {
      this.logger.error(`Notification ${role} Redis error: ${error.message}`);
    });
  }
}

/**
 * The retry options handed to BullMQ.
 *
 * Exported so a unit test can assert the policy without Redis: 3 attempts with
 * exponential backoff is a configuration fact, and a regression here is
 * otherwise invisible until a provider outage.
 */
export function retryOptions(retry: NotificationRetryPolicy) {
  return {
    attempts: retry.attempts,
    backoff: { type: 'exponential' as const, delay: retry.backoffMs },
  };
}

/** Whether a failed job has used its final attempt. */
export function hasExhaustedAttempts(
  job: Pick<Job, 'attemptsMade' | 'opts'>,
): boolean {
  return job.attemptsMade >= (job.opts.attempts ?? 1);
}

/**
 * Maps an event key to a BullMQ job id.
 *
 * BullMQ rejects `:` in a custom job id, and our event keys are deliberately
 * readable (`order-ready:<orderId>:<channel>`). The slug keeps them readable in
 * Redis tooling; the short hash keeps two keys that differ only in punctuation
 * from colliding after sanitisation.
 */
export function notificationJobId(eventKey: string): string {
  const hash = createHash('sha1').update(eventKey).digest('hex').slice(0, 10);
  const slug = eventKey
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${slug || 'notification'}-${hash}`;
}

function redactRedisUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '***';
    }
    return parsed.toString();
  } catch {
    return 'redis';
  }
}
