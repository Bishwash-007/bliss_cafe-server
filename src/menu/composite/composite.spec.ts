import { MenuCategoryNode } from './menu-category';
import { MenuItemNode } from './menu-item';
import type { MenuNode, RenderedItem } from './menu-node';

function leaf(overrides: Partial<RenderedItem> = {}): MenuItemNode {
  return new MenuItemNode({
    id: 'i1',
    name: 'Flat White',
    branchId: null,
    categoryId: 'c1',
    description: null,
    basePrice: 3.5,
    price: 3.5,
    isAvailable: true,
    imageUrl: null,
    modifiers: [],
    ...overrides,
  });
}

describe('menu composite', () => {
  describe('MenuItemNode (leaf)', () => {
    it('renders a tagged item node', () => {
      expect(leaf().render()).toMatchObject({
        kind: 'item',
        id: 'i1',
        name: 'Flat White',
        basePrice: 3.5,
        price: 3.5,
      });
    });

    it('keeps the decorated price distinct from the base price', () => {
      const node = leaf({ basePrice: 3.5, price: 5.25 });

      expect(node.render().price).toBe(5.25);
      expect(node.render().basePrice).toBe(3.5);
    });

    it('is itself a MenuNode, so callers treat it uniformly', () => {
      const asNode: MenuNode = leaf();

      expect(typeof asNode.render).toBe('function');
      expect(asNode.render().kind).toBe('item');
    });
  });

  describe('MenuCategoryNode (composite)', () => {
    it('renders an empty category with an empty items array', () => {
      const node = new MenuCategoryNode(
        { id: 'c1', name: 'Drinks', branchId: null, sortOrder: 0 },
        [],
      );

      expect(node.render()).toEqual({
        kind: 'category',
        id: 'c1',
        name: 'Drinks',
        branchId: null,
        sortOrder: 0,
        items: [],
      });
    });

    it('CONTAINS its rendered child items', () => {
      const node = new MenuCategoryNode(
        { id: 'c1', name: 'Drinks', branchId: null, sortOrder: 0 },
        [leaf().render(), leaf({ id: 'i2', name: 'Latte' }).render()],
      );

      const rendered = node.render();

      expect(rendered.kind).toBe('category');
      if (rendered.kind !== 'category') {
        throw new Error('expected a category node');
      }
      expect(rendered.items.map((row) => row.name)).toEqual([
        'Flat White',
        'Latte',
      ]);
    });

    it('carries a branchId so a branch override is identifiable downstream', () => {
      const node = new MenuCategoryNode(
        { id: 'c1', name: 'Drinks', branchId: 'b1', sortOrder: 2 },
        [],
      );

      expect(node.render()).toMatchObject({ branchId: 'b1', sortOrder: 2 });
    });

    it('walks a whole multi-category menu through the one render() entry point', () => {
      const tree: MenuNode[] = [
        new MenuCategoryNode(
          { id: 'c1', name: 'Drinks', branchId: null, sortOrder: 0 },
          [leaf().render()],
        ),
        new MenuCategoryNode(
          { id: 'c2', name: 'Food', branchId: null, sortOrder: 1 },
          [],
        ),
      ];

      const kinds = tree.map((node) => node.render().kind);

      expect(kinds).toEqual(['category', 'category']);
    });
  });
});
