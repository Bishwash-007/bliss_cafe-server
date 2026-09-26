import { NotFoundException } from '@nestjs/common';

/** A table id that does not exist for this tenant (or is not a UUID at all). */
export class TableNotFoundException extends NotFoundException {
  constructor(tableId: string) {
    super(`Table ${tableId} was not found for this tenant`);
  }
}
