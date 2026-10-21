import { BadRequestException } from '@nestjs/common';
import type { NotificationMessage } from '../notification.types';

/**
 * Message validation shared by every channel.
 *
 * A blank body can be queued by a listener bug, and discovering it after three
 * retries (or worse, at the provider) hides the real mistake. Rejecting it
 * before enqueue is cheaper and produces a clear error in the logs; a job that
 * still slips through fails fast in the worker instead of burning retries.
 */
export function assertNotificationMessage(
  message: NotificationMessage,
  options: { requireTitle: boolean },
): void {
  if (!message || typeof message.body !== 'string' || !message.body.trim()) {
    throw new BadRequestException('Notification body must not be empty.');
  }
  if (options.requireTitle) {
    if (typeof message.title !== 'string' || !message.title.trim()) {
      throw new BadRequestException('Notification title must not be empty.');
    }
  }
}
