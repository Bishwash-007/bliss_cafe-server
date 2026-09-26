import { ConflictException } from '@nestjs/common';

/** Friendly translation of the `UNIQUE (branch_id, label)` constraint. */
export class DuplicateTableLabelException extends ConflictException {
  constructor(label: string) {
    super(`A table labelled '${label}' already exists in this branch`);
  }
}
