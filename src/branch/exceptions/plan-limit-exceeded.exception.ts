import { ConflictException } from '@nestjs/common';

/** Thrown when creating a branch would exceed the tenant plan's max_branches. */
export class PlanLimitExceededException extends ConflictException {
  constructor(limit: number) {
    super(
      `Branch limit reached: the tenant plan allows a maximum of ${limit} active branch(es)`,
    );
  }
}
