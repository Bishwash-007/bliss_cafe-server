import type { MenuNode, RenderedItem, RenderedMenuNode } from './menu-node';

/**
 * Leaf of the composite — a single menu item. It "renders" itself straight
 * into its final `RenderedItem` shape. The price held here is the *decorated*
 * figure: a `ModifierDecorator` chain stacks every modifier's `extra_price`
 * onto `MenuItemRow.price` before the node is ever handed to the callers.
 */
export class MenuItemNode implements MenuNode {
  constructor(
    private readonly item: {
      id: string;
      name: string;
      branchId: string | null;
      categoryId: string | null;
      description: string | null;
      basePrice: number;
      /**
       * Base price + every stacked modifier. Computed by the service via the
       * pricing decorators (`BasePricedMenuItem` wrapped repeatedly by
       * `ModifierDecorator`), so leaves stay decorator-agnostic.
       */
      price: number;
      isAvailable: boolean;
      imageUrl: string | null;
      modifiers: {
        name: string;
        optionName: string;
        extraPrice: number;
      }[];
    },
  ) {}

  render(): RenderedItem {
    return {
      kind: 'item',
      id: this.item.id,
      name: this.item.name,
      branchId: this.item.branchId,
      categoryId: this.item.categoryId,
      description: this.item.description,
      basePrice: this.item.basePrice,
      price: this.item.price,
      isAvailable: this.item.isAvailable,
      imageUrl: this.item.imageUrl,
      modifiers: this.item.modifiers,
    };
  }

  private static assertNode(node: RenderedMenuNode): node is RenderedItem {
    return node.kind === 'item';
  }

  /** @internal — hidden from `MenuNode`; kept for tree-walking symmetry. */
  get itemKind(): 'item' {
    return 'item';
  }
}
