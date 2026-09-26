import { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { ThresholdAlertStrategy } from './alerting/threshold-alert.strategy';
import { ReorderStrategyRegistry } from './alerting/reorder-strategy.registry';
import { INVENTORY_EVENTS } from './events/inventory-events';
import {
  BranchAccessDeniedException,
  InvalidQuantityException,
  InventoryItemNotFoundException,
  SupplierInUseException,
  SupplierNotFoundException,
} from './exceptions/inventory.exceptions';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import type {
  DeductionRow,
  DeductionStatus,
  InventoryActor,
  InventoryItem,
  StockMovement,
  SupplierRow,
} from './inventory.types';

const TENANT = 'tenant-1';
const ORDER = 'order-1';
const BRANCH = 'branch-1';

/**
 * Tenant-wide by default, i.e. an `org_owner`: no branch in the token, so not
 * branch-scoped. The pre-existing assertions are about quantity, atomicity and
 * dedup, and pinning them to a branch would only add a second thing to read.
 */
const OWNER: InventoryActor = { branchId: null };

/** A `branch_manager` of BRANCH, who may not touch anything else. */
const MANAGER: InventoryActor = { branchId: BRANCH };

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-1',
    tenantId: TENANT,
    branchId: 'branch-1',
    name: 'Whole milk',
    unit: 'l',
    quantityOnHand: 10,
    reorderThreshold: 5,
    supplierId: null,
    ...overrides,
  };
}

/**
 * A stand-in for `TenantScopedConnection` that reproduces the two behaviours the
 * service actually depends on: statements are recorded in order, and
 * `onCommit` callbacks fire only after a real commit.
 *
 * Modelling the commit hook rather than calling it immediately is the point of
 * this fake: a service that published an alert before committing would pass
 * against a naive stub and fail in production, where a rolled-back stock write
 * would still have notified a manager.
 */
class FakeConnection {
  readonly statements: string[] = [];
  commitCount = 0;
  rollbackCount = 0;
  releaseCount = 0;
  private onCommitCallbacks: Array<() => void> = [];
  private ended: 'committed' | 'rolledback' | null = null;

  constructor(readonly tenantId: string | null = TENANT) {}

  query(text: string): Promise<{ rows: unknown[]; rowCount: number }> {
    this.statements.push(text.replace(/\s+/g, ' ').trim());
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  onCommit(fn: () => void): void {
    this.onCommitCallbacks.push(fn);
  }

  commit(): Promise<void> {
    this.commitCount += 1;
    this.ended = 'committed';
    const callbacks = this.onCommitCallbacks;
    this.onCommitCallbacks = [];
    for (const callback of callbacks) {
      callback();
    }
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.rollbackCount += 1;
    this.ended = 'rolledback';
    // A real transaction discards the hooks; so does this.
    this.onCommitCallbacks = [];
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.releaseCount += 1;
    return Promise.resolve();
  }

  get outcome(): string {
    return this.ended ?? 'open';
  }

  ran(sql: string): boolean {
    return this.statements.some((s) => s.includes(sql));
  }
}

interface Harness {
  service: InventoryService;
  repository: MockedRepository;
  /** Every connection the service acquired, in order. */
  acquired: FakeConnection[];
  emit: jest.Mock;
  requestConnection: FakeConnection;
  connections: { acquireScoped: jest.Mock };
  events: EventEmitter2;
}

function harness(options: { requestTenant?: string | null } = {}): Harness {
  const repository = {
    createSupplier: jest.fn(),
    listSuppliers: jest.fn(),
    findSupplier: jest.fn(),
    createItem: jest.fn(),
    listItems: jest.fn(),
    findItem: jest.fn(() => Promise.resolve(item())),
    applyDelta: jest.fn(),
    setReorderThreshold: jest.fn(),
    listRecipeIngredients: jest.fn(),
    upsertRecipeIngredient: jest.fn(),
    removeRecipeIngredient: jest.fn(),
    ingredientsForOrder: jest.fn(),
    crossBranchIngredients: jest.fn(),
    menuItemsWithoutRecipe: jest.fn(),
    recordMovement: jest.fn(() => Promise.resolve(movement())),
    listMovements: jest.fn(),
    claimDeduction: jest.fn(),
    findDeduction: jest.fn(),
    completeDeduction: jest.fn(),
    recordDeductionFailure: jest.fn(),
    listDiscrepancies: jest.fn(),
    findRecipeIngredient: jest.fn(),
    updateSupplier: jest.fn(),
    countItemsForSupplier: jest.fn(),
    deleteSupplier: jest.fn(),
  };

  const requestConnection = new FakeConnection(
    options.requestTenant === undefined ? TENANT : options.requestTenant,
  );
  const emit = jest.fn();

  // Connections are captured as they are handed out, so an assertion can name
  // "the connection used for the deduction" without reaching into `mock.results`
  // (which is untyped and trips `no-unsafe-member-access`).
  const acquired: FakeConnection[] = [];
  const connections = {
    acquireScoped: jest.fn(() => {
      const connection = new FakeConnection(TENANT);
      acquired.push(connection);
      return Promise.resolve(connection);
    }),
  };

  // The service takes NO request context: it is a plain singleton, and the tenant
  // travels as an argument (from the controller, or from the event payload).
  const service = new InventoryService(
    repository as unknown as InventoryRepository,
    connections as unknown as TenantConnectionService,
    new ReorderStrategyRegistry([new ThresholdAlertStrategy()], {
      strategyFor: () => null,
    }),
    { emit } as unknown as EventEmitter2,
  );

  return {
    service,
    repository,
    emit,
    requestConnection,
    connections,
    acquired,
    events: emit as unknown as EventEmitter2,
  };
}

const noCrossBranch = jest.fn(() => Promise.resolve([]));

/**
 * The repository as a bag of mocks.
 *
 * A mapped type rather than `jest.Mocked<InventoryRepository>`, because that one
 * preserves each entry as a METHOD signature — and then `expect(repo.applyDelta)`
 * trips `unbound-method`, for no benefit. Here every entry is a property, which
 * is what `jest.fn()` actually produces.
 */
type MockedRepository = { [K in keyof InventoryRepository]: jest.Mock };

function movement(overrides: Partial<StockMovement> = {}): StockMovement {
  return {
    id: 'mv-1',
    inventoryItemId: 'item-1',
    movementType: 'purchase',
    quantity: 1,
    referenceOrderId: null,
    note: null,
    createdBy: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function deductionRow(status: DeductionStatus): DeductionRow {
  return {
    id: 'dd-1',
    tenant_id: TENANT,
    order_id: ORDER,
    status,
    detail: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

describe('InventoryService supplier management', () => {
  function supplier(overrides: Partial<SupplierRow> = {}): SupplierRow {
    return {
      id: 'sup-1',
      tenant_id: TENANT,
      name: 'Valley Dairy',
      contact_phone: '9800000000',
      contact_email: 'orders@valleydairy.test',
      created_at: new Date(0),
      ...overrides,
    };
  }

  it('forwards a partial update with only the keys it was given', async () => {
    const h = harness();
    h.repository.updateSupplier.mockResolvedValue(
      supplier({ name: 'Renamed' }),
    );
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    const result = await h.service.updateSupplier(connection, 'sup-1', {
      name: 'Renamed',
    });

    // The patch is passed through untouched: the repository, not the service,
    // decides which columns a present key writes. Copying the DTO with `?? null`
    // here would have made every PATCH clear both contact details.
    expect(h.repository.updateSupplier).toHaveBeenCalledWith(
      connection,
      'sup-1',
      { name: 'Renamed' },
    );
    expect(result.name).toBe('Renamed');
  });

  it('reports an update to a supplier that is not there as 404', async () => {
    const h = harness();
    h.repository.updateSupplier.mockResolvedValue(null);
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    await expect(
      h.service.updateSupplier(connection, 'sup-1', { name: 'x' }),
    ).rejects.toBeInstanceOf(SupplierNotFoundException);
  });

  it('deletes a supplier that nothing points at', async () => {
    const h = harness();
    h.repository.countItemsForSupplier.mockResolvedValue(0);
    h.repository.deleteSupplier.mockResolvedValue(true);
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    await h.service.deleteSupplier(connection, 'sup-1');

    expect(h.repository.deleteSupplier).toHaveBeenCalledWith(
      connection,
      'sup-1',
    );
  });

  it('refuses to delete a supplier that still supplies items, as a 409', async () => {
    const h = harness();
    h.repository.countItemsForSupplier.mockResolvedValue(2);
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    // The FK would reject this anyway; the count turns an unactionable 500 into a
    // 409 that says how many items are in the way.
    await expect(
      h.service.deleteSupplier(connection, 'sup-1'),
    ).rejects.toBeInstanceOf(SupplierInUseException);
    expect(h.repository.deleteSupplier).not.toHaveBeenCalled();
  });

  it('reports a delete of a supplier that is not there as 404', async () => {
    const h = harness();
    h.repository.countItemsForSupplier.mockResolvedValue(0);
    h.repository.deleteSupplier.mockResolvedValue(false);
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    await expect(
      h.service.deleteSupplier(connection, 'sup-1'),
    ).rejects.toBeInstanceOf(SupplierNotFoundException);
  });
});

describe('InventoryService branch scoping', () => {
  /**
   * RLS cannot do this job. Two branches of one cafe share a tenant, so every
   * RLS policy is satisfied and branch B's stock is fully reachable by branch A's
   * manager. These tests pin the application-level check that closes it.
   */
  function otherBranchItem() {
    return item({ id: 'item-b', branchId: 'branch-b' });
  }

  it.each([
    [
      'stockIn',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => h.service.stockIn(c, a, id, 5),
    ],
    [
      'adjustStock',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => h.service.adjustStock(c, a, id, 1, 'count'),
    ],
    [
      'recordWaste',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => h.service.recordWaste(c, a, id, 1, 'spoiled'),
    ],
    [
      'setReorderThreshold',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => h.service.setReorderThreshold(c, a, id, 2),
    ],
    [
      'getItem',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => Promise.resolve(h.service.getItem(c, a, id)),
    ],
    [
      'listMovements',
      (
        h: ReturnType<typeof harness>,
        c: never,
        a: InventoryActor,
        id: string,
      ) => Promise.resolve(h.service.listMovements(c, a, id)),
    ],
  ])("%s refuses another branch's item", async (_name, call) => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(otherBranchItem());

    await expect(
      call(h, h.requestConnection as never, MANAGER, 'item-b'),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);

    // The point of refusing BEFORE the write: nothing moved.
    expect(h.repository.applyDelta).not.toHaveBeenCalled();
    expect(h.repository.setReorderThreshold).not.toHaveBeenCalled();
    expect(h.repository.listMovements).not.toHaveBeenCalled();
  });

  it('lets a branch manager work on their own branch', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(item({ branchId: BRANCH }));
    h.repository.applyDelta.mockResolvedValue(item({ branchId: BRANCH }));

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      MANAGER,
      'item-1',
      5,
    );

    expect(h.repository.applyDelta).toHaveBeenCalled();
  });

  it('lets a tenant-wide operator reach any branch', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(otherBranchItem());
    h.repository.applyDelta.mockResolvedValue(otherBranchItem());

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-b',
      5,
    );

    expect(h.repository.applyDelta).toHaveBeenCalled();
  });

  it('reports a missing item as 404, not a 500 from the UPDATE', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(null);

    // `applyDelta` throws a bare Error for a missing row, so without the pre-check
    // this surfaced as a 500 blaming the server for a bad id.
    await expect(
      h.service.stockIn(
        h.requestConnection as unknown as TenantScopedConnection,
        OWNER,
        'nope',
        5,
      ),
    ).rejects.toBeInstanceOf(InventoryItemNotFoundException);
    expect(h.repository.applyDelta).not.toHaveBeenCalled();
  });

  it('refuses to create an item in another branch', async () => {
    const h = harness();
    await expect(
      h.service.createItem(
        h.requestConnection as unknown as TenantScopedConnection,
        MANAGER,
        { branchId: 'branch-b', name: 'Flour', unit: 'kg' },
      ),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);
    expect(h.repository.createItem).not.toHaveBeenCalled();
  });

  it("silently scopes a branch manager's unfiltered list to their own branch", async () => {
    const h = harness();
    await h.service.listItems(
      h.requestConnection as unknown as TenantScopedConnection,
      MANAGER,
    );
    // No filter requested, so a branch manager gets their branch and not the
    // whole tenant's stock.
    expect(h.repository.listItems).toHaveBeenCalledWith(
      h.requestConnection,
      BRANCH,
    );
  });

  it("refuses a branch manager asking for another branch's list", async () => {
    const h = harness();
    await expect(
      h.service.listItems(
        h.requestConnection as unknown as TenantScopedConnection,
        MANAGER,
        'branch-b',
      ),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);
    expect(h.repository.listItems).not.toHaveBeenCalled();
  });

  it('leaves an unfiltered list tenant-wide for a tenant-wide operator', async () => {
    const h = harness();
    await h.service.listItems(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
    );
    expect(h.repository.listItems).toHaveBeenCalledWith(
      h.requestConnection,
      undefined,
    );
  });

  it("refuses to delete another branch's recipe wiring, before deleting it", async () => {
    const h = harness();
    h.repository.findRecipeIngredient.mockResolvedValue({
      id: 'ri-1',
      tenant_id: TENANT,
      menu_item_id: 'menu-1',
      inventory_item_id: 'item-b',
      quantity_used: 1,
    });
    h.repository.findItem.mockResolvedValue(otherBranchItem());

    await expect(
      h.service.removeRecipeIngredient(
        h.requestConnection as unknown as TenantScopedConnection,
        MANAGER,
        'ri-1',
      ),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);
    // Checked BEFORE the delete, so the wiring is still in place. Checking after
    // would depend on the caller's transaction rolling the delete back.
    expect(h.repository.removeRecipeIngredient).not.toHaveBeenCalled();
  });

  it('refuses a recipe written for a branch the caller does not run', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(item({ branchId: 'branch-b' }));

    await expect(
      h.service.setRecipeIngredient(
        h.requestConnection as unknown as TenantScopedConnection,
        MANAGER,
        { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
        'branch-b',
      ),
    ).rejects.toBeInstanceOf(BranchAccessDeniedException);
    expect(h.repository.upsertRecipeIngredient).not.toHaveBeenCalled();
  });
});

describe('InventoryService.stockIn', () => {
  /**
   * The comparison guards (`<= 0`, `=== 0`) all pass silently for `NaN`, so
   * without an explicit finiteness check a malformed body reached `roundQuantity`
   * and came back as a `RangeError` — a 500 blaming the server for the client's
   * bad input. Every quantity-taking entry point is covered here, because each has
   * its own guard and each could regress independently.
   */
  describe('rejects a non-numeric quantity as a 400', () => {
    it.each([
      [
        'stockIn',
        (h: ReturnType<typeof harness>, c: never, q: number) =>
          h.service.stockIn(c, OWNER, 'item-1', q),
      ],
      [
        'adjustStock',
        (h: ReturnType<typeof harness>, c: never, q: number) =>
          h.service.adjustStock(c, OWNER, 'item-1', q, 'count correction'),
      ],
      [
        'recordWaste',
        (h: ReturnType<typeof harness>, c: never, q: number) =>
          h.service.recordWaste(c, OWNER, 'item-1', q, 'spoiled'),
      ],
      [
        'setReorderThreshold',
        (h: ReturnType<typeof harness>, c: never, q: number) =>
          h.service.setReorderThreshold(c, OWNER, 'item-1', q),
      ],
    ])('%s', async (_name, call) => {
      const h = harness();
      const connection =
        h.requestConnection as unknown as TenantScopedConnection;

      await expect(
        call(h, connection as never, Number.NaN),
      ).rejects.toBeInstanceOf(InvalidQuantityException);
    });

    it('rejects a recipe amount that is not a number', async () => {
      const h = harness();
      const connection =
        h.requestConnection as unknown as TenantScopedConnection;

      await expect(
        h.service.setRecipeIngredient(
          connection,
          OWNER,
          {
            menuItemId: 'menu-1',
            inventoryItemId: 'item-1',
            quantityUsed: Number.NaN,
          },
          'branch-1',
        ),
      ).rejects.toBeInstanceOf(InvalidQuantityException);
    });

    it('writes nothing when a quantity is not a number', async () => {
      const h = harness();
      const connection =
        h.requestConnection as unknown as TenantScopedConnection;

      await expect(
        h.service.stockIn(connection, OWNER, 'item-1', Number.NaN),
      ).rejects.toBeInstanceOf(InvalidQuantityException);

      // The whole point: no stock moved and no movement row was written, so there
      // is no half-applied request to reconcile.
      expect(h.repository.applyDelta).not.toHaveBeenCalled();
      expect(h.repository.recordMovement).not.toHaveBeenCalled();
    });
  });

  it('adds the delivered quantity and records a purchase movement', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 30 }));

    const result = await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      20,
      { note: 'delivery 4412', createdBy: 'user-1' },
    );

    expect(h.repository.applyDelta).toHaveBeenCalledWith(
      h.requestConnection,
      'item-1',
      20,
    );
    expect(h.repository.recordMovement).toHaveBeenCalledWith(
      h.requestConnection,
      expect.objectContaining({
        inventoryItemId: 'item-1',
        movementType: 'purchase',
        quantity: 20,
        createdBy: 'user-1',
      }),
    );
    expect(result.item.quantityOnHand).toBe(30);
  });

  it('rejects a non-positive delivery', async () => {
    const h = harness();
    const connection = h.requestConnection as unknown as TenantScopedConnection;

    await expect(
      h.service.stockIn(connection, OWNER, 'item-1', 0),
    ).rejects.toThrow(/positive amount/);
    await expect(
      h.service.stockIn(connection, OWNER, 'item-1', -5),
    ).rejects.toThrow(/positive amount/);
    // A refused delivery must not have touched the books at all.
    expect(h.repository.applyDelta).not.toHaveBeenCalled();
    expect(h.repository.recordMovement).not.toHaveBeenCalled();
  });

  it('uses the caller transaction, never its own', async () => {
    // The movement row and the stock update have to commit together; a movement
    // on a different connection could be durable while the level rolled back.
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item());
    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      5,
    );
    expect(h.connections.acquireScoped).not.toHaveBeenCalled();
  });
});

describe('InventoryService.adjustStock', () => {
  const connection = (h: Harness) =>
    h.requestConnection as unknown as TenantScopedConnection;

  it('applies a signed correction', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 7 }));

    await h.service.adjustStock(
      connection(h),
      OWNER,
      'item-1',
      -3,
      'stocktake over-counted',
      'user-9',
    );

    expect(h.repository.applyDelta).toHaveBeenCalledWith(
      h.requestConnection,
      'item-1',
      -3,
    );
    expect(h.repository.recordMovement).toHaveBeenCalledWith(
      h.requestConnection,
      expect.objectContaining({ movementType: 'adjustment', quantity: -3 }),
    );
  });

  it('rejects a zero adjustment, which would write a movement that moves nothing', async () => {
    const h = harness();
    await expect(
      h.service.adjustStock(connection(h), OWNER, 'item-1', 0, 'no-op'),
    ).rejects.toThrow(/non-zero/);
    expect(h.repository.recordMovement).not.toHaveBeenCalled();
  });

  it('refuses an adjustment with no reason', async () => {
    // Enforced in the service, not only in the DTO: the service is reachable
    // from paths that never went through the controller, and a silent
    // correction is unauditable wherever it comes from.
    const h = harness();
    for (const note of ['', '   ']) {
      await expect(
        h.service.adjustStock(connection(h), OWNER, 'item-1', 1, note),
      ).rejects.toThrow(/requires a note/);
    }
    expect(h.repository.applyDelta).not.toHaveBeenCalled();
  });
});

describe('InventoryService.recordWaste', () => {
  it('records spoilage as a NEGATIVE movement', async () => {
    // The movement column holds the signed change, so summing it always
    // reproduces the current level and a report never needs to know the type.
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 8 }));

    await h.service.recordWaste(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      2,
      'spilled',
      'user-3',
    );

    expect(h.repository.applyDelta).toHaveBeenCalledWith(
      h.requestConnection,
      'item-1',
      -2,
    );
    expect(h.repository.recordMovement).toHaveBeenCalledWith(
      h.requestConnection,
      expect.objectContaining({ movementType: 'wastage', quantity: -2 }),
    );
  });

  it('rejects a non-positive loss', async () => {
    const h = harness();
    await expect(
      h.service.recordWaste(
        h.requestConnection as unknown as TenantScopedConnection,
        OWNER,
        'item-1',
        0,
        'nothing',
      ),
    ).rejects.toThrow(/positive amount of stock lost/);
  });
});

describe('InventoryService low-stock alerting', () => {
  it('does not alert when the strategy says the item is fine', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 50 }));
    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    expect(h.emit).not.toHaveBeenCalled();
  });

  it('registers the alert on commit rather than firing it immediately', async () => {
    // Before the commit, no subscriber can read the new level — an alert now would
    // describe a number that is not yet durable.
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 2 }));

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    expect(h.emit).not.toHaveBeenCalled();

    await h.requestConnection.commit();
    expect(h.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.lowStock,
      expect.objectContaining({ inventoryItemId: 'item-1' }),
    );
  });

  it('never alerts for a movement that rolled back', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 1 }));

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    await h.requestConnection.rollback();

    expect(h.emit).not.toHaveBeenCalled();
  });

  it('distinguishes reorder from out of stock', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 0 }));
    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    await h.requestConnection.commit();

    expect(h.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.lowStock,
      expect.objectContaining({ severity: 'out_of_stock' }),
    );
  });

  it('reports the reorder severity above zero', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 3 }));
    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    await h.requestConnection.commit();

    expect(h.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.lowStock,
      expect.objectContaining({ severity: 'reorder' }),
    );
  });

  it('survives a subscriber that throws', async () => {
    // The bus is synchronous, so a throwing subscriber would otherwise escape
    // into the committed request and turn a stock write into a failed response.
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 1 }));
    h.emit.mockImplementation(() => {
      throw new Error('subscriber exploded');
    });

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    await expect(h.requestConnection.commit()).resolves.toBeUndefined();
  });

  it('carries the movement that crossed the threshold', async () => {
    const h = harness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 4 }));
    h.repository.recordMovement.mockResolvedValue(
      movement({ id: 'movement-77' }),
    );

    await h.service.stockIn(
      h.requestConnection as unknown as TenantScopedConnection,
      OWNER,
      'item-1',
      40,
    );
    await h.requestConnection.commit();

    expect(h.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.lowStock,
      expect.objectContaining({ triggeredByMovementId: 'movement-77' }),
    );
  });
});

describe('InventoryService.setRecipeIngredient', () => {
  const connection = (h: Harness) =>
    h.requestConnection as unknown as TenantScopedConnection;

  it('saves an ingredient that belongs to the same branch', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(item({ branchId: 'branch-1' }));

    await h.service.setRecipeIngredient(
      connection(h),
      OWNER,
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 0.2 },
      'branch-1',
    );

    expect(h.repository.upsertRecipeIngredient).toHaveBeenCalledWith(
      h.requestConnection,
      TENANT,
      { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 0.2 },
    );
  });

  it('refuses an ingredient held by another branch', async () => {
    // Otherwise one branch's sales silently drain another branch's stock, and
    // neither branch's numbers look wrong until the stock runs out.
    const h = harness();
    h.repository.findItem.mockResolvedValue(item({ branchId: 'branch-2' }));

    await expect(
      h.service.setRecipeIngredient(
        connection(h),
        OWNER,
        { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 1 },
        'branch-1',
      ),
    ).rejects.toThrow(/belongs to a different branch/);
    expect(h.repository.upsertRecipeIngredient).not.toHaveBeenCalled();
  });

  it('refuses a zero-amount ingredient', async () => {
    const h = harness();
    await expect(
      h.service.setRecipeIngredient(
        connection(h),
        OWNER,
        { menuItemId: 'menu-1', inventoryItemId: 'item-1', quantityUsed: 0 },
        'branch-1',
      ),
    ).rejects.toThrow(/positive amount/);
  });

  it('rounds the recipe quantity to the stored grid', async () => {
    const h = harness();
    h.repository.findItem.mockResolvedValue(item());
    await h.service.setRecipeIngredient(
      connection(h),
      OWNER,
      {
        menuItemId: 'menu-1',
        inventoryItemId: 'item-1',
        quantityUsed: 0.12345,
      },
      'branch-1',
    );
    expect(h.repository.upsertRecipeIngredient).toHaveBeenCalledWith(
      h.requestConnection,
      TENANT,
      expect.objectContaining({ quantityUsed: 0.123 }),
    );
  });
});

describe('InventoryService.deductForOrder', () => {
  function orderHarness() {
    const h = harness();
    h.repository.crossBranchIngredients = noCrossBranch as never;
    h.repository.claimDeduction.mockResolvedValue({
      claimed: true,
      existing: null,
    });
    h.repository.menuItemsWithoutRecipe.mockResolvedValue([]);
    h.repository.ingredientsForOrder.mockResolvedValue([
      { inventoryItemId: 'item-1', quantity: 0.6 },
    ]);
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 4 }));
    h.repository.recordMovement.mockResolvedValue(
      movement({ id: 'movement-77' }),
    );
    return h;
  }

  it('deducts the recipe total and records a usage movement', async () => {
    const h = orderHarness();

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    expect(h.repository.applyDelta).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      -0.6,
    );
    expect(h.repository.recordMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        movementType: 'usage',
        quantity: -0.6,
        referenceOrderId: 'order-1',
      }),
    );
    expect(outcome).toEqual({
      status: 'completed',
      deduplicated: false,
      menuItemsWithoutRecipe: [],
    });
  });

  it('attributes a system deduction to nobody rather than to the completing user', async () => {
    const h = orderHarness();
    await h.service.deductForOrder(TENANT, 'order-1');
    expect(h.repository.recordMovement).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ createdBy: null }),
    );
  });

  it('commits once and releases the connection', async () => {
    const h = orderHarness();
    await h.service.deductForOrder(TENANT, 'order-1');
    const connection = h.acquired[0];
    expect(connection.commitCount).toBe(1);
    expect(connection.rollbackCount).toBe(0);
    expect(connection.releaseCount).toBe(1);
  });

  it('writes stock, movements and the ledger on ONE connection, then commits it', async () => {
    // The repository is mocked, so the SQL itself is not observable here — but
    // the property that makes the deduction atomic IS: every write went to the
    // same transaction, and that transaction committed. (The SQL text is
    // asserted in the repository spec.)
    const h = orderHarness();
    await h.service.deductForOrder(TENANT, 'order-1');
    const connection = h.acquired[0];

    // Every write must have gone to the SAME transaction. Typed as `unknown[][]`
    // because a bare `jest.fn()` records its calls as `any`.
    const writes: unknown[][] = [
      ...(h.repository.applyDelta.mock.calls as unknown as unknown[][]),
      ...(h.repository.recordMovement.mock.calls as unknown as unknown[][]),
      ...(h.repository.completeDeduction.mock.calls as unknown as unknown[][]),
    ];
    expect(writes).toHaveLength(3);
    for (const args of writes) {
      expect(args[0]).toBe(connection);
    }
    expect(connection.outcome).toBe('committed');
    expect(h.connections.acquireScoped).toHaveBeenCalledTimes(1);
  });

  it('allows stock to go negative, because the sale really happened', async () => {
    // Refusing to complete a paid order because the fridge was empty is worse
    // than stock that reads low; the discrepancy is the honest record.
    const h = orderHarness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: -0.4 }));
    const outcome = await h.service.deductForOrder(TENANT, 'order-1');
    expect(outcome.status).toBe('completed');
    expect(h.repository.applyDelta).toHaveBeenCalledWith(
      expect.anything(),
      'item-1',
      -0.6,
    );
  });

  it('skips a zero-quantity ingredient instead of writing an empty movement', async () => {
    const h = orderHarness();
    h.repository.ingredientsForOrder.mockResolvedValue([
      { inventoryItemId: 'item-1', quantity: 0 },
    ]);
    await h.service.deductForOrder(TENANT, 'order-1');
    expect(h.repository.recordMovement).not.toHaveBeenCalled();
  });

  it('deducts nothing and reports deduplicated when the ledger is already settled', async () => {
    // The bus is best-effort, so the same event can arrive twice. This is the
    // assertion that an order is NEVER charged for its stock twice.
    const h = orderHarness();
    h.repository.claimDeduction.mockResolvedValue({
      claimed: false,
      existing: deductionRow('completed'),
    });

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    expect(h.repository.applyDelta).not.toHaveBeenCalled();
    expect(h.repository.recordMovement).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: 'completed',
      deduplicated: true,
      menuItemsWithoutRecipe: [],
    });
  });

  it('treats a partial ledger entry as final too', async () => {
    const h = orderHarness();
    h.repository.claimDeduction.mockResolvedValue({
      claimed: false,
      existing: deductionRow('partial'),
    });
    const outcome = await h.service.deductForOrder(TENANT, 'order-1');
    expect(outcome.deduplicated).toBe(true);
    expect(h.repository.applyDelta).not.toHaveBeenCalled();
  });

  it('reports partial, naming the menu items, when a dish has no recipe', async () => {
    const h = orderHarness();
    h.repository.menuItemsWithoutRecipe.mockResolvedValue(['menu-9']);

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    expect(outcome.status).toBe('partial');
    expect(outcome.menuItemsWithoutRecipe).toEqual(['menu-9']);
    expect(h.repository.completeDeduction).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      'order-1',
      'partial',
      expect.stringContaining('menu-9'),
    );
  });

  it('reports partial when a recipe points at another branch stock', async () => {
    const h = orderHarness();
    h.repository.crossBranchIngredients.mockResolvedValue([
      { menuItemId: 'menu-2', inventoryItemId: 'item-7', branchId: 'branch-2' },
    ]);

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    expect(outcome.status).toBe('partial');
    expect(h.repository.completeDeduction).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      'order-1',
      'partial',
      expect.stringContaining('branch-2'),
    );
  });

  it('rolls back completely and records the failure on a SEPARATE connection', async () => {
    // The row has to go somewhere that is not the transaction that died, or the
    // only evidence that stock and an order disagree vanishes with the rollback.
    const h = orderHarness();
    h.repository.applyDelta.mockRejectedValue(
      new Error('inventory item vanished'),
    );

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    const deductionConnection = h.acquired[0];
    const failureConnection = h.acquired[1];
    expect(deductionConnection.rollbackCount).toBe(1);
    expect(deductionConnection.commitCount).toBe(0);
    expect(deductionConnection.releaseCount).toBe(1);
    expect(failureConnection).not.toBe(deductionConnection);
    expect(h.repository.recordDeductionFailure).toHaveBeenCalledWith(
      failureConnection,
      TENANT,
      'order-1',
      'inventory item vanished',
    );
    expect(outcome.status).toBe('failed');
  });

  it('never alerts for a deduction that rolled back', async () => {
    const h = orderHarness();
    h.repository.applyDelta.mockRejectedValue(new Error('boom'));

    await h.service.deductForOrder(TENANT, 'order-1');

    expect(h.emit).not.toHaveBeenCalled();
  });

  it('still releases the connection when the failure note cannot be written', async () => {
    // A bug in the failure path must not leak a pooled connection.
    const h = orderHarness();
    h.repository.applyDelta.mockRejectedValue(new Error('boom'));
    h.repository.recordDeductionFailure.mockRejectedValue(
      new Error('ledger is down too'),
    );

    const outcome = await h.service.deductForOrder(TENANT, 'order-1');

    expect(outcome.status).toBe('failed');
    const failureConnection = h.acquired[1];
    expect(failureConnection.releaseCount).toBe(1);
  });

  it('alerts after the deduction is committed, not before', async () => {
    // A subscriber re-reading the item on its own connection must see the
    // committed level, not the pre-deduction one.
    const h = orderHarness();
    h.repository.applyDelta.mockResolvedValue(item({ quantityOnHand: 1 }));

    await h.service.deductForOrder(TENANT, 'order-1');

    expect(h.emit).toHaveBeenCalledWith(
      INVENTORY_EVENTS.lowStock,
      expect.objectContaining({ quantityOnHand: 1, severity: 'reorder' }),
    );
  });
});

describe('InventoryService discrepancy scope', () => {
  it('passes a branch-scoped caller their own branch', async () => {
    // A failed deduction's `detail` names the ingredient and the shortfall, so an
    // unscoped list hands a branch manager a running account of every other
    // branch's stock problems. This pins that the filter is actually forwarded --
    // dropping it survived mutation testing.
    const h = harness();
    const connection = h.requestConnection as unknown as TenantScopedConnection;
    await h.service.listDiscrepancies(connection, { branchId: 'branch-a' });
    expect(h.repository.listDiscrepancies).toHaveBeenCalledWith(
      connection,
      undefined,
      'branch-a',
    );
  });

  it('passes null for a tenant-wide caller, and keeps the status filter', async () => {
    const h = harness();
    const connection = h.requestConnection as unknown as TenantScopedConnection;
    await h.service.listDiscrepancies(connection, { branchId: null }, 'failed');
    expect(h.repository.listDiscrepancies).toHaveBeenCalledWith(
      connection,
      'failed',
      null,
    );
  });
});
