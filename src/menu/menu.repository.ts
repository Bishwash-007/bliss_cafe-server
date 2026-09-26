import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';

export interface MenuCategoryRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  name: string;
  sort_order: number;
  created_at: Date;
}

export interface MenuItemRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  category_id: string | null;
  name: string;
  description: string | null;
  price: number;
  is_available: boolean;
  image_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MenuItemModifierRow {
  id: string;
  tenant_id: string;
  menu_item_id: string;
  name: string;
  option_name: string;
  extra_price: number;
}

export interface CreateCategoryInput {
  name: string;
  sortOrder?: number;
}

export interface CreateItemInput {
  name: string;
  price: number;
  description?: string | null;
  isAvailable?: boolean;
  imageUrl?: string | null;
  categoryId?: string | null;
}

export interface PackagedModifierInput {
  name: string;
  optionName: string;
  extraPrice: number;
}

/**
 * One menu item as it sells at a specific branch: the WINNING row's id (which
 * may be a branch override even when the caller asked by the org-wide id), its
 * effective price, and whether it is currently orderable.
 */
export interface ResolvedMenuItem {
  menuItemId: string;
  price: number;
  isAvailable: boolean;
}

/**
 * `pg` returns `NUMERIC` as a STRING, to avoid silently losing precision on
 * values it cannot represent as a float. So a `price` arrives as `"3.50"`, not
 * `3.5` — and the moment the pricing decorator stacks a modifier,
 * `"3.50" + "0.75"` becomes the string `"3.500.75"` rather than `4.25`.
 *
 * Money is therefore coerced to `number` here, at the DAL boundary, so the
 * declared row types above are truthful and the domain never re-parses (or
 * worse, concatenates). Every query that returns a monetary column goes
 * through `toItemRow` / `toModifierRow`.
 *
 * Postgres still stores and aggregates NUMERIC exactly; only the in-process
 * value is a float. A module that needs exact decimal arithmetic (order
 * totals, payments) should carry integer minor units instead of trusting
 * float addition.
 */
function money(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toItemRow(row: MenuItemRow): MenuItemRow {
  return { ...row, price: money(row.price) };
}

function toModifierRow(row: MenuItemModifierRow): MenuItemModifierRow {
  return { ...row, extra_price: money(row.extra_price) };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Data access for the menu domain (categories, items, modifiers). Every query
 * is tenant-scoped through `TenantScopedConnection`; RLS is the second layer of
 * defence. Modifier "variants" deliberately live side by side with the item
 * they belong to — the app reads them all and stacks the prices (Decorator)
 * rather than bloating `menu_items` with combinatorial columns.
 */
@Injectable()
export class MenuRepository {
  /**
   * The price a specific menu item sells for AT ONE BRANCH, applying the same
   * merge rule `MenuService.getFullMenu` applies when rendering: a branch row
   * whose `name` matches an org-wide row in the same category REPLACES it.
   *
   * This exists so the order module can price a ticket server-side. A client may
   * quote an item by EITHER the org-wide id or the branch override id (both are
   * reachable, per `getFullMenu`'s `sourceIds`), and in both cases the answer is
   * the branch's price — not "the row the id points at".
   *
   * Returns a map keyed by the id the CALLER supplied, so the caller can look it
   * up without knowing which row won, and carries the winning row's own id so
   * the caller can record (and later re-join modifiers against) the row that
   * actually defines what was sold. Items with no branch-visible row are absent
   * from the map rather than mapped to `null`, letting the caller treat
   * "unknown item" and "unavailable item" as the one thing they are: an error.
   */
  async resolveItemsForBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    itemIds: string[],
  ): Promise<Map<string, ResolvedMenuItem>> {
    const valid = itemIds.filter((id) => UUID_RE.test(id));
    if (valid.length === 0) {
      return new Map();
    }
    const placeholders = valid.map((_, index) => `$${index + 3}`).join(', ');
    const result = await connection.query<{
      requested_id: string;
      effective_id: string;
      effective_price: string | number;
      effective_available: boolean;
    }>(
      `SELECT DISTINCT ON (requested.id)
            requested.id AS requested_id,
            COALESCE(override.id, requested.id) AS effective_id,
            COALESCE(override.price, requested.price) AS effective_price,
            COALESCE(override.is_available, requested.is_available)
              AS effective_available
       FROM menu_items requested
       LEFT JOIN menu_items override
              ON override.tenant_id = requested.tenant_id
             AND override.branch_id = $2
             AND override.id <> requested.id
             AND lower(override.name) = lower(requested.name)
             AND override.category_id IS NOT DISTINCT FROM requested.category_id
      WHERE requested.tenant_id = $1
        AND requested.id IN (${placeholders})
        AND (requested.branch_id IS NULL OR requested.branch_id = $2)
      ORDER BY requested.id, override.branch_id NULLS LAST, override.id`,
      [tenantId, branchId, ...valid],
    );
    return new Map(
      result.rows.map((row) => [
        row.requested_id,
        {
          menuItemId: row.effective_id,
          price: money(row.effective_price),
          isAvailable: row.effective_available,
        },
      ]),
    );
  }
  findCategories(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string | null,
  ): Promise<MenuCategoryRow[]> {
    const clause = branchId === null ? 'IS NULL' : '= $2';
    const values = branchId === null ? [tenantId] : [tenantId, branchId];
    return connection
      .query<MenuCategoryRow>(
        `SELECT id, tenant_id, branch_id, name, sort_order, created_at
           FROM menu_categories
          WHERE tenant_id = $1 AND branch_id ${clause}
          ORDER BY sort_order, name`,
        values,
      )
      .then((result) => result.rows);
  }

  findItems(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string | null,
  ): Promise<MenuItemRow[]> {
    const clause = branchId === null ? 'IS NULL' : '= $2';
    const values = branchId === null ? [tenantId] : [tenantId, branchId];
    return connection
      .query<MenuItemRow>(
        `SELECT id, tenant_id, branch_id, category_id, name, description,
                price, is_available, image_url, created_at, updated_at
           FROM menu_items
          WHERE tenant_id = $1 AND branch_id ${clause}
          ORDER BY name`,
        values,
      )
      .then((result) => result.rows.map(toItemRow));
  }

  /**
   * Loads modifiers for every menu item in one round trip. The service derives
   * which items belong to the branch (org-wide + branch overrides); grouping by
   * `menu_item_id` here lets it stack prices per item without N queries.
   */
  async findModifiersForItems(
    connection: TenantScopedConnection,
    tenantId: string,
    itemIds: string[],
  ): Promise<Map<string, MenuItemModifierRow[]>> {
    if (itemIds.length === 0) {
      return new Map();
    }
    const placeholders = itemIds.map((_, index) => `$${index + 2}`).join(', ');
    const result = await connection.query<MenuItemModifierRow>(
      `SELECT id, tenant_id, menu_item_id, name, option_name, extra_price
         FROM menu_item_modifiers
        WHERE tenant_id = $1 AND menu_item_id IN (${placeholders})
        ORDER BY name, option_name`,
      [tenantId, ...itemIds],
    );
    const grouped = new Map<string, MenuItemModifierRow[]>();
    for (const row of result.rows.map(toModifierRow)) {
      const list = grouped.get(row.menu_item_id) ?? [];
      list.push(row);
      grouped.set(row.menu_item_id, list);
    }
    return grouped;
  }

  findCategoryById(
    connection: TenantScopedConnection,
    tenantId: string,
    categoryId: string,
  ): Promise<MenuCategoryRow | null> {
    return connection
      .query<MenuCategoryRow>(
        `SELECT id, tenant_id, branch_id, name, sort_order, created_at
           FROM menu_categories
          WHERE id = $1 AND tenant_id = $2`,
        [categoryId, tenantId],
      )
      .then((result) => result.rows[0] ?? null);
  }

  findItemById(
    connection: TenantScopedConnection,
    tenantId: string,
    itemId: string,
  ): Promise<MenuItemRow | null> {
    return connection
      .query<MenuItemRow>(
        `SELECT id, tenant_id, branch_id, category_id, name, description,
                price, is_available, image_url, created_at, updated_at
           FROM menu_items
           WHERE id = $1 AND tenant_id = $2`,
        [itemId, tenantId],
      )
      .then((result) => (result.rows[0] ? toItemRow(result.rows[0]) : null));
  }

  createCategory(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string | null,
    input: CreateCategoryInput,
  ): Promise<MenuCategoryRow> {
    return connection
      .query<MenuCategoryRow>(
        `INSERT INTO menu_categories (tenant_id, branch_id, name, sort_order)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, branch_id, name, sort_order, created_at`,
        [tenantId, branchId, input.name.trim(), input.sortOrder ?? 0],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('menu_categories insert returned no row');
        }
        return row;
      });
  }

  createItem(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string | null,
    categoryId: string | null,
    input: CreateItemInput,
  ): Promise<MenuItemRow> {
    return connection
      .query<MenuItemRow>(
        `INSERT INTO menu_items
           (tenant_id, branch_id, category_id, name, description, price,
            is_available, image_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, tenant_id, branch_id, category_id, name, description,
                   price, is_available, image_url, created_at, updated_at`,
        [
          tenantId,
          branchId,
          categoryId,
          input.name.trim(),
          input.description ?? null,
          input.price,
          input.isAvailable ?? true,
          input.imageUrl ?? null,
        ],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('menu_items insert returned no row');
        }
        return toItemRow(row);
      });
  }

  addModifier(
    connection: TenantScopedConnection,
    tenantId: string,
    itemId: string,
    input: PackagedModifierInput,
  ): Promise<MenuItemModifierRow> {
    return connection
      .query<MenuItemModifierRow>(
        `INSERT INTO menu_item_modifiers
           (tenant_id, menu_item_id, name, option_name, extra_price)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, menu_item_id, name, option_name, extra_price`,
        [
          tenantId,
          itemId,
          input.name.trim(),
          input.optionName.trim(),
          input.extraPrice,
        ],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('menu_item_modifiers insert returned no row');
        }
        return toModifierRow(row);
      });
  }

  setAvailable(
    connection: TenantScopedConnection,
    tenantId: string,
    itemId: string,
    available: boolean,
  ): Promise<MenuItemRow | null> {
    return connection
      .query<MenuItemRow>(
        `UPDATE menu_items
            SET is_available = $3, updated_at = now()
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, branch_id, category_id, name, description,
                    price, is_available, image_url, created_at, updated_at`,
        [itemId, tenantId, available],
      )
      .then((result) => (result.rows[0] ? toItemRow(result.rows[0]) : null));
  }

  updateItem(
    connection: TenantScopedConnection,
    tenantId: string,
    itemId: string,
    patch: Partial<CreateItemInput>,
  ): Promise<MenuItemRow | null> {
    const sets = ['updated_at = now()'];
    const values: unknown[] = [itemId, tenantId];
    const columns: Array<keyof CreateItemInput> = [
      'name',
      'description',
      'price',
      'isAvailable',
      'imageUrl',
      'categoryId',
    ];
    const columnMap: Record<string, string> = {
      name: 'name',
      description: 'description',
      price: 'price',
      isAvailable: 'is_available',
      imageUrl: 'image_url',
      categoryId: 'category_id',
    };
    for (const column of columns) {
      if (patch[column] !== undefined) {
        values.push(
          column === 'name' ? String(patch[column]).trim() : patch[column],
        );
        sets.push(`${columnMap[column]} = $${values.length}`);
      }
    }
    return connection
      .query<MenuItemRow>(
        `UPDATE menu_items
            SET ${sets.join(', ')}
          WHERE id = $1 AND tenant_id = $2
          RETURNING id, tenant_id, branch_id, category_id, name, description,
                    price, is_available, image_url, created_at, updated_at`,
        values,
      )
      .then((result) => (result.rows[0] ? toItemRow(result.rows[0]) : null));
  }
}
