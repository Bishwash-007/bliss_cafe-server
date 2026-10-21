import {
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Inventory HTTP payloads.
 *
 * The decorators reject malformed JSON; the inventory service still owns the
 * *business* rules (is this adjustment an explanation, or a typo?) because
 * those are testable without HTTP.
 */

export class CreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  contactEmail?: string | null;
}

/**
 * A partial supplier change.
 *
 * Omit a field to leave it alone; send `null` to clear it. The distinction is
 * preserved all the way down — the controller forwards only the keys present in
 * the body, and the repository writes only those columns.
 */
export class UpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  contactEmail?: string | null;
}

export class CreateInventoryItemDto {
  @IsString()
  @IsNotEmpty()
  branchId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(150)
  name!: string;

  /** `kg`, `l`, `pcs`, ... Kept free-form, as the schema is. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  unit!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  quantityOnHand?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000000)
  reorderThreshold?: number;

  @IsOptional()
  @IsString()
  supplierId?: string | null;
}

export class UpdateReorderThresholdDto {
  @IsNumber()
  @Min(0)
  @Max(1000000)
  reorderThreshold!: number;
}

/**
 * Receiving a delivery.
 *
 * `quantity` is the counted amount that just arrived, and it is required. `POST
 * /inventory/items/:id/stock-in` with the counted quantity, and `adjust` with a
 * signed delta, are the two write paths.
 *
 * There is deliberately NO `supplierId` here even though an item has a standing
 * supplier. `stock_movements` has no `supplier_id` column, so a per-delivery
 * supplier has nowhere to be stored, and accepting the field and dropping it
 * would tell a client their override was recorded when it was not. Who actually
 * delivered goes in `note`. See `StockInInput` for the full reasoning.
 */
export class StockInDto {
  @IsNumber()
  quantity!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string | null;
}

/**
 * A signed correction, for stocktakes: positive when the count came out higher
 * than the system said, negative when it came out lower.
 *
 * `note` is REQUIRED (a non-empty string) on this one and only this one, because
 * a silent adjustment is unauditable — it changes the number without saying why,
 * and a branch whose books keep drifting has no way to find the cause. Reusing
 * `wastage` for a stocktake correction would be worse: it would report spoilage
 * that never happened.
 */
export class AdjustStockDto {
  /** Signed delta. Must not be zero: a zero "adjustment" is a no-op on the books. */
  @IsNumber()
  quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  note!: string;
}

export class SetRecipeIngredientDto {
  @IsString()
  @IsNotEmpty()
  menuItemId!: string;

  @IsString()
  @IsNotEmpty()
  inventoryItemId!: string;

  /** How much of the item one unit of the menu item consumes. */
  @IsNumber()
  @Min(0)
  @Max(1000000)
  quantityUsed!: number;
}

export class ListDiscrepanciesQueryDto {
  /**
   * Defaults to the review queue (`failed` + `partial`). Pass an explicit status
   * to include the settled rows.
   */
  @IsOptional()
  @IsString()
  status?: 'pending' | 'completed' | 'partial' | 'failed';
}
