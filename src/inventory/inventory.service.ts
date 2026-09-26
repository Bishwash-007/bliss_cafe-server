import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { ReorderStrategyRegistry } from './alerting/reorder-strategy.registry';
import {
  INVENTORY_EVENTS,
  LOW_STOCK_SEVERITY,
  type InventoryLowStockEvent,
} from './events/inventory-events';
import { InventoryRepository } from './inventory.repository';
import {
  BranchAccessDeniedException,
  InvalidQuantityException,
  InventoryItemNotFoundException,
  RecipeNotFoundException,
  SupplierInUseException,
  SupplierNotFoundException,
} from './exceptions/inventory.exceptions';
import {
  roundQuantity,
  type CreateInventoryItemInput,
  type CreateSupplierInput,
  type DeductionRow,
  type DeductionStatus,
  type InventoryActor,
  type InventoryItem,
  type StockMovement,
  type SupplierRow,
  type UpdateSupplierInput,
  type UpsertRecipeIngredientInput,
} from './inventory.types';

/** What a deduction attempt did, for the listener and the tests to assert on. */
export interface DeductionOutcome {
  readonly status: DeductionStatus;
  /**
   * True when the ledger already had a settled record, so this event was a
   * redelivery and nothing was deducted. Worth logging distinctly: a burst of
   * these means the bus is misconfigured, not that something is wrong.
   */
  readonly deduplicated: boolean;
  /** Menu items that were on the order but had no recipe, when status is partial. */
  readonly menuItemsWithoutRecipe: readonly string[];
}

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  /**
   * Note what is NOT injected: `TenantRequestContext`.
   *
   * This service is called from two places with nothing in common — an HTTP
   * controller, and an event subscriber that runs after the order's request has
   * already finished. Injecting the request context would make the service
   * request-scoped, and the deduction path would then run on an instance built
   * for a request that does not exist, quietly depending on a `tenantId` getter
   * that has nothing behind it.
   *
   * So HTTP handlers pass a connection and the tenant is read off THAT
   * connection (see `tenantOf`), while the listener — which has no request at all
   * — passes the tenant as an ordinary argument and one is acquired for it. Being
   * a plain singleton also means `app.get(InventoryService)` works, which is what
   * lets a test drive a deduction without inventing an HTTP request.
   */
  constructor(
    private readonly repository: InventoryRepository,
    private readonly connections: TenantConnectionService,
    private readonly strategies: ReorderStrategyRegistry,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
  ) {}

  /**
   * The tenant a request connection is pinned to.
   *
   * Taken from the connection rather than passed alongside it, so the value used
   * for a write can never disagree with the `app.tenant_id` the RLS policies are
   * actually enforcing.
   */
  private tenantOf(connection: TenantScopedConnection): string {
    const tenantId = connection.tenantId;
    if (tenantId === null) {
      throw new Error(
        'Inventory write requires a tenant-scoped connection, but this connection ' +
          'has no tenant pinned.',
      );
    }
    return tenantId;
  }

  /**
   * Rejects a quantity that is not a real number BEFORE it reaches the columns.
   *
   * The comparison guards below (`<= 0`, `=== 0`) all pass silently for `NaN`,
   * and JSON cannot carry `Infinity` — so without this, a `null`, a string or a
   * missing body field arrives as `NaN`, survives the guard, and then explodes
   * inside `roundQuantity` as a `RangeError`. That would surface as a 500: the
   * client's malformed input reported as the server being broken. Validating here
   * keeps every bad-quantity path a 400.
   */
  private requireFinite(value: number, message: string): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidQuantityException(message);
    }
  }

  /**
   * Refuses a branch-scoped caller reaching into another branch.
   *
   * RLS is not enough for this: two branches of one cafe share a tenant, so the
   * policies are satisfied and branch B's stock is fully readable and writable by
   * branch A's manager. Without this check a branch manager could receive
   * deliveries into — and write off — a branch they do not run, while the
   * deduction path, which does care about branch ownership, reported a
   * discrepancy because the recipe pointed at stock this manager just moved.
   */
  private assertBranchScope(
    actor: InventoryActor,
    targetBranchId: string,
    what: string,
  ): void {
    if (actor.branchId !== null && actor.branchId !== targetBranchId) {
      throw new BranchAccessDeniedException(
        what,
        actor.branchId,
        targetBranchId,
      );
    }
  }

  /**
   * The branch a list request is allowed to see.
   *
   * A branch-scoped caller asking for a DIFFERENT branch is refused rather than
   * quietly rewritten to their own: silently ignoring the parameter would return
   * data the caller did not ask for under a request they believe was answered,
   * which is a worse failure than a clear 403.
   */
  private listableBranch(
    actor: InventoryActor,
    requested?: string,
  ): string | undefined {
    if (requested !== undefined && requested !== '') {
      this.assertBranchScope(actor, requested, 'branch');
      return requested;
    }
    return actor.branchId ?? undefined;
  }

  /**
   * Loads an item the actor is allowed to touch, or explains why not.
   *
   * Every item-addressed operation goes through here, so a bogus id is a 404 and
   * an out-of-branch id is a 403 at EVERY entry point, rather than only at the
   * ones that remembered to check. `applyDelta` would otherwise throw a bare
   * `Error` for a missing row and surface as a 500.
   */
  private async itemInScope(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
  ): Promise<InventoryItem> {
    const item = await this.repository.findItem(connection, itemId);
    if (!item) {
      throw new InventoryItemNotFoundException(itemId);
    }
    this.assertBranchScope(actor, item.branchId, `inventory item ${itemId}`);
    return item;
  }

  // ------------------------------------------------------------- suppliers

  async createSupplier(
    connection: TenantScopedConnection,
    input: CreateSupplierInput,
  ): Promise<SupplierRow> {
    return this.repository.createSupplier(
      connection,
      this.tenantOf(connection),
      input,
    );
  }

  async listSuppliers(
    connection: TenantScopedConnection,
  ): Promise<SupplierRow[]> {
    return this.repository.listSuppliers(connection);
  }

  async getSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
  ): Promise<SupplierRow> {
    const supplier = await this.repository.findSupplier(connection, supplierId);
    if (!supplier) {
      throw new SupplierNotFoundException(supplierId);
    }
    return supplier;
  }

  /**
   * Applies a partial change to a supplier.
   *
   * A supplier id from another tenant surfaces as `SupplierNotFoundException`,
   * the same as an id that never existed — the caller learns nothing about other
   * tenants' data by guessing ids.
   */
  async updateSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
    patch: UpdateSupplierInput,
  ): Promise<SupplierRow> {
    const updated = await this.repository.updateSupplier(
      connection,
      supplierId,
      patch,
    );
    if (!updated) {
      throw new SupplierNotFoundException(supplierId);
    }
    return updated;
  }

  /**
   * Removes a supplier.
   *
   * Refused while items still name it, because `inventory_items.supplier_id` is a
   * plain `REFERENCES` with no `ON DELETE` clause — PostgreSQL would reject the
   * delete anyway, but as a driver error surfaced as a 500. Counting first turns
   * that into a 409 that says what to do.
   *
   * The fix is left to the caller on purpose: an item that loses its supplier
   * link keeps its quantity and its entire movement history, but which of the
   * two a business wants here is a business decision, not a default.
   */
  async deleteSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
  ): Promise<void> {
    const itemCount = await this.repository.countItemsForSupplier(
      connection,
      supplierId,
    );
    if (itemCount > 0) {
      throw new SupplierInUseException(supplierId, itemCount);
    }
    const deleted = await this.repository.deleteSupplier(
      connection,
      supplierId,
    );
    if (!deleted) {
      throw new SupplierNotFoundException(supplierId);
    }
  }

  // -------------------------------------------------------- inventory items

  async createItem(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    input: CreateInventoryItemInput,
  ): Promise<InventoryItem> {
    // The branch is in the request body, so this is the one write where the target
    // branch is chosen by the caller. A branch manager therefore cannot create
    // stock in a branch they do not run by naming a different `branchId`.
    this.assertBranchScope(actor, input.branchId, 'branch');
    if (input.supplierId) {
      // Checked here rather than left to the FK: a supplier from another tenant
      // still satisfies the FK (it exists), so the database would happily accept
      // it and the tenant would end up linked to a supplier it cannot read.
      await this.getSupplier(connection, input.supplierId);
    }
    return this.repository.createItem(
      connection,
      this.tenantOf(connection),
      input,
    );
  }

  async listItems(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    branchId?: string,
  ): Promise<InventoryItem[]> {
    return this.repository.listItems(
      connection,
      this.listableBranch(actor, branchId),
    );
  }

  async getItem(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
  ): Promise<InventoryItem> {
    return this.itemInScope(connection, actor, itemId);
  }

  /**
   * Records a delivery against an item.
   *
   * The stock update and the movement row share the caller's transaction: a
   * `stock_movements` entry that disagrees with `quantity_on_hand` is a ledger
   * nobody can reconcile, so the two are never written independently. There is
   * deliberately no "reject if that would look wrong" check — a delivery of 40 kg
   * is a real delivery whether or not the last one was 2 kg.
   */
  async stockIn(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
    quantity: number,
    options: { note?: string | null; createdBy?: string | null } = {},
  ): Promise<{ item: InventoryItem; movement: StockMovement }> {
    this.requireFinite(quantity, 'a stock-in needs a numeric quantity');
    if (quantity <= 0) {
      throw new InvalidQuantityException(
        'a stock-in must be a positive amount of stock received',
      );
    }
    const amount = roundQuantity(quantity);

    // Resolved before the write, so an unknown or out-of-branch item is refused
    // rather than half-applied.
    await this.itemInScope(connection, actor, itemId);
    const item = await this.repository.applyDelta(connection, itemId, amount);
    const movement = await this.repository.recordMovement(connection, {
      inventoryItemId: itemId,
      movementType: 'purchase',
      quantity: amount,
      note: options.note ?? null,
      createdBy: options.createdBy ?? null,
    });

    this.alertOnCommit(connection, item, movement);
    return { item, movement };
  }

  /**
   * Applies a signed stocktake correction.
   *
   * `note` is mandatory at this layer too, not only in the DTO: the service is
   * reachable from places other than this controller, and an unauditable
   * adjustment is the same problem however it arrives.
   */
  async adjustStock(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
    quantity: number,
    note: string,
    createdBy: string | null = null,
  ): Promise<{ item: InventoryItem; movement: StockMovement }> {
    this.requireFinite(quantity, 'an adjustment needs a numeric quantity');
    if (quantity === 0) {
      // A zero delta writes a movement that moves nothing, so the audit trail
      // would show activity on an item that never changed.
      throw new InvalidQuantityException(
        'an adjustment must be non-zero; use "adjust" only to correct a level',
      );
    }
    if (!note || note.trim().length === 0) {
      throw new InvalidQuantityException(
        'an adjustment requires a note explaining the correction',
      );
    }
    const delta = roundQuantity(quantity);

    await this.itemInScope(connection, actor, itemId);
    const item = await this.repository.applyDelta(connection, itemId, delta);
    const movement = await this.repository.recordMovement(connection, {
      inventoryItemId: itemId,
      movementType: 'adjustment',
      quantity: delta,
      note,
      createdBy,
    });

    this.alertOnCommit(connection, item, movement);
    return { item, movement };
  }

  /** Records stock lost to spoilage, breakage or over-preparation. */
  async recordWaste(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
    quantity: number,
    note: string,
    createdBy: string | null = null,
  ): Promise<{ item: InventoryItem; movement: StockMovement }> {
    this.requireFinite(quantity, 'wastage needs a numeric quantity');
    if (quantity <= 0) {
      throw new InvalidQuantityException(
        'wastage must be a positive amount of stock lost',
      );
    }
    const amount = roundQuantity(quantity);

    await this.itemInScope(connection, actor, itemId);
    const item = await this.repository.applyDelta(connection, itemId, -amount);
    const movement = await this.repository.recordMovement(connection, {
      inventoryItemId: itemId,
      movementType: 'wastage',
      // Negative, like any other stock-out: the movement column records the
      // SIGNED change, so summing the column always reproduces the current level
      // and a report never has to know the movement type to add it up.
      quantity: -amount,
      note,
      createdBy,
    });

    this.alertOnCommit(connection, item, movement);
    return { item, movement };
  }

  async listMovements(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
  ): Promise<StockMovement[]> {
    await this.itemInScope(connection, actor, itemId);
    return this.repository.listMovements(connection, itemId);
  }

  async setReorderThreshold(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    itemId: string,
    threshold: number,
  ): Promise<InventoryItem> {
    this.requireFinite(threshold, 'a reorder threshold needs a number');
    if (threshold < 0) {
      throw new InvalidQuantityException(
        'a reorder threshold cannot be negative',
      );
    }
    await this.itemInScope(connection, actor, itemId);
    const item = await this.repository.setReorderThreshold(
      connection,
      itemId,
      roundQuantity(threshold),
    );
    if (!item) {
      throw new InventoryItemNotFoundException(itemId);
    }
    return item;
  }

  // --------------------------------------------------------------- recipes

  /**
   * Points a menu item at the stock it consumes.
   *
   * Both ends are checked for existence and — for the inventory item — for BRANCH.
   * The last part matters more than it looks: `recipe_ingredients` links a menu
   * item to an inventory item, and an inventory item belongs to exactly one
   * branch. A recipe wired to another branch's flour would let one branch's sales
   * silently drain another branch's stock, and neither branch's numbers would
   * look wrong until the flour ran out.
   *
   * The branch is not in the DTO because the caller is usually editing the recipe
   * from a branch's point of view, and asking them to repeat which branch they
   * are already standing in is a chance to be inconsistent. Where the branch comes
   * from depends on the route: a branch-scoped management route carries it, and a
   * tenant-wide route must say it explicitly.
   */
  async setRecipeIngredient(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    input: UpsertRecipeIngredientInput,
    branchId: string,
  ): Promise<void> {
    this.requireFinite(
      input.quantityUsed,
      'a recipe needs a numeric amount of each ingredient',
    );
    if (input.quantityUsed <= 0) {
      throw new InvalidQuantityException(
        'a recipe must consume a positive amount of each ingredient',
      );
    }
    // The branch the recipe is being written FOR, and the branch the ingredient is
    // held at, both have to be the caller's. Checking only the second would let a
    // tenant-wide caller wire a recipe for a branch that is not theirs.
    this.assertBranchScope(actor, branchId, 'branch');
    const item = await this.repository.findItem(
      connection,
      input.inventoryItemId,
    );
    if (!item) {
      throw new RecipeNotFoundException(
        `inventory item ${input.inventoryItemId} does not exist for this tenant`,
      );
    }
    if (item.branchId !== branchId) {
      throw new RecipeNotFoundException(
        `inventory item ${input.inventoryItemId} belongs to a different branch. ` +
          `A recipe for branch ${branchId} cannot consume stock held by ` +
          `branch ${item.branchId}.`,
      );
    }
    await this.repository.upsertRecipeIngredient(
      connection,
      this.tenantOf(connection),
      {
        ...input,
        quantityUsed: roundQuantity(input.quantityUsed),
      },
    );
  }

  async removeRecipeIngredient(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    ingredientId: string,
  ): Promise<void> {
    // Refused BEFORE the delete: a branch manager must not be able to remove
    // another branch's recipe wiring, which would silently stop that branch's
    // ingredients from being deducted on every sale.
    const ingredient = await this.repository.findRecipeIngredient(
      connection,
      ingredientId,
    );
    if (!ingredient) {
      throw new RecipeNotFoundException(
        `recipe ingredient ${ingredientId} does not exist for this tenant`,
      );
    }
    await this.itemInScope(connection, actor, ingredient.inventory_item_id);

    const removed = await this.repository.removeRecipeIngredient(
      connection,
      ingredientId,
    );
    if (!removed) {
      // Deleted between the read above and here.
      throw new RecipeNotFoundException(
        `recipe ingredient ${ingredientId} does not exist for this tenant`,
      );
    }
  }

  // ------------------------------------------------------ order deduction

  /**
   * Consumes the recipe stock for a COMPLETED order, exactly once.
   *
   * ## Why this is not atomic with the order
   *
   * `order.status_changed` fires after the order's own transaction has committed
   * (see `TenantScopedConnection.onCommit`). The order is already durable by the
   * time this runs, so there is no transaction left to join. Pretending otherwise
   * would mean reaching into `OrderService` and deducting inside its transaction —
   * coupling the two modules' internals and turning one checkout into two
   * modules' problem.
   *
   * ## What IS atomic
   *
   * Everything this method writes. Claim, every stock update, every movement row
   * and the final status all commit together or not at all: there is no state in
   * which the items are deducted but the ledger says pending, or vice versa.
   *
   * ## What happens on failure
   *
   * The transaction rolls back, leaving no partial deduction, and the failure is
   * written on a SEPARATE connection — a row inserted in the transaction that just
   * died would die with it, and the order/stock disagreement would vanish
   * unreported. The order stays `completed`; that is the correct outcome, since
   * refusing to complete a paid order because the fridge was out of milk is worse
   * than an ingredient that was not deducted. The discrepancy shows up on
   * `GET /inventory/discrepancies` for a human to resolve.
   */
  async deductForOrder(
    tenantId: string,
    orderId: string,
  ): Promise<DeductionOutcome> {
    const connection = await this.connections.acquireScoped(tenantId);
    const alerts: Array<{ item: InventoryItem; movementId: string | null }> =
      [];

    try {
      const { claimed, existing } = await this.repository.claimDeduction(
        connection,
        tenantId,
        orderId,
      );

      if (!claimed) {
        await connection.commit();
        return {
          status: existing?.status ?? 'completed',
          deduplicated: true,
          menuItemsWithoutRecipe: [],
        };
      }

      // Both reads are tenant-filtered. `ingredientsForOrder` joins through
      // `orders.branch_id` so only stock held at the branch that sold the dish is
      // ever deducted; `crossBranchIngredients` reports the ones it had to skip
      // so a mis-wired recipe cannot pass unnoticed.
      const ingredients = await this.repository.ingredientsForOrder(
        connection,
        tenantId,
        orderId,
      );
      const menuItemsWithoutRecipe =
        await this.repository.menuItemsWithoutRecipe(
          connection,
          tenantId,
          orderId,
        );
      const crossBranch = await this.repository.crossBranchIngredients(
        connection,
        tenantId,
        orderId,
      );

      for (const ingredient of ingredients) {
        const amount = roundQuantity(ingredient.quantity);
        if (amount === 0) {
          // A recipe of 0 for a real order line contributes nothing. Skipping it
          // keeps stock_movements free of rows that say nothing happened.
          continue;
        }
        const item = await this.repository.applyDelta(
          connection,
          ingredient.inventoryItemId,
          -amount,
        );
        const movement = await this.repository.recordMovement(connection, {
          inventoryItemId: ingredient.inventoryItemId,
          movementType: 'usage',
          quantity: -amount,
          referenceOrderId: orderId,
          // No created_by: the deduction was the system acting on the order, not
          // a person at a terminal, and attributing it to whichever user happened
          // to complete the order would make the audit trail misleading.
          createdBy: null,
        });
        alerts.push({ item, movementId: movement.id });
      }

      const status: DeductionStatus =
        menuItemsWithoutRecipe.length > 0 || crossBranch.length > 0
          ? 'partial'
          : 'completed';
      const detail = describeDeductionGaps(menuItemsWithoutRecipe, crossBranch);

      await this.repository.completeDeduction(
        connection,
        tenantId,
        orderId,
        status,
        detail,
      );
      await connection.commit();

      // Committed: only now can a subscriber re-read these levels on its own
      // connection and get the answer that was actually stored.
      for (const alert of alerts) {
        this.publishLowStock(tenantId, alert.item, alert.movementId);
      }

      return { status, deduplicated: false, menuItemsWithoutRecipe };
    } catch (error) {
      await connection.rollback();
      await this.recordFailure(tenantId, orderId, error);
      return {
        status: 'failed',
        deduplicated: false,
        menuItemsWithoutRecipe: [],
      };
    } finally {
      await connection.release();
    }
  }

  /**
   * Leaves a record of a failed deduction, on a connection of its own.
   *
   * Any failure HERE is logged and swallowed. The original problem has already
   * been recorded or is unrecordable, and a listener that throws while handling
   * an event would take down the request that triggered it — turning a stock
   * bookkeeping problem into a failed checkout.
   */
  private async recordFailure(
    tenantId: string,
    orderId: string,
    error: unknown,
  ): Promise<void> {
    const detail = error instanceof Error ? error.message : String(error);
    this.logger.error(
      `Inventory deduction failed for order ${orderId} (tenant ${tenantId}): ${detail}`,
      error instanceof Error ? error.stack : undefined,
    );
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      await this.repository.recordDeductionFailure(
        connection,
        tenantId,
        orderId,
        detail,
      );
      await connection.commit();
    } catch (recordError) {
      this.logger.error(
        `Could not record the deduction failure for order ${orderId}: ${
          recordError instanceof Error
            ? recordError.message
            : String(recordError)
        }`,
      );
      await connection.rollback();
    } finally {
      await connection.release();
    }
  }

  // --------------------------------------------------------- discrepancies

  /**
   * The review queue, scoped like every other read.
   *
   * A failure names the ingredient and the shortfall, so a tenant-wide listing
   * would hand a branch manager a running account of the other branches' stock
   * problems.
   */
  async listDiscrepancies(
    connection: TenantScopedConnection,
    actor: InventoryActor,
    status?: DeductionStatus,
  ): Promise<DeductionRow[]> {
    return this.repository.listDiscrepancies(
      connection,
      status,
      actor.branchId,
    );
  }

  // ---------------------------------------------------------------- alerts

  /**
   * Raises an alert for `item` if the tenant's strategy says it is due, once the
   * caller's transaction commits.
   *
   * The strategy is asked HERE, after the movement, so it sees the level the
   * movement actually produced. Asking it before would either miss a crossing or
   * need a second read.
   */
  private alertOnCommit(
    connection: TenantScopedConnection,
    item: InventoryItem,
    movement: StockMovement,
  ): void {
    if (!this.strategies.forTenant(item.tenantId).shouldAlert(item)) {
      return;
    }
    const tenantId = item.tenantId;
    const movementId = movement.id;
    connection.onCommit(() => {
      this.publishLowStock(tenantId, item, movementId);
    });
  }

  /**
   * Emits `inventory.low_stock`.
   *
   * A subscriber that throws must not fail the request that moved the stock, so
   * a listener error is caught and logged here. The event bus is in-process and
   * synchronous by default, which means a throwing subscriber would otherwise
   * propagate straight out of `EventEmitter2.emit` and into the committed
   * request's response.
   */
  private publishLowStock(
    tenantId: string,
    item: InventoryItem,
    triggeredByMovementId: string | null,
  ): void {
    const event: InventoryLowStockEvent = {
      event: INVENTORY_EVENTS.lowStock,
      inventoryItemId: item.id,
      tenantId,
      branchId: item.branchId,
      name: item.name,
      unit: item.unit,
      quantityOnHand: item.quantityOnHand,
      reorderThreshold: item.reorderThreshold,
      severity:
        item.quantityOnHand <= 0
          ? LOW_STOCK_SEVERITY.outOfStock
          : LOW_STOCK_SEVERITY.reorder,
      triggeredByMovementId,
      occurredAt: new Date().toISOString(),
    };
    try {
      this.events.emit(INVENTORY_EVENTS.lowStock, event);
    } catch (error) {
      this.logger.error(
        `A subscriber to ${INVENTORY_EVENTS.lowStock} threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

/**
 * Explains, in the ledger's `detail`, exactly what was NOT deducted.
 *
 * Written for whoever opens the discrepancy list weeks later: a bare "partial"
 * says something is wrong, this says which menu item and, for a mis-wired
 * recipe, which branch holds the stock that should have been used.
 */
function describeDeductionGaps(
  menuItemsWithoutRecipe: readonly string[],
  crossBranch: ReadonlyArray<{
    menuItemId: string;
    inventoryItemId: string;
    branchId: string;
  }>,
): string | null {
  const parts: string[] = [];
  if (menuItemsWithoutRecipe.length > 0) {
    parts.push(
      `No recipe configured for menu item(s): ${[...new Set(menuItemsWithoutRecipe)].join(', ')}`,
    );
  }
  for (const entry of crossBranch) {
    parts.push(
      `Menu item ${entry.menuItemId} consumed inventory item ${entry.inventoryItemId}, which belongs to branch ${entry.branchId} rather than the branch that took the order`,
    );
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
