import { ROLES_KEY } from '../auth/auth.constants';
import { BranchAccessDeniedException } from './exceptions/inventory.exceptions';
import { BadRequestException } from '@nestjs/common';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { InventoryController } from './inventory.controller';
import type { InventoryService } from './inventory.service';

/** Roles attached to a handler, or `undefined` when it has no `@Roles`. */
function rolesOf(method: string): string[] | undefined {
  const roles = Reflect.getMetadata(
    ROLES_KEY,
    (InventoryController.prototype as never)[method],
  ) as string[] | undefined;
  return roles?.slice().sort();
}

const WRITE = ['branch_manager', 'org_owner', 'super_admin'];
const READ = [
  'branch_manager',
  'kitchen_staff',
  'org_owner',
  'receptionist',
  'super_admin',
];

/**
 * A request carrying an authenticated user.
 *
 * The role is what the controller reads, so the helper takes it. Omitting it picks
 * the pairing that onboarding actually produces: no branch in the token means an
 * `org_owner`, a real branch means a `branch_manager`.
 */
function request(user: {
  branchId?: string | null;
  role?: string;
}): AuthedRequest {
  const branchId = user.branchId ?? null;
  return {
    user: {
      branchId,
      role: user.role ?? (branchId ? 'branch_manager' : 'org_owner'),
    },
  } as unknown as AuthedRequest;
}

/** The request type the controller's handlers take, re-declared for the tests. */
type AuthedRequest = Parameters<InventoryController['listItems']>[1];

function build(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const service = {
    createSupplier: jest.fn(),
    listSuppliers: jest.fn(),
    getSupplier: jest.fn(),
    updateSupplier: jest.fn(),
    deleteSupplier: jest.fn(),
    createItem: jest.fn(),
    listItems: jest.fn(),
    getItem: jest.fn(),
    stockIn: jest.fn(),
    adjustStock: jest.fn(),
    listMovements: jest.fn(),
    setReorderThreshold: jest.fn(),
    setRecipeIngredient: jest.fn(),
    removeRecipeIngredient: jest.fn(),
    listDiscrepancies: jest.fn(),
    ...overrides,
  };
  // Deliberately NOT annotated `jest.Mocked<InventoryService>`: that maps methods
  // to method signatures, and `expect(service.stockIn)` then trips
  // `unbound-method`. The inferred object type keeps each mock a PROPERTY, which
  // is both what jest produces and what the lint rule wants.

  const connection = {} as TenantScopedConnection;
  const context = {
    getConnection: () => connection,
  } as unknown as TenantRequestContext;

  return {
    controller: new InventoryController(
      service as unknown as InventoryService,
      context,
    ),
    service,
    connection,
  };
}

const user = (branchId: string | null = 'branch-1', role?: string) =>
  ({
    user: {
      userId: 'user-1',
      branchId,
      role: role ?? (branchId ? 'branch_manager' : 'org_owner'),
    },
  }) as never;

describe('InventoryController RBAC', () => {
  it('restricts every stock write to the three management roles', () => {
    // A waiter must not be able to declare that 40 kg of flour arrived.
    for (const method of [
      'createSupplier',
      'createItem',
      'stockIn',
      'adjustStock',
      'setReorderThreshold',
      'setRecipeIngredient',
      'removeRecipeIngredient',
    ]) {
      expect(rolesOf(method)).toEqual(WRITE);
    }
  });

  it('lets the kitchen read stock without letting it change any', () => {
    // The kitchen needs today's remaining stock to know what it can still cook.
    for (const method of [
      'listSuppliers',
      'getSupplier',
      'listItems',
      'getItem',
      'listMovements',
      'listDiscrepancies',
    ]) {
      expect(rolesOf(method)).toEqual(READ);
    }
    expect(rolesOf('stockIn')).not.toContain('kitchen_staff');
    expect(rolesOf('stockIn')).not.toContain('waiter');
  });

  it('keeps a waiter out of inventory entirely', () => {
    for (const method of ['listItems', 'stockIn', 'listDiscrepancies']) {
      expect(rolesOf(method)).not.toContain('waiter');
    }
  });

  it('detects the decorator rather than always finding something', () => {
    // Proves the assertions above are real: if `rolesOf` returned a non-empty
    // list for any method, these would pass no matter what the controller said.
    // `connection` is a real method with no `@Roles` on it.
    expect(rolesOf('connection')).toBeUndefined();
  });

  it('reads a different list per method', () => {
    expect(rolesOf('stockIn')).not.toEqual(rolesOf('listItems'));
  });
});

describe('InventoryController attribution', () => {
  it('records who received a delivery', async () => {
    const { controller, service } = build();
    await controller.stockIn(
      'item-1',
      { quantity: 20, note: 'delivery' },
      user('branch-1'),
    );
    expect(service.stockIn).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: 'branch-1' },
      'item-1',
      20,
      expect.objectContaining({ createdBy: 'user-1' }),
    );
  });

  it('records who made a stocktake correction', async () => {
    const { controller, service } = build();
    await controller.adjustStock(
      'item-1',
      { quantity: -2, note: 'recount' },
      user('branch-1'),
    );
    expect(service.adjustStock).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: 'branch-1' },
      'item-1',
      -2,
      'recount',
      'user-1',
    );
  });

  it('leaves created_by null when the request has no user', async () => {
    // A visible null beats a fabricated placeholder: a missing user should be
    // findable in the audit trail.
    const { controller, service } = build();
    await controller.stockIn('item-1', { quantity: 5 }, {} as never);
    expect(service.stockIn).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: null },
      'item-1',
      5,
      expect.objectContaining({ createdBy: null }),
    );
  });
});

describe('InventoryController recipe branch', () => {
  it('uses the branch already in the caller token', async () => {
    const { controller, service } = build();
    await controller.setRecipeIngredient(
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      user('branch-7'),
    );
    expect(service.setRecipeIngredient).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: 'branch-7' },
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      'branch-7',
    );
  });

  it('REFUSES an explicit branchId that disagrees with the token', async () => {
    // This used to be allowed, and it was a complete bypass: the token said
    // branch-7, the query string said branch-8, and the recipe was wired to
    // branch-8's stock. One request parameter was enough to edit another branch's
    // recipes, and the deduction path would then silently refuse the dish.
    const { controller, service } = build();
    await expect(
      controller.setRecipeIngredient(
        { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
        user('branch-7'),
        'branch-8',
      ),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);
    expect(service.setRecipeIngredient).not.toHaveBeenCalled();
  });

  it('does NOT confine an org_owner who has a branch in their token', async () => {
    // Onboarding creates the `org_owner` against the tenant's DEFAULT branch, so a
    // real owner's token carries a branch id even though the role runs the whole
    // org. The scope was first derived from the presence of that id, which locked
    // the owner out of every branch but the first -- caught by the e2e suite
    // refusing a stock-in to a sibling branch.
    const { controller, service } = build();
    await controller.setRecipeIngredient(
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      user('branch-7', 'org_owner'),
      'branch-8',
    );
    expect(service.setRecipeIngredient).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: null },
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      'branch-8',
    );
  });

  it('accepts an explicit branchId that AGREES with the token', async () => {
    // Redundant, not contradictory: a client that sends its own branch should not
    // be punished for it.
    const { controller, service } = build();
    await controller.setRecipeIngredient(
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      user('branch-7'),
      'branch-7',
    );
    expect(service.setRecipeIngredient).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: 'branch-7' },
      expect.anything(),
      'branch-7',
    );
  });

  it('lets a tenant-wide operator name the branch, since it has none', async () => {
    const { controller, service } = build();
    await controller.setRecipeIngredient(
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
      user(null),
      'branch-8',
    );
    expect(service.setRecipeIngredient).toHaveBeenCalledWith(
      expect.anything(),
      { branchId: null },
      expect.anything(),
      'branch-8',
    );
  });

  it('refuses a recipe edit from a tenant-wide operator with no branch named', async () => {
    // Guessing would let a recipe be attached to an arbitrary branch's stock, so
    // this is a 400 rather than a silent default.
    const { controller, service } = build();
    await expect(
      controller.setRecipeIngredient(
        { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
        user(null),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(service.setRecipeIngredient).not.toHaveBeenCalled();
  });
});

describe('InventoryController supplier writes', () => {
  /**
   * A PATCH must send only the keys the client actually included.
   *
   * This is the controller's job, not the repository's: by the time the service
   * sees the patch, an absent field and a field the controller invented are the
   * same thing. Copying the DTO field-by-field with `?? null` is the natural
   * mistake and it is destructive — renaming a supplier would silently erase both
   * of its contact details, every time.
   */
  it('forwards only the keys present in the body', () => {
    const { controller, service, connection } = build();

    void controller.updateSupplier('sup-1', { name: 'Renamed' });

    expect(service.updateSupplier).toHaveBeenCalledWith(connection, 'sup-1', {
      name: 'Renamed',
    });
    // The absent keys are ABSENT, not null.
    const [call] = service.updateSupplier.mock.calls as unknown as [
      [unknown, string, object],
    ];
    expect(Object.keys(call[2])).toEqual(['name']);
  });

  it('preserves an explicit null, which means "clear this"', () => {
    const { controller, service } = build();

    void controller.updateSupplier('sup-1', { contactPhone: null });

    // Distinguishable from omitting the key, which is what lets a wrong phone
    // number be removed as well as corrected.
    expect(service.updateSupplier).toHaveBeenCalledWith(
      expect.anything(),
      'sup-1',
      { contactPhone: null },
    );
  });

  it('sends an empty patch when the body is empty, rather than a full null overwrite', () => {
    const { controller, service } = build();

    void controller.updateSupplier('sup-1', {});

    expect(service.updateSupplier).toHaveBeenCalledWith(
      expect.anything(),
      'sup-1',
      {},
    );
  });

  it('uses the request connection for the delete', async () => {
    const { controller, service, connection } = build();
    service.deleteSupplier.mockResolvedValue(undefined);

    await controller.deleteSupplier('sup-1');

    expect(service.deleteSupplier).toHaveBeenCalledWith(connection, 'sup-1');
  });

  it('gates supplier updates and deletes behind the write roles', () => {
    expect(rolesOf('updateSupplier')).toEqual(WRITE);
    expect(rolesOf('deleteSupplier')).toEqual(WRITE);
  });
});

describe('InventoryController connection use', () => {
  it('always works on the request connection, so RLS is never bypassed', () => {
    const { controller, service, connection } = build();
    void controller.listItems(undefined, request({ branchId: null }));
    expect(service.listItems).toHaveBeenCalledWith(
      connection,
      { branchId: null },
      undefined,
    );
  });

  it('passes an optional branch filter through to the service', () => {
    const { controller, service, connection } = build();
    void controller.listItems('branch-3', request({ branchId: null }));
    expect(service.listItems).toHaveBeenCalledWith(
      connection,
      { branchId: null },
      'branch-3',
    );
  });

  it('defaults the discrepancy list to the review queue', async () => {
    // With no status filter the useful question is "what do I need to fix?", not
    // "show me 40,000 settled deductions".
    const { controller, service, connection } = build();
    await controller.listDiscrepancies(user(null), {});
    expect(service.listDiscrepancies).toHaveBeenCalledWith(
      connection,
      { branchId: null },
      undefined,
    );
  });

  it('scopes the discrepancy list to a branch manager', async () => {
    // A failed deduction names the ingredient and the shortfall. Tenant-wide, that
    // is a running account of every other branch's stock problems, so the list is
    // scoped like any other read.
    const { controller, service, connection } = build();
    await controller.listDiscrepancies(user('branch-4'), {});
    expect(service.listDiscrepancies).toHaveBeenCalledWith(
      connection,
      { branchId: 'branch-4' },
      undefined,
    );
  });
});
