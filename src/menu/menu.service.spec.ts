import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import {
  type MenuCategoryRow,
  type MenuItemModifierRow,
  type MenuItemRow,
} from './menu.repository';
import { MenuService } from './menu.service';
import type { RenderedCategory, RenderedMenuNode } from './composite/menu-node';
import { MenuItemNotFoundException } from './exceptions/menu-not-found.exception';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const B2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';

const CAT_DRINKS = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const CAT_FOOD = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';

function category(overrides: Partial<MenuCategoryRow> = {}): MenuCategoryRow {
  return {
    id: CAT_DRINKS,
    tenant_id: T1,
    branch_id: null,
    name: 'Drinks',
    sort_order: 0,
    created_at: new Date(),
    ...overrides,
  };
}

function item(overrides: Partial<MenuItemRow> = {}): MenuItemRow {
  return {
    id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    tenant_id: T1,
    branch_id: null,
    category_id: CAT_DRINKS,
    name: 'Flat White',
    description: null,
    price: 3.5,
    is_available: true,
    image_url: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function modifier(
  overrides: Partial<MenuItemModifierRow> = {},
): MenuItemModifierRow {
  return {
    id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    tenant_id: T1,
    menu_item_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
    name: 'Size',
    option_name: 'Large',
    extra_price: 0.75,
    ...overrides,
  };
}

describe('MenuService', () => {
  let service: MenuService;
  let repo: {
    findCategories: jest.Mock;
    findItems: jest.Mock;
    findModifiersForItems: jest.Mock;
    findItemById: jest.Mock;
    createCategory: jest.Mock;
    createItem: jest.Mock;
    addModifier: jest.Mock;
    setAvailable: jest.Mock;
    updateItem: jest.Mock;
  };
  let connection: TenantScopedConnection;

  beforeEach(() => {
    connection = {} as unknown as TenantScopedConnection;
    repo = {
      findCategories: jest.fn().mockResolvedValue([]),
      findItems: jest.fn().mockResolvedValue([]),
      findModifiersForItems: jest.fn().mockResolvedValue(new Map()),
      findItemById: jest.fn().mockResolvedValue(null),
      createCategory: jest.fn(),
      createItem: jest.fn(),
      addModifier: jest.fn(),
      setAvailable: jest.fn(),
      updateItem: jest.fn(),
    };
    const tenantContext = { tenantId: T1 } as TenantRequestContext;
    service = new MenuService(
      repo as unknown as ConstructorParameters<typeof MenuService>[0],
      tenantContext,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  /** Routes each `find*` mock by the branchId it is called with. */
  function givenRows(input: {
    orgCategories?: MenuCategoryRow[];
    orgItems?: MenuItemRow[];
    branchCategories?: MenuCategoryRow[];
    branchItems?: MenuItemRow[];
    modifiers?: Map<string, MenuItemModifierRow[]>;
  }): void {
    repo.findCategories.mockImplementation(
      (_c: unknown, _t: unknown, branchId: string | null) =>
        Promise.resolve(
          branchId === null
            ? (input.orgCategories ?? [])
            : (input.branchCategories ?? []),
        ),
    );
    repo.findItems.mockImplementation(
      (_c: unknown, _t: unknown, branchId: string | null) =>
        Promise.resolve(
          branchId === null
            ? (input.orgItems ?? [])
            : (input.branchItems ?? []),
        ),
    );
    repo.findModifiersForItems.mockResolvedValue(input.modifiers ?? new Map());
  }

  /** The item ids rendered under a category node, in render order. */
  function itemsOf(node: RenderedMenuNode): string[] {
    if (node.kind !== 'category') {
      throw new Error(`Expected a category node, received "${node.kind}"`);
    }
    return node.items.map((row) => row.id);
  }

  function findCategory(
    nodes: Awaited<ReturnType<MenuService['getFullMenu']>>,
    name: string,
  ): RenderedCategory {
    const found = nodes.find(
      (node): node is RenderedCategory =>
        node.kind === 'category' && node.name === name,
    );
    if (!found) {
      throw new Error(`category ${name} not rendered`);
    }
    return found;
  }

  describe('AC1 — org-wide item resolved against a branch override', () => {
    it('resolves to the branch override for the overriding branch', async () => {
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ id: 'i-org', name: 'Flat White', price: 3.5 })],
        branchItems: [
          item({
            id: 'i-branch',
            name: 'Flat White',
            price: 4.25,
            branch_id: B1,
          }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);
      const items = findCategory(tree, 'Drinks').items;

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('i-branch');
      expect(items[0].price).toBe(4.25);
    });

    it('still resolves to the org-wide version for every OTHER branch', async () => {
      // B2 has no rows at all — the org-wide twin must survive untouched.
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ id: 'i-org', name: 'Flat White', price: 3.5 })],
      });

      const tree = await service.getFullMenu(connection, B2);
      const items = findCategory(tree, 'Drinks').items;

      expect(items).toHaveLength(1);
      expect(items[0].id).toBe('i-org');
      expect(items[0].price).toBe(3.5);
    });

    it('appends a branch-only item that has no org-wide twin', async () => {
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ id: 'i-org', name: 'Flat White' })],
        branchItems: [
          item({
            id: 'i-branch-only',
            name: 'Cortado',
            price: 3.0,
            branch_id: B1,
          }),
        ],
      });

      const items = findCategory(
        await service.getFullMenu(connection, B1),
        'Drinks',
      ).items;

      expect(items.map((row) => row.name).sort()).toEqual([
        'Cortado',
        'Flat White',
      ]);
    });

    it('matches override by (category, item) name — same name in another category is untouched', async () => {
      givenRows({
        orgCategories: [category(), category({ id: CAT_FOOD, name: 'Food' })],
        orgItems: [
          item({ id: 'i-drink', name: 'Special', category_id: CAT_DRINKS }),
          item({ id: 'i-food', name: 'Special', category_id: CAT_FOOD }),
        ],
        branchItems: [
          item({
            id: 'i-branch',
            name: 'Special',
            price: 9.99,
            category_id: CAT_DRINKS,
            branch_id: B1,
          }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(findCategory(tree, 'Drinks').items[0].id).toBe('i-branch');
      // The identically-named item in a DIFFERENT category must not be shadowed.
      expect(findCategory(tree, 'Food').items[0].id).toBe('i-food');
    });

    it('replaces an org-wide category with a same-named branch category', async () => {
      givenRows({
        orgCategories: [category({ id: 'cat-org', sort_order: 1 })],
        branchCategories: [
          category({
            id: 'cat-branch',
            name: 'drinks', // case-insensitive match
            sort_order: 0,
            branch_id: B1,
          }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({
        kind: 'category',
        // branch wins on business fields...
        name: 'drinks',
        sortOrder: 0,
        // ...but the org row keeps the stable identity (documented above)
        id: 'cat-org',
      });
    });

    it('keeps org items visible when the branch overrides their category', async () => {
      givenRows({
        orgCategories: [category({ id: 'cat-org' })],
        orgItems: [item({ id: 'i-org', category_id: 'cat-org' })],
        branchCategories: [category({ id: 'cat-branch', branch_id: B1 })],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree[0]).toMatchObject({ id: 'cat-org' });
      expect(itemsOf(tree[0])).toEqual(['i-org']);
    });

    it('attaches a branch item that references the BRANCH category id', async () => {
      givenRows({
        orgCategories: [category({ id: 'cat-org' })],
        orgItems: [item({ id: 'i-org', category_id: 'cat-org' })],
        branchCategories: [category({ id: 'cat-branch', branch_id: B1 })],
        branchItems: [
          item({
            id: 'i-branch',
            category_id: 'cat-branch',
            branch_id: B1,
          }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree[0]).toMatchObject({ id: 'cat-org' });
      expect(itemsOf(tree[0])).toEqual(['i-branch']);
    });

    it('attaches a branch item that references the ORG category id', async () => {
      givenRows({
        orgCategories: [category({ id: 'cat-org' })],
        orgItems: [item({ id: 'i-org', category_id: 'cat-org' })],
        branchCategories: [category({ id: 'cat-branch', branch_id: B1 })],
        branchItems: [
          item({
            id: 'i-branch',
            category_id: 'cat-org',
            branch_id: B1,
          }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree[0]).toMatchObject({ id: 'cat-org' });
      expect(itemsOf(tree[0])).toEqual(['i-branch']);
    });

    it('renders the pure org-wide tree when branchId is null', async () => {
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ name: 'Flat White' })],
        branchItems: [item({ name: 'Ignored', branch_id: B1 })],
      });

      const tree = await service.getFullMenu(connection, null);

      expect(findCategory(tree, 'Drinks').items.map((row) => row.name)).toEqual(
        ['Flat White'],
      );
      // The branch rows were never fetched at all.
      expect(repo.findItems).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC2 — stacked modifiers produce the correct total', () => {
    it('sums three stacked extras onto the base price', async () => {
      const id = 'i-stack';
      const modifiers = new Map<string, MenuItemModifierRow[]>([
        [
          id,
          [
            modifier({ extra_price: 0.75, option_name: 'Large' }),
            modifier({ extra_price: 0.6, option_name: 'Oat milk' }),
            modifier({ extra_price: 0.4, option_name: 'Extra shot' }),
          ],
        ],
      ]);
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ id, price: 3.5 })],
        modifiers,
      });

      const rendered = findCategory(
        await service.getFullMenu(connection, B1),
        'Drinks',
      ).items[0];

      // 3.50 + 0.75 + 0.60 + 0.40 = 5.25
      expect(rendered.price).toBeCloseTo(5.25, 2);
      // The undecorated figure is preserved alongside the decorated one.
      expect(rendered.basePrice).toBe(3.5);
      expect(rendered.modifiers).toHaveLength(3);
      expect(rendered.modifiers[0]).toEqual({
        name: 'Size',
        optionName: 'Large',
        extraPrice: 0.75,
      });
    });

    it('leaves price == basePrice for an item with no modifiers', async () => {
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ price: 3.5 })],
      });

      const rendered = findCategory(
        await service.getFullMenu(connection, B1),
        'Drinks',
      ).items[0];

      expect(rendered.price).toBe(3.5);
      expect(rendered.basePrice).toBe(3.5);
      expect(rendered.modifiers).toEqual([]);
    });

    it('stacks modifiers onto the branch override price, not the org price', async () => {
      const id = 'i-branch-stack';
      givenRows({
        orgCategories: [category()],
        orgItems: [item({ id, price: 3.5 })],
        branchItems: [item({ id, price: 4.0, branch_id: B1 })],
        modifiers: new Map([[id, [modifier({ extra_price: 1.0 })]]]),
      });

      const rendered = findCategory(
        await service.getFullMenu(connection, B1),
        'Drinks',
      ).items[0];

      expect(rendered.basePrice).toBe(4.0);
      expect(rendered.price).toBeCloseTo(5.0, 2);
    });
  });

  describe('AC3 — the composite tree renders every shape', () => {
    it('renders an empty menu for zero categories', async () => {
      givenRows({});

      await expect(service.getFullMenu(connection, B1)).resolves.toEqual([]);
    });

    it('renders one category with no items', async () => {
      givenRows({ orgCategories: [category()] });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree).toEqual([
        {
          kind: 'category',
          id: CAT_DRINKS,
          name: 'Drinks',
          branchId: null,
          sortOrder: 0,
          items: [],
        },
      ]);
    });

    it('renders a nested multi-category menu in sort_order sequence', async () => {
      givenRows({
        orgCategories: [
          category({ id: CAT_FOOD, name: 'Food', sort_order: 5 }),
          category({ id: CAT_DRINKS, name: 'Drinks', sort_order: 1 }),
          category({ id: 'cat-3', name: 'Desserts', sort_order: 9 }),
        ],
        orgItems: [
          item({ id: 'i-1', name: 'Flat White', category_id: CAT_DRINKS }),
          item({ id: 'i-2', name: 'Latte', category_id: CAT_DRINKS }),
          item({ id: 'i-3', name: 'Toast', category_id: CAT_FOOD }),
        ],
      });

      const tree = await service.getFullMenu(connection, B1);

      expect(tree.map((node) => node.kind === 'category' && node.name)).toEqual(
        ['Drinks', 'Food', 'Desserts'],
      );
      const drinks = findCategory(tree, 'Drinks');
      expect(drinks.items.map((row) => row.name)).toEqual([
        'Flat White',
        'Latte',
      ]);
      expect(findCategory(tree, 'Food').items.map((row) => row.name)).toEqual([
        'Toast',
      ]);
      // The empty category still renders as a node.
      expect(findCategory(tree, 'Desserts').items).toEqual([]);
    });

    it('carries every rendered field through to the leaf', async () => {
      givenRows({
        orgCategories: [category()],
        orgItems: [
          item({
            name: 'Flat White',
            description: 'Double shot',
            is_available: false,
            image_url: 'https://img.test/fw.png',
          }),
        ],
      });

      const rendered = findCategory(
        await service.getFullMenu(connection, B1),
        'Drinks',
      ).items[0];

      expect(rendered).toEqual({
        kind: 'item',
        id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1',
        name: 'Flat White',
        branchId: null,
        categoryId: CAT_DRINKS,
        description: 'Double shot',
        basePrice: 3.5,
        price: 3.5,
        isAvailable: false,
        imageUrl: 'https://img.test/fw.png',
        modifiers: [],
      });
    });
  });

  describe('AC4 — soft delete keeps the row (and history) alive', () => {
    it('soft-deletes by flipping is_available, never by deleting the row', async () => {
      repo.setAvailable.mockResolvedValue(item({ is_available: false }));

      const row = await service.setAvailable(connection, 'i-1', false);

      expect(repo.setAvailable).toHaveBeenCalledWith(
        connection,
        T1,
        'i-1',
        false,
      );
      expect(row.is_available).toBe(false);
    });

    it('can restore an item by flipping availability back', async () => {
      repo.setAvailable.mockResolvedValue(item({ is_available: true }));

      const row = await service.setAvailable(connection, 'i-1', true);

      expect(row.is_available).toBe(true);
    });

    it('404s when soft-deleting an item that does not exist', async () => {
      repo.setAvailable.mockResolvedValue(null);

      await expect(
        service.setAvailable(connection, 'missing', false),
      ).rejects.toBeInstanceOf(MenuItemNotFoundException);
    });

    it('404s when editing an item that does not exist', async () => {
      repo.updateItem.mockResolvedValue(null);

      await expect(
        service.updateItem(connection, 'missing', { name: 'New' }),
      ).rejects.toBeInstanceOf(MenuItemNotFoundException);
    });
  });

  describe('tenant scoping', () => {
    it('throws when the tenant context is missing', async () => {
      const serviceWithoutTenant = new MenuService(
        repo as unknown as ConstructorParameters<typeof MenuService>[0],
        { tenantId: null } as unknown as TenantRequestContext,
      );

      await expect(
        serviceWithoutTenant.getFullMenu(connection, B1),
      ).rejects.toThrow('Tenant context is missing');
    });

    it('passes the tenant id to every repository read', async () => {
      givenRows({ orgCategories: [category()] });

      await service.getFullMenu(connection, B1);

      expect(repo.findCategories).toHaveBeenCalledWith(connection, T1, null);
      expect(repo.findCategories).toHaveBeenCalledWith(connection, T1, B1);
      expect(repo.findItems).toHaveBeenCalledWith(connection, T1, null);
      expect(repo.findItems).toHaveBeenCalledWith(connection, T1, B1);
      expect(repo.findModifiersForItems).toHaveBeenCalledWith(
        connection,
        T1,
        expect.any(Array),
      );
    });
  });

  describe('write passthrough', () => {
    it('creates an org-wide category when branchId is null', async () => {
      repo.createCategory.mockResolvedValue(category());

      await service.createCategory(connection, null, { name: 'Drinks' });

      expect(repo.createCategory).toHaveBeenCalledWith(connection, T1, null, {
        name: 'Drinks',
      });
    });

    it('creates a branch category scoped to that branch', async () => {
      repo.createCategory.mockResolvedValue(category({ branch_id: B1 }));

      await service.createCategory(connection, B1, {
        name: 'Drinks',
        sortOrder: 2,
      });

      expect(repo.createCategory).toHaveBeenCalledWith(connection, T1, B1, {
        name: 'Drinks',
        sortOrder: 2,
      });
    });

    it('forwards categoryId when creating an item', async () => {
      repo.createItem.mockResolvedValue(item());

      await service.createItem(connection, B1, {
        name: 'Flat White',
        price: 3.5,
        categoryId: CAT_DRINKS,
      });

      expect(repo.createItem).toHaveBeenCalledWith(
        connection,
        T1,
        B1,
        CAT_DRINKS,
        { name: 'Flat White', price: 3.5, categoryId: CAT_DRINKS },
      );
    });

    it('passes null categoryId for an uncategorised item', async () => {
      repo.createItem.mockResolvedValue(item({ category_id: null }));

      await service.createItem(connection, null, {
        name: 'Mystery',
        price: 1,
      });

      expect(repo.createItem).toHaveBeenCalledWith(connection, T1, null, null, {
        name: 'Mystery',
        price: 1,
      });
    });

    it('guards modifier creation behind an existing item', async () => {
      repo.findItemById.mockResolvedValue(item());
      repo.addModifier.mockResolvedValue(modifier());

      await service.addModifier(connection, 'i-1', {
        name: 'Size',
        optionName: 'Large',
        extraPrice: 0.75,
      });

      expect(repo.findItemById).toHaveBeenCalledWith(connection, T1, 'i-1');
      expect(repo.addModifier).toHaveBeenCalledWith(connection, T1, 'i-1', {
        name: 'Size',
        optionName: 'Large',
        extraPrice: 0.75,
      });
    });

    it('refuses to attach a modifier to a missing item', async () => {
      repo.findItemById.mockResolvedValue(null);

      await expect(
        service.addModifier(connection, 'missing', {
          name: 'Size',
          optionName: 'Large',
          extraPrice: 1,
        }),
      ).rejects.toBeInstanceOf(MenuItemNotFoundException);
      expect(repo.addModifier).not.toHaveBeenCalled();
    });

    it('returns the updated row on a partial edit', async () => {
      repo.updateItem.mockResolvedValue(item({ price: 4.75 }));

      const row = await service.updateItem(connection, 'i-1', { price: 4.75 });

      expect(repo.updateItem).toHaveBeenCalledWith(connection, T1, 'i-1', {
        price: 4.75,
      });
      expect(row.price).toBe(4.75);
    });
  });
});
