/**
 * Composite: treat the whole menu tree uniformly when rendering, exporting, or
 * searching. Both `MenuCategoryNode` (composite, "contains" items) and
 * `MenuItemNode` (leaf) implement this single node interface — callers only
 * ever see `render()`.
 */

export interface RenderedModifier {
  name: string;
  optionName: string;
  extraPrice: number;
}

export interface RenderedItem {
  kind: 'item';
  id: string;
  name: string;
  branchId: string | null;
  categoryId: string | null;
  description: string | null;
  /** Base `menu_items.price` — the undecorated figure. */
  basePrice: number;
  /** Base price after stacking every modifier (`ModifierDecorator` chain). */
  price: number;
  isAvailable: boolean;
  imageUrl: string | null;
  modifiers: RenderedModifier[];
}

export interface RenderedCategory {
  kind: 'category';
  id: string;
  name: string;
  branchId: string | null;
  sortOrder: number;
  items: RenderedItem[];
}

/** Union of every node shape `render()` can produce. */
export type RenderedMenuNode = RenderedCategory | RenderedItem;

export interface MenuNode {
  render(): RenderedMenuNode;
}
