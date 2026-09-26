import { ConflictException } from '@nestjs/common';

/** Thrown when a tenant slug is already taken (checked before inserts + on
 * the unique-constraint race). */
export class SlugAlreadyTakenException extends ConflictException {
  constructor(slug: string) {
    super(`The tenant slug '${slug}' is already taken`);
  }
}
