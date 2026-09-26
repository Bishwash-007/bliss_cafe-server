import type { MenuNode, RenderedCategory, RenderedItem } from './menu-node';

/**
 * Composite "branch" of the menu tree: a category CONTAINS items. It renders
 * itself as a `RenderedCategory` whose `items` are the rendered child leaves —
 * callers treat category + item uniformly (single `render()`), which is exactly
 * what the admin UI / customer app / KDS need when rendering or exporting a
 * whole menu.
 */
export class MenuCategoryNode implements MenuNode {
  constructor(
    private readonly category: {
      id: string;
      name: string;
      branchId: string | null;
      sortOrder: number;
    },
    private readonly childItems: RenderedItem[],
  ) {}

  render(): RenderedCategory {
    return {
      kind: 'category',
      id: this.category.id,
      name: this.category.name,
      branchId: this.category.branchId,
      sortOrder: this.category.sortOrder,
      items: this.childItems,
    };
  }
}
