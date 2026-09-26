/**
 * Row and domain shapes for inventory.
 *
 * `NUMERIC(12,3)` columns arrive from `pg` as STRINGS, deliberately: Postgres
 * `NUMERIC` is arbitrary-precision and `pg` refuses to guess a JS number is big
 * enough. Every shape here exposes quantities as `number`, and the repository is
 * the single place that converts — so no arithmetic anywhere else in the module
 * has to remember that Postgres handed it a string.
 *
 * Quantities are carried at the column's 3 decimal places. `roundQuantity` exists
 * so a computed value is snapped to the same grid the database uses, instead of
 * accumulating binary-float drift (`0.1 * 3 === 0.30000000000000004`) into a
 * `NUMERIC(12,3)` column that will quietly round it anyway — but differently on
 * every platform.
 */

/** Quantities are stored to 3 decimal places (`NUMERIC(12,3)`). */
export const QUANTITY_SCALE = 3;

/** Multiplier for converting to integer thousandths without float error. */
const THOUSAND = 1000;

/**
 * Snaps a value to the `NUMERIC(12,3)` grid.
 *
 * Rounds half away from zero (`.5` up in magnitude), which is what a human doing
 * stocktake arithmetic expects, rather than JS's banker's rounding.
 */
export function roundQuantity(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite quantity: ${value}`);
  }
  // `Math.round(-0.5)` is -0, so the sign is handled explicitly: a deduction of
  // -0.5 must become -1, not -0.
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * THOUSAND)) / THOUSAND;
}

/** Postgres `NUMERIC` (string) -> JS number, snapped to the quantity grid. */
export function quantity(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return roundQuantity(Number(value));
}

/** JS number -> Postgres `NUMERIC` literal. Kept explicit at the SQL boundary. */
export function toNumeric(value: number): number {
  return roundQuantity(value);
}

export interface SupplierRow {
  id: string;
  tenant_id: string;
  name: string;
  contact_phone: string | null;
  contact_email: string | null;
  created_at: Date;
}

export interface InventoryItemRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  name: string;
  unit: string;
  quantity_on_hand: string;
  reorder_threshold: string;
  supplier_id: string | null;
  created_at: Date;
}

/** An inventory item as the domain sees it: quantities already numbers. */
export interface InventoryItem {
  id: string;
  tenantId: string;
  branchId: string;
  name: string;
  /** `kg`, `l`, `pcs`, ... free-form, from the schema. */
  unit: string;
  quantityOnHand: number;
  reorderThreshold: number;
  supplierId: string | null;
}

export interface RecipeIngredientRow {
  id: string;
  tenant_id: string;
  menu_item_id: string;
  inventory_item_id: string;
  quantity_used: string;
}

export interface StockMovementRow {
  id: string;
  tenant_id: string;
  inventory_item_id: string;
  movement_type: string;
  quantity: string;
  reference_order_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Date;
}

/** A stock movement as the domain sees it. */
export interface StockMovement {
  id: string;
  inventoryItemId: string;
  movementType: StockMovementType;
  /** Positive = stock in, negative = stock out. */
  quantity: number;
  referenceOrderId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

/** Mirrors the `movement_type` check in `db/migrations/007_inventory.sql`. */
export const STOCK_MOVEMENT_TYPES = [
  'purchase',
  'usage',
  'wastage',
  'adjustment',
] as const;

export type StockMovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

export function isStockMovementType(
  value: unknown,
): value is StockMovementType {
  return (
    typeof value === 'string' &&
    (STOCK_MOVEMENT_TYPES as readonly string[]).includes(value)
  );
}

/** Ledger status for one order's deduction. See migration 012. */
export const DEDUCTION_STATUSES = [
  'pending',
  'completed',
  'partial',
  'failed',
] as const;

export type DeductionStatus = (typeof DEDUCTION_STATUSES)[number];

export interface DeductionRow {
  id: string;
  tenant_id: string;
  order_id: string;
  status: DeductionStatus;
  detail: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Who is asking, and how far they may reach.
 *
 * `branchId: null` means NOT branch-scoped — the caller may work with any branch in
 * their tenant. A non-null `branchId` is the branch the caller is responsible for,
 * and they may not read or write another branch's stock.
 *
 * That scope is decided by the caller's ROLE, not by whether their token happens to
 * carry a branch. Onboarding creates the `org_owner` against the tenant's default
 * branch, so an org owner's token has a `branchId` even though the role runs the
 * whole org; treating "has a branch" as "confined to it" would lock the owner out
 * of every branch but the first. `branch_manager` is the role that is confined.
 *
 * Passed explicitly rather than read from a request context so the service stays a
 * singleton usable from the event subscriber, and so the check happens at the layer
 * that owns the data rather than only at the HTTP edge.
 */
export interface InventoryActor {
  readonly branchId: string | null;
}

export interface CreateSupplierInput {
  name: string;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

/**
 * A partial supplier change.
 *
 * An absent key means "leave this column alone"; an explicit `null` means "clear
 * it". The repository builds its `SET` list from the keys that are actually
 * present, which is the only way to honour both — `COALESCE` can express the
 * first but silently turns the second into "leave alone".
 */
export interface UpdateSupplierInput {
  name?: string | null;
  contactPhone?: string | null;
  contactEmail?: string | null;
}

export interface CreateInventoryItemInput {
  branchId: string;
  name: string;
  unit: string;
  quantityOnHand?: number;
  reorderThreshold?: number;
  supplierId?: string | null;
}

export interface UpsertRecipeIngredientInput {
  menuItemId: string;
  inventoryItemId: string;
  quantityUsed: number;
}

/**
 * A delivery's extra detail.
 *
 * There is deliberately NO `supplierId` here. An earlier version of this type
 * carried one, documented as crediting a supplier that differed from the item's
 * standing supplier — but `stock_movements` has no `supplier_id` column, so the
 * value had nowhere to go and the HTTP layer accepted and silently discarded it.
 * An accepted-and-ignored field is worse than an absent one: the API claimed a
 * capability it did not have.
 *
 * Recording a per-delivery supplier needs a `supplier_id` column on
 * `stock_movements` (a new migration, not a change to an applied one). Until that
 * exists, an item's supplier is the single source of truth — see
 * `CreateInventoryItemInput.supplierId` — and who actually delivered is captured
 * as free text in `note`, which is what a delivery note is for.
 */
export interface StockInInput {
  /** Free-text detail: the delivery note number, carrier, and so on. */
  note?: string | null;
}

export interface AdjustInput {
  note?: string | null;
}
