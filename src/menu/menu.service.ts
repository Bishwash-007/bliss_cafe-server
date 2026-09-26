import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import {
  MenuRepository,
  type MenuCategoryRow,
  type MenuItemModifierRow,
  type MenuItemRow,
  type CreateCategoryInput,
  type CreateItemInput,
  type PackagedModifierInput,
} from './menu.repository';
import { MenuCategoryNode } from './composite/menu-category';
import { MenuItemNode } from './composite/menu-item';
import type {
  RenderedItem,
  RenderedMenuNode,
  RenderedModifier,
} from './composite/menu-node';
import type { PricedMenuItem } from './pricing/priced-menu-item';
import { BasePricedMenuItem } from './pricing/base-priced-menu-item';
import { ModifierDecorator } from './pricing/modifier.decorator';
import { MenuItemNotFoundException } from './exceptions/menu-not-found.exception';
import type {
  CreateCategoryDto,
  CreateItemDto,
  PackagedModifierDto,
} from './dto/menu.dto';

/**
 * A category after the org/branch merge: the single row the tree is rendered
 * from, plus every database id that maps onto it. A category the branch has
 * overridden is reachable by the org row's id AND the branch row's id, because
 * the schema has no "override-of" foreign key and clients legitimately create
 * branch items against either id.
 */
interface MergedCategory {
  row: MenuCategoryRow;
  sourceIds: Set<string>;
}

/**
 * ## The org-wide vs. branch MERGE rule (business decision — DO NOT flatten away)
 *
 * `menu_categories.branch_id` / `menu_items.branch_id` are NULLABLE:
 *   - `NULL`  → ORG-WIDE row (applies to every branch of the tenant)
 *   - value  → BRANCH row (applies to that branch only)
 *
 * The customer-facing menu for a branch is the ORG-WIDE tree MERGED with that
 * branch's overrides, joined by NAME (the schema deliberately keeps no
 * "override-of" foreign key, so the name is the merge key):
 *
 *   1. **Categories** — branch category whose `name` matches an org-wide
 *      category REPLACES it (branch wins, keeps the org `id`); a branch
 *      category with a NEW name is APPENDED. Catches are sorted by
 *      `sort_order`.
 *   2. **Items** — inside a merged category, a branch item whose `name`
 *      matches an org-wide item in the SAME category REPLACES it (branch
 *      wins); branch items with new names are APPENDED. Org-wide items with no
 *      branch counterpart stay visible everywhere they were.
 *   3. Org-wide rows, once overridden in a branch, are still returned for
 *      EVERY OTHER branch (they are not deleted, only shadowed for that one
 *      branch).
 *
 * This is a MERGE, not "pick one source": a café publishes a base menu across
 * all branches, then quietly overrides the price / image / availability of one
 * item just for one branch (e.g. a downtown branch charges a delivery premium
 * on espresso) — without creating a duplicate that hides the org-wide item
 * elsewhere.
 *
 * ## Pricing (Decorator / stacking — business logic lives HERE)
 *
 * Each rendered item's final `price` = `menu_items.price` (base) **plus the sum
 * of every modifier's `extra_price`**, built with the `BasePricedMenuItem`
 * wrapped once by `ModifierDecorator` per modifier. `basePrice` always keeps
 * the undecorated figure so the manager UI and the customer stub can both show
 * "base" vs "with adds" without needing a second writer.
 */
@Injectable()
export class MenuService {
  constructor(
    private readonly repository: MenuRepository,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private get tenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is missing');
    }
    return tenantId;
  }

  /**
   * Compose + render the FULL menu for one branch (customer-facing), merging
   * org-wide and branch rows by name. Pass `branchId === null` to render the
   * pure org-wide tree (used by org owners when authoring the template).
   */
  async getFullMenu(
    connection: TenantScopedConnection,
    branchId: string | null,
  ): Promise<RenderedMenuNode[]> {
    const tenantId = this.tenantId;

    // Sequential on purpose. `TenantScopedConnection` wraps a single `pg`
    // client, so `Promise.all` here would not parallelise anything — it would
    // just queue four statements on one client, which `pg` deprecates and will
    // reject in v9. The connection serialises them anyway; writing them in
    // order keeps the code honest about what is actually happening.
    const orgCategories = await this.repository.findCategories(
      connection,
      tenantId,
      null,
    );
    const orgItems = await this.repository.findItems(
      connection,
      tenantId,
      null,
    );
    const branchCategories =
      branchId === null
        ? []
        : await this.repository.findCategories(connection, tenantId, branchId);
    const branchItems =
      branchId === null
        ? []
        : await this.repository.findItems(connection, tenantId, branchId);

    const mergedCategories = this.mergeCategories(
      orgCategories,
      branchCategories,
    );

    // BOTH the org and the branch id of a merged category resolve to the same
    // category name, so a branch item may legally reference either one.
    const categoryNameById = new Map<string, string>();
    for (const entry of mergedCategories) {
      for (const id of entry.sourceIds) {
        categoryNameById.set(id, entry.row.name.toLowerCase());
      }
    }

    const orgByKey = new Map(
      orgItems.map((row) => [this.keyFor(row, categoryNameById), row]),
    );

    const mergedItems: MenuItemRow[] = [];
    const shadowedKeys = new Set<string>();

    // Branch rows are emitted first (they are the winners), remembering which
    // (category, item) pairs they shadowed so the org-wide twin is skipped.
    for (const row of branchItems) {
      mergedItems.push(row);
      const key = this.keyFor(row, categoryNameById);
      if (orgByKey.has(key)) {
        shadowedKeys.add(key);
      }
    }
    for (const row of orgItems) {
      const key = this.keyFor(row, categoryNameById);
      if (!shadowedKeys.has(key)) {
        mergedItems.push(row);
      }
    }

    return this.renderTree(connection, tenantId, mergedCategories, mergedItems);
  }

  private keyFor(
    row: MenuItemRow,
    categoryNameById: Map<string, string>,
  ): string {
    const categoryName = categoryNameById.get(row.category_id ?? '') ?? '';
    return `${categoryName}::${row.name.toLowerCase()}`;
  }

  private mergeCategories(
    org: MenuCategoryRow[],
    branch: MenuCategoryRow[],
  ): MergedCategory[] {
    const orgByName = new Map<string, MergedCategory>();
    for (const row of org) {
      orgByName.set(row.name.toLowerCase(), {
        row,
        sourceIds: new Set([row.id]),
      });
    }

    const merged = new Map<string, MergedCategory>(orgByName);

    for (const row of branch) {
      const key = row.name.toLowerCase();
      const existing = orgByName.get(key);
      if (existing) {
        // The branch row wins on every business field (name, sort_order), but the
        // ORG row's identity is preserved: `id` is the stable reference that
        // `menu_items.category_id` and `order_items` history hang off, and
        // re-keying it per branch would orphan those rows. The branch id is
        // still accepted for items (see `sourceIds`) and `branch_id` still
        // reports which branch carries the override.
        existing.row = {
          ...row,
          id: existing.row.id,
          tenant_id: existing.row.tenant_id,
        };
        existing.sourceIds.add(row.id);
      } else {
        merged.set(key, { row, sourceIds: new Set([row.id]) });
      }
    }

    return [...merged.values()].sort(
      (a, b) => a.row.sort_order - b.row.sort_order,
    );
  }

  private async renderTree(
    connection: TenantScopedConnection,
    tenantId: string,
    categories: MergedCategory[],
    items: MenuItemRow[],
  ): Promise<RenderedMenuNode[]> {
    const itemIds = items.map((row) => row.id);
    const modifiersByItem = await this.repository.findModifiersForItems(
      connection,
      tenantId,
      itemIds,
    );

    return categories.map((entry) => {
      const categoryItems = items
        .filter(
          (row) =>
            row.category_id !== null && entry.sourceIds.has(row.category_id),
        )
        .map((row) => this.renderItem(row, modifiersByItem.get(row.id) ?? []));

      return new MenuCategoryNode(
        {
          id: entry.row.id,
          name: entry.row.name,
          branchId: entry.row.branch_id,
          sortOrder: entry.row.sort_order,
        },
        categoryItems,
      ).render();
    });
  }

  private renderItem(
    row: MenuItemRow,
    modifiers: MenuItemModifierRow[],
  ): RenderedItem {
    const priced: PricedMenuItem = modifiers.reduce<PricedMenuItem>(
      (chain, modifier) => new ModifierDecorator(chain, modifier.extra_price),
      new BasePricedMenuItem(row.price),
    );

    const renderedModifiers: RenderedModifier[] = modifiers.map((modifier) => ({
      name: modifier.name,
      optionName: modifier.option_name,
      extraPrice: modifier.extra_price,
    }));

    return new MenuItemNode({
      id: row.id,
      name: row.name,
      branchId: row.branch_id,
      categoryId: row.category_id,
      description: row.description,
      basePrice: row.price,
      price: priced.getPrice(),
      isAvailable: row.is_available,
      imageUrl: row.image_url,
      modifiers: renderedModifiers,
    }).render();
  }

  async createCategory(
    connection: TenantScopedConnection,
    branchId: string | null,
    input: CreateCategoryDto,
  ): Promise<MenuCategoryRow> {
    return this.repository.createCategory(
      connection,
      this.tenantId,
      branchId,
      input satisfies CreateCategoryInput,
    );
  }

  async createItem(
    connection: TenantScopedConnection,
    branchId: string | null,
    input: CreateItemDto,
  ): Promise<MenuItemRow> {
    return this.repository.createItem(
      connection,
      this.tenantId,
      branchId,
      input.categoryId ?? null,
      input satisfies CreateItemInput,
    );
  }

  async addModifier(
    connection: TenantScopedConnection,
    itemId: string,
    input: PackagedModifierDto,
  ): Promise<MenuItemModifierRow> {
    const item = await this.repository.findItemById(
      connection,
      this.tenantId,
      itemId,
    );
    if (!item) {
      throw new MenuItemNotFoundException(itemId);
    }
    return this.repository.addModifier(
      connection,
      this.tenantId,
      itemId,
      input satisfies PackagedModifierInput,
    );
  }

  async setAvailable(
    connection: TenantScopedConnection,
    itemId: string,
    isAvailable: boolean,
  ): Promise<MenuItemRow> {
    const item = await this.repository.setAvailable(
      connection,
      this.tenantId,
      itemId,
      isAvailable,
    );
    if (!item) {
      throw new MenuItemNotFoundException(itemId);
    }
    return item;
  }

  async updateItem(
    connection: TenantScopedConnection,
    itemId: string,
    patch: Partial<CreateItemDto>,
  ): Promise<MenuItemRow> {
    const item = await this.repository.updateItem(
      connection,
      this.tenantId,
      itemId,
      patch satisfies Partial<CreateItemInput>,
    );
    if (!item) {
      throw new MenuItemNotFoundException(itemId);
    }
    return item;
  }
}
