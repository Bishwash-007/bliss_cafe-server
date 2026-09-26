import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import {
  quantity,
  type CreateInventoryItemInput,
  type CreateSupplierInput,
  type DeductionRow,
  type DeductionStatus,
  type InventoryItem,
  type InventoryItemRow,
  type RecipeIngredientRow,
  type StockMovement,
  type StockMovementRow,
  type StockMovementType,
  type SupplierRow,
  type UpdateSupplierInput,
  type UpsertRecipeIngredientInput,
} from './inventory.types';

/**
 * Data access for inventory. Every statement is filtered by `tenant_id` as well
 * as relying on RLS — the two are independent, so a forgotten predicate is a
 * caught bug rather than a breach.
 */
@Injectable()
export class InventoryRepository {
  // ------------------------------------------------------------- suppliers

  async createSupplier(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreateSupplierInput,
  ): Promise<SupplierRow> {
    const result = await connection.query<SupplierRow>(
      `INSERT INTO suppliers (tenant_id, name, contact_phone, contact_email)
            VALUES ($1, $2, $3, $4)
         RETURNING *`,
      [
        tenantId,
        input.name,
        input.contactPhone ?? null,
        input.contactEmail ?? null,
      ],
    );
    return result.rows[0];
  }

  async listSuppliers(
    connection: TenantScopedConnection,
  ): Promise<SupplierRow[]> {
    const result = await connection.query<SupplierRow>(
      `SELECT * FROM suppliers WHERE tenant_id = $1 ORDER BY name`,
      [this.tenantId(connection)],
    );
    return result.rows;
  }

  async findSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
  ): Promise<SupplierRow | null> {
    const result = await connection.query<SupplierRow>(
      `SELECT * FROM suppliers
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), supplierId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Renames a supplier or changes how to reach them.
   *
   * A real partial update, not a `COALESCE` over every column: the `SET` list is
   * built from the keys the caller actually sent, so an absent field is never
   * written and an explicit `null` clears the column. The two need to be
   * distinguishable — a supplier whose phone number is wrong has to be fixable
   * by correcting it AND by removing it, and `COALESCE` can express only the
   * first.
   *
   * Only the column NAMES are interpolated, and they come from a fixed allowlist
   * rather than from the request, so nothing user-supplied reaches the SQL text.
   * Every value is still a bound parameter.
   *
   * `tenant_id` is in the predicate as well as relying on RLS, so a supplier
   * belonging to another tenant is simply not found.
   */
  async updateSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
    patch: UpdateSupplierInput,
  ): Promise<SupplierRow | null> {
    const columns: ReadonlyArray<readonly [keyof UpdateSupplierInput, string]> =
      [
        ['name', 'name'],
        ['contactPhone', 'contact_phone'],
        ['contactEmail', 'contact_email'],
      ];
    const values: unknown[] = [this.tenantId(connection), supplierId];
    const sets: string[] = [];
    for (const [key, column] of columns) {
      if (!(key in patch)) {
        continue;
      }
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) {
      // An empty PATCH is a no-op, not an error: report the supplier as it
      // stands so the caller gets a 200 with the current state.
      return this.findSupplier(connection, supplierId);
    }
    const result = await connection.query<SupplierRow>(
      `UPDATE suppliers
          SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING *`,
      values,
    );
    return result.rows[0] ?? null;
  }

  /**
   * How many items still name this supplier.
   *
   * Read before the delete so an in-use supplier is refused as a 409 with an
   * actionable message. The delete would be refused by the foreign key anyway —
   * this turns an unactionable 500 into a decision the caller can make.
   */
  async countItemsForSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
  ): Promise<number> {
    const result = await connection.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM inventory_items
        WHERE tenant_id = $1 AND supplier_id = $2`,
      [this.tenantId(connection), supplierId],
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  /**
   * Removes a supplier.
   *
   * Returns whether a row was actually deleted so the caller can tell "deleted"
   * from "was never there" — and, just as importantly, from "belongs to someone
   * else", which must look identical from the outside.
   */
  async deleteSupplier(
    connection: TenantScopedConnection,
    supplierId: string,
  ): Promise<boolean> {
    const result = await connection.query(
      `DELETE FROM suppliers WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), supplierId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------- inventory items

  async createItem(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreateInventoryItemInput,
  ): Promise<InventoryItem> {
    const result = await connection.query<InventoryItemRow>(
      `INSERT INTO inventory_items
              (tenant_id, branch_id, name, unit,
               quantity_on_hand, reorder_threshold, supplier_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
      [
        tenantId,
        input.branchId,
        input.name,
        input.unit,
        input.quantityOnHand ?? 0,
        input.reorderThreshold ?? 0,
        input.supplierId ?? null,
      ],
    );
    return toItem(result.rows[0]);
  }

  async listItems(
    connection: TenantScopedConnection,
    branchId?: string,
  ): Promise<InventoryItem[]> {
    // The tenant id comes from the connection's own scope rather than a
    // parameter, so a caller cannot accidentally query another tenant.
    const result = branchId
      ? await connection.query<InventoryItemRow>(
          `SELECT * FROM inventory_items
            WHERE tenant_id = $1 AND branch_id = $2
            ORDER BY name`,
          [this.tenantId(connection), branchId],
        )
      : await connection.query<InventoryItemRow>(
          `SELECT * FROM inventory_items
            WHERE tenant_id = $1
            ORDER BY name`,
          [this.tenantId(connection)],
        );
    return result.rows.map(toItem);
  }

  async findItem(
    connection: TenantScopedConnection,
    itemId: string,
  ): Promise<InventoryItem | null> {
    const result = await connection.query<InventoryItemRow>(
      `SELECT * FROM inventory_items WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), itemId],
    );
    return result.rows[0] ? toItem(result.rows[0]) : null;
  }

  /**
   * Applies a signed delta to an item's stock and returns the NEW level.
   *
   * The arithmetic is done by Postgres (`quantity_on_hand + $2`) rather than by
   * reading, adding in JS and writing back. That is not a style preference: the
   * read-modify-write version loses updates whenever two movements touch the
   * same item concurrently, which is the normal case at a busy branch during
   * service. Letting the `UPDATE` take the row lock and compute in place makes
   * the lost update impossible.
   *
   * No `quantity_on_hand >= 0` guard: see `OrderDeductionListener` for why a
   * deduction records reality rather than refusing it.
   */
  async applyDelta(
    connection: TenantScopedConnection,
    itemId: string,
    delta: number,
  ): Promise<InventoryItem> {
    const result = await connection.query<InventoryItemRow>(
      `UPDATE inventory_items
          SET quantity_on_hand = quantity_on_hand + $2
        WHERE tenant_id = $1 AND id = $3
     RETURNING *`,
      [this.tenantId(connection), delta, itemId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`Inventory item ${itemId} not found`);
    }
    return toItem(row);
  }

  async setReorderThreshold(
    connection: TenantScopedConnection,
    itemId: string,
    threshold: number,
  ): Promise<InventoryItem | null> {
    const result = await connection.query<InventoryItemRow>(
      `UPDATE inventory_items
          SET reorder_threshold = $2
        WHERE tenant_id = $1 AND id = $3
     RETURNING *`,
      [this.tenantId(connection), threshold, itemId],
    );
    return result.rows[0] ? toItem(result.rows[0]) : null;
  }

  // --------------------------------------------------------------- recipes

  async listRecipeIngredients(
    connection: TenantScopedConnection,
    menuItemId: string,
  ): Promise<RecipeIngredientRow[]> {
    const result = await connection.query<RecipeIngredientRow>(
      `SELECT * FROM recipe_ingredients
        WHERE tenant_id = $1 AND menu_item_id = $2
        ORDER BY id`,
      [this.tenantId(connection), menuItemId],
    );
    return result.rows;
  }

  /**
   * Adds an ingredient to a recipe, or updates the quantity if that ingredient is
   * already listed for the menu item.
   *
   * An upsert rather than check-then-insert, because the check-then version races:
   * two concurrent recipe edits both see the ingredient as absent and both insert,
   * and the deduction's `SUM` would then count that ingredient twice. The
   * uniqueness this relies on comes from `idx_recipe_ingredients_unique` in
   * migration 012 — 007 has no such constraint, so the conflict target below is
   * only valid once that migration has run.
   */
  async upsertRecipeIngredient(
    connection: TenantScopedConnection,
    tenantId: string,
    input: UpsertRecipeIngredientInput,
  ): Promise<RecipeIngredientRow> {
    const result = await connection.query<RecipeIngredientRow>(
      `INSERT INTO recipe_ingredients
              (tenant_id, menu_item_id, inventory_item_id, quantity_used)
            VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id, menu_item_id, inventory_item_id)
         DO UPDATE SET quantity_used = EXCLUDED.quantity_used
         RETURNING *`,
      [tenantId, input.menuItemId, input.inventoryItemId, input.quantityUsed],
    );
    return result.rows[0];
  }

  /**
   * Reads a recipe ingredient well enough to decide whether the caller may touch
   * it.
   *
   * Separate from the delete on purpose: the branch check has to happen BEFORE the
   * row goes, not after. Checking afterwards and then throwing would leave the
   * delete correct only as long as the caller's transaction rolls back — true for
   * the HTTP path, but a false guarantee for any future caller running with
   * autocommit, where the 403 would arrive after the row was already gone.
   */
  async findRecipeIngredient(
    connection: TenantScopedConnection,
    ingredientId: string,
  ): Promise<RecipeIngredientRow | null> {
    const result = await connection.query<RecipeIngredientRow>(
      `SELECT * FROM recipe_ingredients
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), ingredientId],
    );
    return result.rows[0] ?? null;
  }

  async removeRecipeIngredient(
    connection: TenantScopedConnection,
    ingredientId: string,
  ): Promise<boolean> {
    const result = await connection.query(
      `DELETE FROM recipe_ingredients
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), ingredientId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Every ingredient a completed order consumed, already multiplied and summed.
   *
   * The multiplication and aggregation happen in SQL, in exact `NUMERIC`, and
   * that is a correctness requirement rather than an optimisation:
   *
   *   - `0.1 * 3` in binary floating point is `0.30000000000000004`. Rounding that
   *     to 3dp gives the right answer, but only because we remembered to; doing
   *     it in Postgres means it is right by construction.
   *   - Summing per inventory item means a recipe listing the same ingredient
   *     twice, or an order with two lines of the same dish, produces ONE movement
   *     row for the true total instead of two rows a stocktake would have to
   *     reconcile by hand.
   *
   * ## The branch join is load-bearing
   *
   * `inventory_items.branch_id` is NOT NULL: stock is held per branch. An
   * org-wide menu item has ONE recipe, so without the
   * `ii.branch_id = o.branch_id` join a sale at branch B would deduct branch A's
   * flour — A's numbers would drain with no sale recorded against them, and
   * nothing anywhere would look wrong until A ran out.
   *
   * Ingredients excluded by this join are not lost: `crossBranchIngredients`
   * reports them so the caller can surface the misconfiguration instead of
   * quietly deducting a partial amount.
   */
  async ingredientsForOrder(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<Array<{ inventoryItemId: string; quantity: number }>> {
    const result = await connection.query<{
      inventory_item_id: string;
      quantity: string;
    }>(
      `SELECT ri.inventory_item_id,
              SUM(ROUND(ri.quantity_used * oi.quantity, 3)) AS quantity
         FROM order_items oi
         JOIN orders o
           ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
         JOIN recipe_ingredients ri
           ON ri.menu_item_id = oi.menu_item_id
          AND ri.tenant_id = oi.tenant_id
         JOIN inventory_items ii
           ON ii.id = ri.inventory_item_id
          AND ii.tenant_id = ri.tenant_id
        WHERE oi.tenant_id = $1
          AND oi.order_id = $2
          AND ii.branch_id = o.branch_id
        GROUP BY ri.inventory_item_id
        ORDER BY ri.inventory_item_id`,
      [tenantId, orderId],
    );
    return result.rows.map((row) => ({
      inventoryItemId: row.inventory_item_id,
      quantity: quantity(row.quantity),
    }));
  }

  /**
   * Recipe ingredients on this order that point at ANOTHER branch's stock.
   *
   * A data fault, not a request fault: the recipe was authored against the wrong
   * branch. Returned separately so the deduction can still happen for the
   * ingredients that are right, and the order lands in the discrepancy queue
   * naming exactly what is misconfigured.
   */
  async crossBranchIngredients(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<
    Array<{ menuItemId: string; inventoryItemId: string; branchId: string }>
  > {
    const result = await connection.query<{
      menu_item_id: string;
      inventory_item_id: string;
      branch_id: string;
    }>(
      `SELECT DISTINCT oi.menu_item_id, ri.inventory_item_id, ii.branch_id
         FROM order_items oi
         JOIN orders o
           ON o.id = oi.order_id AND o.tenant_id = oi.tenant_id
         JOIN recipe_ingredients ri
           ON ri.menu_item_id = oi.menu_item_id
          AND ri.tenant_id = oi.tenant_id
         JOIN inventory_items ii
           ON ii.id = ri.inventory_item_id
          AND ii.tenant_id = ri.tenant_id
        WHERE oi.tenant_id = $1
          AND oi.order_id = $2
          AND ii.branch_id <> o.branch_id
        ORDER BY oi.menu_item_id, ri.inventory_item_id`,
      [tenantId, orderId],
    );
    return result.rows.map((row) => ({
      menuItemId: row.menu_item_id,
      inventoryItemId: row.inventory_item_id,
      branchId: row.branch_id,
    }));
  }

  /**
   * Menu items on the order that have NO recipe at all.
   *
   * Reported so a "partial" deduction is never mistaken for a complete one. An
   * item with no recipe is not an error — plenty of menu items are not made from
   * stock — but silently deducting nothing for it is exactly the un-deducted
   * discrepancy this module is meant to make visible.
   */
  async menuItemsWithoutRecipe(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<string[]> {
    const result = await connection.query<{ menu_item_id: string }>(
      `SELECT DISTINCT oi.menu_item_id
         FROM order_items oi
         LEFT JOIN recipe_ingredients ri
           ON ri.menu_item_id = oi.menu_item_id
          AND ri.tenant_id = oi.tenant_id
        WHERE oi.tenant_id = $1
          AND oi.order_id = $2
          AND ri.id IS NULL
        ORDER BY oi.menu_item_id`,
      [tenantId, orderId],
    );
    return result.rows.map((row) => row.menu_item_id);
  }

  // ------------------------------------------------------- stock movements

  /**
   * Writes the audit row. ALWAYS call this in the same transaction as
   * `applyDelta` — a movement without the matching quantity update (or the
   * reverse) is an unreconcilable ledger.
   */
  async recordMovement(
    connection: TenantScopedConnection,
    entry: {
      inventoryItemId: string;
      movementType: StockMovementType;
      quantity: number;
      referenceOrderId?: string | null;
      note?: string | null;
      createdBy?: string | null;
    },
  ): Promise<StockMovement> {
    const result = await connection.query<StockMovementRow>(
      `INSERT INTO stock_movements
              (tenant_id, inventory_item_id, movement_type, quantity,
               reference_order_id, note, created_by)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING *`,
      [
        this.tenantId(connection),
        entry.inventoryItemId,
        entry.movementType,
        entry.quantity,
        entry.referenceOrderId ?? null,
        entry.note ?? null,
        entry.createdBy ?? null,
      ],
    );
    return toMovement(result.rows[0]);
  }

  async listMovements(
    connection: TenantScopedConnection,
    inventoryItemId: string,
  ): Promise<StockMovement[]> {
    const result = await connection.query<StockMovementRow>(
      `SELECT * FROM stock_movements
        WHERE tenant_id = $1 AND inventory_item_id = $2
        ORDER BY created_at DESC, id DESC`,
      [this.tenantId(connection), inventoryItemId],
    );
    return result.rows.map(toMovement);
  }

  // -------------------------------------------------- deduction ledger (012)

  /**
   * Claims the deduction for an order, or reports that it is already accounted
   * for.
   *
   * This is the exactly-once gate. The bus is in-process and best-effort, so the
   * same `order.status_changed` can arrive twice; the UNIQUE
   * `(tenant_id, order_id)` index from migration 012 is what makes a second
   * deduction impossible, including under genuinely concurrent redelivery where
   * an application-level "has this run?" check would race.
   *
   * A previous `failed` attempt is deliberately re-claimable: the failure was
   * rolled back, so nothing was deducted, and a retry is exactly what an operator
   * or a redelivery should produce. A `completed` or `partial` attempt is final.
   */
  async claimDeduction(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<{ claimed: boolean; existing: DeductionRow | null }> {
    const inserted = await connection.query<DeductionRow>(
      `INSERT INTO order_inventory_deductions (tenant_id, order_id, status)
            VALUES ($1, $2, 'pending')
         ON CONFLICT (tenant_id, order_id) DO NOTHING
         RETURNING *`,
      [tenantId, orderId],
    );
    const row = inserted.rows[0];
    if (row) {
      return { claimed: true, existing: null };
    }

    const existing = await this.findDeduction(connection, tenantId, orderId);
    if (existing && existing.status === 'failed') {
      // Retry: take the row back over. The guard is the status filter, so two
      // simultaneous retries cannot both proceed.
      const retaken = await connection.query<DeductionRow>(
        `UPDATE order_inventory_deductions
            SET status = 'pending', detail = NULL, updated_at = now()
          WHERE tenant_id = $1 AND order_id = $2 AND status = 'failed'
         RETURNING *`,
        [tenantId, orderId],
      );
      if (retaken.rows[0]) {
        return { claimed: true, existing: null };
      }
    }

    return { claimed: false, existing };
  }

  async findDeduction(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<DeductionRow | null> {
    const result = await connection.query<DeductionRow>(
      `SELECT * FROM order_inventory_deductions
        WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId],
    );
    return result.rows[0] ?? null;
  }

  /** Must run in the same transaction as the deduction it describes. */
  async completeDeduction(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    status: Exclude<DeductionStatus, 'pending' | 'failed'>,
    detail: string | null,
  ): Promise<void> {
    await connection.query(
      `UPDATE order_inventory_deductions
          SET status = $3, detail = $4, updated_at = now()
        WHERE tenant_id = $1 AND order_id = $2`,
      [tenantId, orderId, status, detail],
    );
  }

  /**
   * Records a FAILURE on its own connection, after the failed transaction rolled
   * back.
   *
   * A row written inside the rolled-back transaction would be rolled back with it,
   * destroying the only evidence that stock and an order disagreed. This is
   * therefore called with a separate, unscoped-by-the-failed-work connection
   * whose only job is to leave a note.
   */
  async recordDeductionFailure(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    detail: string,
  ): Promise<void> {
    await connection.query(
      `INSERT INTO order_inventory_deductions
              (tenant_id, order_id, status, detail)
            VALUES ($1, $2, 'failed', $3)
       ON CONFLICT (tenant_id, order_id)
       DO UPDATE SET status = 'failed',
                     detail = EXCLUDED.detail,
                     updated_at = now()`,
      [tenantId, orderId, detail],
    );
  }

  /**
   * The manual-review queue behind `GET /inventory/discrepancies`: every deduction
   * that is not fully settled.
   *
   * A caller confined to a branch sees only that branch's failures. The table has
   * no `branch_id` of its own, so this joins through the order, which does — the
   * `detail` on a failed row names the ingredient and the shortfall, which is
   * another branch's business.
   */
  async listDiscrepancies(
    connection: TenantScopedConnection,
    status?: DeductionStatus,
    branchId?: string | null,
  ): Promise<DeductionRow[]> {
    // Positional placeholders, so the numbers are assigned as the filters are added
    // rather than counted by hand. The tenant is always $1.
    const params: unknown[] = [this.tenantId(connection)];
    let statusClause = `d.status IN ('failed', 'partial')`;
    if (status) {
      params.push(status);
      statusClause = `d.status = $${params.length}`;
    }
    let branchClause = '';
    if (branchId) {
      params.push(branchId);
      branchClause = `AND o.branch_id = $${params.length}`;
    }

    return await connection
      .query<DeductionRow>(
        `SELECT d.* FROM order_inventory_deductions d
         JOIN orders o ON o.id = d.order_id
         WHERE d.tenant_id = $1 AND ${statusClause} ${branchClause}
         ORDER BY d.created_at DESC`,
        params,
      )
      .then((r) => r.rows);
  }

  /**
   * The tenant this connection is pinned to.
   *
   * Read from the connection rather than accepted as a parameter, so a
   * repository call can only ever see its own request's tenant and a caller
   * cannot pass a different one by mistake.
   *
   * An unscoped connection throws instead of returning a tenant to filter on.
   * RLS would hide every row and the query would quietly report "no suppliers"
   * for a tenant that has some, which is a far worse failure than a stack trace.
   */
  private tenantId(connection: TenantScopedConnection): string {
    const tenantId = connection.tenantId;
    if (tenantId === null) {
      throw new Error(
        'Inventory query requires a tenant-scoped connection, but this ' +
          'connection has no tenant pinned. Acquire it with ' +
          'TenantConnectionService.acquireScoped(tenantId).',
      );
    }
    return tenantId;
  }
}

export function toItem(row: InventoryItemRow): InventoryItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    branchId: row.branch_id,
    name: row.name,
    unit: row.unit,
    quantityOnHand: quantity(row.quantity_on_hand),
    reorderThreshold: quantity(row.reorder_threshold),
    supplierId: row.supplier_id,
  };
}

export function toMovement(row: StockMovementRow): StockMovement {
  return {
    id: row.id,
    inventoryItemId: row.inventory_item_id,
    movementType: row.movement_type as StockMovementType,
    quantity: quantity(row.quantity),
    referenceOrderId: row.reference_order_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
