/**
 * Inventory HTTP payloads.
 *
 * Plain interfaces, matching the menu module: this project runs no
 * `class-validator` pipe, so a "DTO" here is a documented shape and the service
 * is what rejects bad input. The type aliases at the bottom line the DTOs up with
 * the service's own input types where they are genuinely the same thing, so a
 * field can never drift between the HTTP contract and the domain.
 */

export interface CreateSupplierDto {
  name: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

/**
 * A partial supplier change.
 *
 * Omit a field to leave it alone; send `null` to clear it. The distinction is
 * preserved all the way down — the controller forwards only the keys present in
 * the body, and the repository writes only those columns.
 */
export interface UpdateSupplierDto {
  name?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

export interface CreateInventoryItemDto {
  branchId: string;
  name: string;
  /** `kg`, `l`, `pcs`, ... Kept free-form, as the schema is. */
  unit: string;
  quantityOnHand?: number;
  reorderThreshold?: number;
  supplierId?: string | null;
}

export interface UpdateReorderThresholdDto {
  reorderThreshold: number;
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
 * supplier has nowhere to be stored, and accepting the field and dropping it would
 * tell a client their override was recorded when it was not. Who actually
 * delivered goes in `note`. See `StockInInput` for the full reasoning.
 */
export interface StockInDto {
  quantity: number;
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
export interface AdjustStockDto {
  /** Signed delta. Must not be zero: a zero "adjustment" is a no-op on the books. */
  quantity: number;
  note: string;
}

export interface SetRecipeIngredientDto {
  menuItemId: string;
  inventoryItemId: string;
  /** How much of the item one unit of the menu item consumes. */
  quantityUsed: number;
}

export interface ListDiscrepanciesQueryDto {
  /**
   * Defaults to the review queue (`failed` + `partial`). Pass an explicit status
   * to include the settled rows.
   */
  status?: 'pending' | 'completed' | 'partial' | 'failed';
}
