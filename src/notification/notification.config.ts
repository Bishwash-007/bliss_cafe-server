import { Logger } from '@nestjs/common';
import type { NotificationQueueDriver } from './notification.types';

/**
 * Retry policy shared by the BullMQ driver and the in-memory fallback.
 *
 * `attempts` counts TOTAL attempts, not retries: 3 means the first try plus two
 * retries. `backoffMs` is the delay after the first failure; subsequent delays
 * double (exponential backoff), which is exactly what BullMQ's `exponential`
 * strategy does and what the memory driver reproduces.
 */
export interface NotificationRetryPolicy {
  readonly attempts: number;
  readonly backoffMs: number;
}

export interface NotificationQueueConfig {
  readonly driver: NotificationQueueDriver;
  readonly redisUrl: string | null;
  readonly queueName: string;
  readonly deadLetterQueueName: string;
  readonly retry: NotificationRetryPolicy;
}

export const DEFAULT_NOTIFICATION_QUEUE = 'notifications';
export const DEFAULT_NOTIFICATION_DLQ = 'notifications-dlq';
export const DEFAULT_NOTIFICATION_ATTEMPTS = 3;
export const DEFAULT_NOTIFICATION_BACKOFF_MS = 5_000;

const logger = new Logger('NotificationConfig');

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      `Ignoring invalid notification setting "${value}"; using ${fallback}.`,
    );
    return fallback;
  }
  return parsed;
}

/**
 * Reads the queue configuration once, when the module is constructed.
 *
 * ## Redis is required in production, optional in development
 *
 * With `REDIS_URL` set, notifications use BullMQ: jobs survive an API restart,
 * retries and dead letters are shared by every replica, and a send never runs
 * on the request that triggered it. That is the intended production mode.
 *
 * Without it, the module falls back to `InMemoryNotificationQueue`. That keeps
 * `npm test`, a fresh clone and single-process local development working
 * without Redis, while preserving the same retry/dead-letter semantics inside
 * that one process. The fallback is NOT durable: a restart drops queued work,
 * and two replicas each have their own queue. The module logs which driver it
 * chose so that is visible at boot.
 */
export function readNotificationQueueConfig(
  env: NodeJS.ProcessEnv = process.env,
): NotificationQueueConfig {
  const redisUrl = env.REDIS_URL?.trim() || null;
  const attempts = Math.max(
    1,
    positiveInteger(
      env.NOTIFICATION_RETRY_ATTEMPTS,
      DEFAULT_NOTIFICATION_ATTEMPTS,
    ),
  );
  const backoffMs = Math.max(
    1,
    positiveInteger(
      env.NOTIFICATION_RETRY_BACKOFF_MS,
      DEFAULT_NOTIFICATION_BACKOFF_MS,
    ),
  );

  return {
    driver: redisUrl ? 'bullmq' : 'memory',
    redisUrl,
    queueName:
      env.NOTIFICATION_QUEUE_NAME?.trim() || DEFAULT_NOTIFICATION_QUEUE,
    deadLetterQueueName:
      env.NOTIFICATION_DLQ_NAME?.trim() || DEFAULT_NOTIFICATION_DLQ,
    retry: { attempts, backoffMs },
  };
}
