import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';

/**
 * Inventory-domain failures, each a distinct class so a caller can branch on the
 * exact reason a write was refused instead of matching on message text. Mirrors
 * `src/order/exceptions/order.exceptions.ts`.
 */

/** The inventory item does not exist for this tenant (or the tenant cannot see it). */
export class InventoryItemNotFoundException extends NotFoundException {
  constructor(itemId: string) {
    super(`Inventory item ${itemId} was not found for this tenant`);
  }
}

export class SupplierNotFoundException extends NotFoundException {
  constructor(supplierId: string) {
    super(`Supplier ${supplierId} was not found for this tenant`);
  }
}

/**
 * A quantity that cannot be stored: negative where only a magnitude makes sense,
 * zero where a movement would be a no-op, or not a number at all.
 *
 * A 400 and not a 422 — from the client's point of view the body is malformed,
 * and Nest's own validation failures are 400s too, so a client only has to handle
 * one class of "you sent me nonsense".
 */
export class InvalidQuantityException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid quantity: ${reason}`);
  }
}

/**
 * A recipe was set for a menu item that does not exist, or an ingredient pointed
 * at a non-existent inventory item.
 *
 * Worth its own class because it means the RECIPE is wrong, not the request — the
 * caller needs to know a stocktake is involved in fixing it, not a client retry.
 */
export class RecipeNotFoundException extends NotFoundException {
  constructor(detail: string) {
    super(`Recipe cannot be saved: ${detail}`);
  }
}

/**
 * A supplier still has inventory items pointing at it, so it cannot be deleted.
 *
 * The foreign key is `REFERENCES suppliers(id)` with no `ON DELETE` clause, which
 * PostgreSQL treats as `NO ACTION`: the delete is refused while any item still
 * names this supplier. That is checked here and reported as a 409 rather than
 * left to the database, because the raw failure would arrive as a 500 with a
 * driver message, telling the caller nothing about what to do.
 *
 * The resolution is deliberately the caller's to make — reassign the items, or
 * null out the link — because this module will not guess which of the two the
 * business wants.
 */
export class SupplierInUseException extends ConflictException {
  constructor(supplierId: string, itemCount: number) {
    super(
      `Supplier ${supplierId} still supplies ${itemCount} inventory ` +
        `item${itemCount === 1 ? '' : 's'} and cannot be deleted. Reassign those ` +
        `items' supplier, or clear the link, then delete the supplier.`,
    );
  }
}

/**
 * A branch-scoped caller reached for stock belonging to another branch.
 *
 * Tenant isolation is enforced everywhere by RLS, and it is NOT enough here: a
 * `branch_manager` of branch A is inside the same tenant as branch B, so RLS
 * happily lets them read and write B's stock. Two managers in one cafe would then
 * be editing each other's inventory, and neither set of numbers would look wrong
 * until the flour ran out.
 *
 * A 403 rather than a 404, deliberately. The item is in the caller's own tenant
 * and they could legitimately be told it exists, so hiding it would only make the
 * error confusing — and unlike the cross-tenant case, there is nothing here to
 * leak. What is refused is the ACTION, not the knowledge.
 *
 * An `org_owner` or `super_admin` carries no branch in their token and is
 * therefore not refused; see `InventoryActor`.
 */
export class BranchAccessDeniedException extends ForbiddenException {
  constructor(what: string, callerBranchId: string, targetBranchId: string) {
    super(
      `${what} belongs to branch ${targetBranchId}, and this request is scoped ` +
        `to branch ${callerBranchId}. A branch manager may only work with their ` +
        `own branch's stock.`,
    );
  }
}
