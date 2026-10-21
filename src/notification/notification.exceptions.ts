import {
  BadRequestException,
  UnprocessableEntityException,
} from '@nestjs/common';

/** A channel name the factory does not know (a corrupted job, stale code). */
export class UnsupportedNotificationChannelException extends UnprocessableEntityException {
  constructor(channel: unknown) {
    super(`Unsupported notification channel: ${String(channel)}`);
  }
}

/** A recipient that cannot possibly be delivered to by the chosen channel. */
export class InvalidNotificationRecipientException extends BadRequestException {
  constructor(channel: string, reason: string) {
    super(`Invalid ${channel} recipient: ${reason}`);
  }
}
