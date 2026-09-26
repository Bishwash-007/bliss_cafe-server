import type { CreateCategoryDto } from './create-category.dto';
import type { CreateItemInputDto } from './create-item.dto';
import type { PackagedModifierDto } from './packaged-modifier.dto';

/**
 * Single import surface for the menu write payloads. The per-file DTOs stay
 * tiny plain interfaces (this project runs no `class-validator` pipe), and this
 * barrel is what `menu.service.ts` / `menu.controller.ts` import so the set of
 * accepted payloads is visible in one place.
 */
export type { CreateCategoryDto, PackagedModifierDto };

/** Aliased to the name the service + controller speak in. */
export type CreateItemDto = CreateItemInputDto;

/** Soft-delete of an item is just flipping availability — the row survives. */
export interface SetItemAvailabilityDto {
  isAvailable: boolean;
}

/** Partial edit of an existing item (the service forwards it to the repo). */
export type UpdateItemDto = Partial<CreateItemDto>;
