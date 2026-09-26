import { NotFoundException } from '@nestjs/common';

/**
 * Menu lookups fail as 404s. Kept as dedicated classes (instead of a bare
 * `NotFoundException`) so callers — and the controller layer — can branch on the
 * exact reason a menu write was rejected without string-matching messages.
 */
export class MenuCategoryNotFoundException extends NotFoundException {
  constructor(categoryId: string) {
    super(`Menu category ${categoryId} was not found for this tenant`);
  }
}

export class MenuItemNotFoundException extends NotFoundException {
  constructor(itemId: string) {
    super(`Menu item ${itemId} was not found for this tenant`);
  }
}
