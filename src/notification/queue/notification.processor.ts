import { Injectable } from '@nestjs/common';
import { NotificationFactory } from '../channels/notification.factory';
import type { NotificationJob } from '../notification.types';

/**
 * Executes ONE delivery attempt.
 *
 * This is the seam both queue drivers share. BullMQ calls it from a worker; the
 * in-memory fallback calls it from a timer. Retries, backoff and dead-lettering
 * live in the drivers, not here: a processor that caught its own errors would
 * make BullMQ believe the job succeeded and defeat both retry and inspection.
 */
@Injectable()
export class NotificationProcessor {
  constructor(private readonly factory: NotificationFactory) {}

  async process(job: NotificationJob): Promise<void> {
    const channel = this.factory.create(job.channel);
    await channel.send(job.recipient, job.message);
  }
}
