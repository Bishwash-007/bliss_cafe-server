import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { BranchService } from '../branch/branch.service';
import type {
  MenuRepository,
  MenuItemModifierRow,
  ResolvedMenuItem,
} from '../menu/menu.repository';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { CreateOrderDto } from './dto/order.dto';
import { ORDER_EVENTS, type OrderType } from './events/order-events';
import {
  InvalidOrderTransitionException,
  OrderNotFoundException,
  UnknownOrderStatusException,
} from './exceptions/order.exceptions';
import type {
  CreateOrderInput,
  OrderRepository,
  OrderRow,
} from './order.repository';
import { OrderService } from './order.service';
import { ORDER_STATUSES, type OrderStatus } from './state/order-state';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const T2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const B1 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1';
const TABLE1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
const ITEM1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const ACTION1 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1';
const ORDER1 = 'ffffffff-ffff-4fff-8fff-fffffffffff1';

function order(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER1,
    tenant_id: T1,
    branch_id: B1,
    table_id: TABLE1,
    customer_id: null,
    created_by: null,
    order_type: 'dine_in',
    status: 'placed',
    subtotal: 10,
    tax_amount: 0,
    discount_amount: 0,
    total_amount: 10,
    client_action_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function resolved(overrides: Partial<ResolvedMenuItem> = {}): ResolvedMenuItem {
  return { menuItemId: ITEM1, price: 4, isAvailable: true, ...overrides };
}

function modifier(
  overrides: Partial<MenuItemModifierRow> = {},
): MenuItemModifierRow {
  return {
    id: 'abababab-abab-4bab-8bab-abababababab1',
    tenant_id: T1,
    menu_item_id: ITEM1,
    name: 'Size',
    option_name: 'Large',
    extra_price: 1.5,
    ...overrides,
  };
}

describe('OrderService', () => {
  let service: OrderService;
  let repo: {
    findByClientActionId: jest.Mock;
    findById: jest.Mock;
    listByBranch: jest.Mock;
    listActiveByBranch: jest.Mock;
    create: jest.Mock;
    findItems: jest.Mock;
    countOtherOpenOrdersForTable: jest.Mock;
    updateStatus: jest.Mock;
    syncItemStatuses: jest.Mock;
    withSavepoint: jest.Mock;
  };
  let menuRepo: {
    resolveItemsForBranch: jest.Mock;
    findModifiersForItems: jest.Mock;
  };
  let branchService: { setTableStatus: jest.Mock };
  let events: EventEmitter2;
  let connection: TenantScopedConnection;

  const createDto = (
    overrides: Partial<CreateOrderDto> = {},
  ): CreateOrderDto => ({
    branchId: B1,
    tableId: TABLE1,
    orderType: 'dine_in',
    items: [{ menuItemId: ITEM1, quantity: 2 }],
    ...overrides,
  });

  /**
   * Stands in for the real transaction. Events are deferred to `onCommit`
   * because the real connection only runs them once the row is durable, so
   * `commit()` is what makes them observable — mirroring production instead of
   * letting the tests assert on events that could never have been seen.
   */
  let deferred: Array<() => void>;

  const commit = (): void => {
    const pending = deferred;
    deferred = [];
    for (const callback of pending) {
      callback();
    }
  };

  /**
   * Run the service call, then commit — the order the real request lifecycle
   * produces (the middleware commits on `res.finish`, after the handler
   * returns). Almost every test wants the post-commit world, so going through
   * these keeps the assertions honest without each one remembering to commit.
   */
  const placeOrder = async (
    ...args: Parameters<OrderService['create']>
  ): Promise<Awaited<ReturnType<OrderService['create']>>> => {
    const result = await service.create(...args);
    commit();
    return result;
  };

  const moveOrder = async (
    ...args: Parameters<OrderService['transition']>
  ): Promise<Awaited<ReturnType<OrderService['transition']>>> => {
    const result = await service.transition(...args);
    commit();
    return result;
  };

  beforeEach(() => {
    deferred = [];
    connection = {
      onCommit: jest.fn((fn: () => void) => deferred.push(fn)),
    } as unknown as TenantScopedConnection;
    repo = {
      findByClientActionId: jest.fn().mockResolvedValue(null),
      findById: jest.fn(),
      listByBranch: jest.fn().mockResolvedValue([]),
      listActiveByBranch: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      findItems: jest.fn().mockResolvedValue([]),
      countOtherOpenOrdersForTable: jest.fn().mockResolvedValue(0),
      updateStatus: jest.fn(),
      syncItemStatuses: jest.fn().mockResolvedValue(undefined),
      // The real implementation wraps `create` in a savepoint so a unique
      // violation can be rolled back without poisoning the whole transaction;
      // in a unit test there is no transaction, so just run the work.
      withSavepoint: jest.fn(
        (_connection: unknown, work: () => Promise<unknown>) => work(),
      ),
    };
    menuRepo = {
      resolveItemsForBranch: jest
        .fn()
        .mockResolvedValue(new Map([[ITEM1, resolved()]])),
      findModifiersForItems: jest.fn().mockResolvedValue(new Map()),
    };
    branchService = { setTableStatus: jest.fn().mockResolvedValue(undefined) };
    events = new EventEmitter2();
    service = new OrderService(
      repo as unknown as OrderRepository,
      menuRepo as unknown as MenuRepository,
      branchService as unknown as BranchService,
      events,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ------------------------------------------------------------------ create

  describe('create', () => {
    it('prices the ticket from the menu, not the client, and marks the table', async () => {
      repo.create.mockResolvedValue(order({ total_amount: 11 }));

      const created = await placeOrder(connection, T1, 'staff-1', createDto());

      expect(created.id).toBe(ORDER1);
      expect(repo.create).toHaveBeenCalledTimes(1);
      const [, tenantId, input] = repo.create.mock.calls[0] as [
        unknown,
        string,
        CreateOrderInput,
      ];
      expect(tenantId).toBe(T1);
      // 2 x 4.00 base, no modifiers, no tax/discount
      expect(input.subtotal).toBe(8);
      expect(input.totalAmount).toBe(8);
      expect(input.items).toEqual([
        {
          menuItemId: ITEM1,
          quantity: 2,
          unitPrice: 4,
          notes: null,
          modifiers: [],
        },
      ]);
      expect(input.tableId).toBe(TABLE1);
      expect(input.createdBy).toBe('staff-1');
      expect(branchService.setTableStatus).toHaveBeenCalledWith(
        connection,
        T1,
        TABLE1,
        'occupied',
      );
    });

    it('adds modifier extras to the line and the subtotal', async () => {
      menuRepo.findModifiersForItems.mockResolvedValue(
        new Map([[ITEM1, [modifier()]]]),
      );
      repo.create.mockResolvedValue(order());

      await placeOrder(
        connection,
        T1,
        null,
        createDto({
          items: [
            {
              menuItemId: ITEM1,
              quantity: 2,
              modifiers: [{ name: 'Size', optionName: 'Large' }],
            },
          ],
        }),
      );

      const [, , input] = repo.create.mock.calls[0] as [
        unknown,
        string,
        CreateOrderInput,
      ];
      // (4.00 + 1.50) x 2 = 11.00
      expect(input.subtotal).toBe(11);
      expect(input.items[0].modifiers).toEqual([
        { modifierId: modifier().id, name: 'Large', extraPrice: 1.5 },
      ]);
    });

    it('applies discount and tax to the total', async () => {
      repo.create.mockResolvedValue(order());
      await placeOrder(
        connection,
        T1,
        null,
        createDto({ discountAmount: 1, taxAmount: 0.8 }),
      );
      const [, , input] = repo.create.mock.calls[0] as [
        unknown,
        string,
        CreateOrderInput,
      ];
      expect(input.totalAmount).toBeCloseTo(7.8, 5);
    });

    it('refuses a modifier that is not on the item (no client-side pricing)', async () => {
      menuRepo.findModifiersForItems.mockResolvedValue(
        new Map([[ITEM1, [modifier()]]]),
      );

      await expect(
        service.create(
          connection,
          T1,
          null,
          createDto({
            items: [
              {
                menuItemId: ITEM1,
                modifiers: [{ name: 'Size', optionName: 'Enormous' }],
              },
            ],
          }),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses a menu item that is not on this branch menu', async () => {
      menuRepo.resolveItemsForBranch.mockResolvedValue(new Map());
      await expect(
        service.create(connection, T1, null, createDto()),
      ).rejects.toThrow(/does not exist on this branch's menu/);
    });

    it('refuses an unavailable menu item', async () => {
      menuRepo.resolveItemsForBranch.mockResolvedValue(
        new Map([[ITEM1, resolved({ isAvailable: false })]]),
      );
      await expect(
        service.create(connection, T1, null, createDto()),
      ).rejects.toThrow(/currently unavailable/);
    });

    it.each([0, -1, 2.5, 1000])(
      'refuses a nonsense quantity (%s)',
      async (quantity) => {
        await expect(
          service.create(
            connection,
            T1,
            null,
            createDto({ items: [{ menuItemId: ITEM1, quantity }] }),
          ),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('refuses an empty order', async () => {
      await expect(
        service.create(connection, T1, null, createDto({ items: [] })),
      ).rejects.toThrow(/at least one item/);
    });

    it('requires a table for dine_in', async () => {
      await expect(
        service.create(connection, T1, null, createDto({ tableId: null })),
      ).rejects.toThrow(/tableId is required for dine_in/);
    });

    it.each(['takeaway', 'delivery'] as const)(
      'never attaches a table to a %s order',
      async (orderType) => {
        repo.create.mockResolvedValue(order({ table_id: null }));
        await placeOrder(
          connection,
          T1,
          null,
          createDto({ orderType, tableId: TABLE1 }),
        );
        const [, , input] = repo.create.mock.calls[0] as [
          unknown,
          string,
          CreateOrderInput,
        ];
        expect(input.tableId).toBeNull();
        // and therefore never claims one
        expect(branchService.setTableStatus).not.toHaveBeenCalled();
      },
    );

    it('rejects an unknown order type', async () => {
      await expect(
        service.create(
          connection,
          T1,
          null,
          createDto({ orderType: 'kiosk' as OrderType }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects a negative discount or tax', async () => {
      await expect(
        service.create(connection, T1, null, createDto({ discountAmount: -5 })),
      ).rejects.toThrow(/discountAmount/);
      await expect(
        service.create(connection, T1, null, createDto({ taxAmount: -1 })),
      ).rejects.toThrow(/taxAmount/);
    });
  });

  // ------------------------------------------------- idempotent order creation

  describe('idempotency (mobile offline action queue)', () => {
    it('returns the original order for a repeated client_action_id', async () => {
      const original = order({ client_action_id: ACTION1 });
      repo.findByClientActionId.mockResolvedValue(original);

      const result = await placeOrder(
        connection,
        T1,
        null,
        createDto({ clientActionId: ACTION1 }),
      );

      expect(result).toBe(original);
      // The whole point: no second row, and no second round of side-effects.
      expect(repo.create).not.toHaveBeenCalled();
      expect(branchService.setTableStatus).not.toHaveBeenCalled();
    });

    it('does not double-fire order.placed on a replay', async () => {
      const placed = jest.fn();
      const statusChanged = jest.fn();
      events.on(ORDER_EVENTS.placed, placed);
      events.on(ORDER_EVENTS.statusChanged, statusChanged);

      // First attempt: genuinely new.
      repo.create.mockResolvedValue(order({ client_action_id: ACTION1 }));
      await placeOrder(
        connection,
        T1,
        null,
        createDto({ clientActionId: ACTION1 }),
      );
      expect(placed).toHaveBeenCalledTimes(1);
      expect(statusChanged).toHaveBeenCalledTimes(1);

      // Replay after the phone missed the response.
      repo.findByClientActionId.mockResolvedValue(
        order({ client_action_id: ACTION1 }),
      );
      await placeOrder(
        connection,
        T1,
        null,
        createDto({ clientActionId: ACTION1 }),
      );

      expect(placed).toHaveBeenCalledTimes(1);
      expect(statusChanged).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it('returns the winner when a concurrent duplicate loses the unique-index race', async () => {
      const winner = order({ client_action_id: ACTION1, id: 'other-order' });
      // Pre-check misses (the other request has not committed yet)...
      repo.findByClientActionId.mockResolvedValueOnce(null);
      // ...the INSERT hits idx_orders_client_action...
      repo.create.mockRejectedValueOnce(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );
      // ...and the post-violation read finds the committed winner.
      repo.findByClientActionId.mockResolvedValueOnce(winner);

      const result = await placeOrder(
        connection,
        T1,
        null,
        createDto({ clientActionId: ACTION1 }),
      );

      expect(result).toBe(winner);
    });

    it('rethrows a genuine constraint failure that is not the idempotency key', async () => {
      const boom = new Error('null value in column created_by');
      repo.create.mockRejectedValueOnce(boom);
      await expect(
        service.create(connection, T1, null, createDto()),
      ).rejects.toThrow('null value in column created_by');
    });

    it('does not deduplicate orders with no client_action_id', async () => {
      // Two identical tickets from a human at the POS are two real tickets.
      repo.create.mockResolvedValue(order());
      const dto = createDto();
      await placeOrder(connection, T1, null, dto);
      await placeOrder(connection, T1, null, dto);

      expect(repo.findByClientActionId).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalledTimes(2);
    });

    it('scopes the idempotency lookup to the tenant', async () => {
      repo.create.mockResolvedValue(order());
      await placeOrder(
        connection,
        T2,
        null,
        createDto({ clientActionId: ACTION1 }),
      );
      expect(repo.findByClientActionId).toHaveBeenCalledWith(
        connection,
        T2,
        ACTION1,
      );
    });
  });

  // ------------------------------------------------------------- transitions

  describe('transition', () => {
    it('moves an order along the happy path and fires order.status_changed', async () => {
      repo.findById.mockResolvedValue(order({ status: 'placed' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'confirmed' }));
      const statusChanged = jest.fn();
      const placed = jest.fn();
      const paid = jest.fn();
      events.on(ORDER_EVENTS.statusChanged, statusChanged);
      events.on(ORDER_EVENTS.placed, placed);
      events.on(ORDER_EVENTS.paid, paid);

      const updated = await moveOrder(connection, T1, ORDER1, 'confirmed');

      expect(updated.status).toBe('confirmed');
      expect(repo.updateStatus).toHaveBeenCalledWith(
        connection,
        T1,
        ORDER1,
        'placed',
        'confirmed',
      );
      expect(placed).not.toHaveBeenCalled();
      expect(paid).not.toHaveBeenCalled();
      expect(statusChanged).toHaveBeenCalledTimes(1);
      expect(statusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'order.status_changed',
          orderId: ORDER1,
          tenantId: T1,
          branchId: B1,
          previousStatus: 'placed',
          newStatus: 'confirmed',
        }),
      );
    });

    it('fires order.paid in addition to order.status_changed when reaching paid', async () => {
      repo.findById.mockResolvedValue(order({ status: 'awaiting_payment' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'paid' }));
      const statusChanged = jest.fn();
      const paid = jest.fn();
      events.on(ORDER_EVENTS.statusChanged, statusChanged);
      events.on(ORDER_EVENTS.paid, paid);

      await moveOrder(connection, T1, ORDER1, 'paid');

      expect(statusChanged).toHaveBeenCalledTimes(1);
      expect(paid).toHaveBeenCalledTimes(1);
      expect(paid).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'order.paid',
          orderId: ORDER1,
          tenantId: T1,
          branchId: B1,
          previousStatus: 'awaiting_payment',
          newStatus: 'paid',
          totalAmount: 10,
        }),
      );
    });

    it('does not fire order.paid for any other status', async () => {
      const paid = jest.fn();
      events.on(ORDER_EVENTS.paid, paid);
      repo.findById.mockResolvedValue(order({ status: 'placed' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'confirmed' }));

      await moveOrder(connection, T1, ORDER1, 'confirmed');
      expect(paid).not.toHaveBeenCalled();
    });

    it('mirrors the header status onto the order lines', async () => {
      repo.findById.mockResolvedValue(order({ status: 'confirmed' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'preparing' }));

      await moveOrder(connection, T1, ORDER1, 'preparing');

      expect(repo.syncItemStatuses).toHaveBeenCalledWith(
        connection,
        T1,
        ORDER1,
        'preparing',
      );
    });

    it('still succeeds when the line-status sync fails', async () => {
      repo.findById.mockResolvedValue(order({ status: 'confirmed' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'preparing' }));
      repo.syncItemStatuses.mockRejectedValue(new Error('line update failed'));

      const updated = await moveOrder(connection, T1, ORDER1, 'preparing');
      expect(updated.status).toBe('preparing');
    });

    // Every illegal pair, driven through the public API rather than the states.
    it.each(
      ORDER_STATUSES.flatMap((from) =>
        ORDER_STATUSES.map((to) => [from, to] as const),
      ),
    )('rejects the illegal transition %s -> %s', async (from, to) => {
      const legal =
        (from === 'placed' && to === 'confirmed') ||
        (from === 'placed' && to === 'cancelled') ||
        (from === 'confirmed' && to === 'preparing') ||
        (from === 'confirmed' && to === 'cancelled') ||
        (from === 'preparing' && to === 'ready') ||
        (from === 'preparing' && to === 'cancelled') ||
        (from === 'ready' && to === 'served') ||
        (from === 'ready' && to === 'cancelled') ||
        (from === 'served' && to === 'awaiting_payment') ||
        (from === 'served' && to === 'cancelled') ||
        (from === 'awaiting_payment' && to === 'paid') ||
        (from === 'awaiting_payment' && to === 'cancelled') ||
        (from === 'paid' && to === 'completed');

      if (legal) {
        return;
      }

      repo.findById.mockResolvedValue(order({ status: from }));
      const statusChanged = jest.fn();
      events.on(ORDER_EVENTS.statusChanged, statusChanged);

      await expect(
        service.transition(connection, T1, ORDER1, to),
      ).rejects.toThrow(InvalidOrderTransitionException);

      expect(repo.updateStatus).not.toHaveBeenCalled();
      expect(statusChanged).not.toHaveBeenCalled();
    });

    it('names both ends of the move and what IS allowed, in the message', async () => {
      repo.findById.mockResolvedValue(order({ status: 'served' }));

      await expect(
        service.transition(connection, T1, ORDER1, 'placed'),
      ).rejects.toThrow(
        /cannot move from 'served' to 'placed'.*Allowed next: awaiting_payment, cancelled/,
      );
    });

    it('says a terminal status is terminal', async () => {
      repo.findById.mockResolvedValue(order({ status: 'completed' }));

      await expect(
        service.transition(connection, T1, ORDER1, 'preparing'),
      ).rejects.toThrow(/'completed' is a terminal state/);
    });

    it('rejects a status outside the known set', async () => {
      repo.findById.mockResolvedValue(order({ status: 'placed' }));

      await expect(
        service.transition(connection, T1, ORDER1, 'refunded'),
      ).rejects.toThrow(UnknownOrderStatusException);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('rejects a status that only differs by case', async () => {
      repo.findById.mockResolvedValue(order({ status: 'placed' }));
      await expect(
        service.transition(connection, T1, ORDER1, 'Confirmed'),
      ).rejects.toThrow(UnknownOrderStatusException);
    });

    it('throws when the order does not exist for this tenant', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.transition(connection, T1, 'nope', 'confirmed'),
      ).rejects.toThrow(OrderNotFoundException);
    });

    it('reports the real status when a concurrent writer won the update', async () => {
      // Both waiters read `placed`; one commits `confirmed` first, so the
      // guarded UPDATE (which requires status = 'placed') matches no row.
      repo.findById.mockResolvedValue(order({ status: 'placed' }));
      repo.updateStatus.mockResolvedValue(null);
      repo.findById.mockResolvedValueOnce(order({ status: 'placed' }));
      repo.findById.mockResolvedValueOnce(order({ status: 'confirmed' }));

      await expect(
        service.transition(connection, T1, ORDER1, 'confirmed'),
      ).rejects.toThrow(InvalidOrderTransitionException);
    });
  });

  // ------------------------------------------------------- table side-effects

  describe('table status side-effects', () => {
    it.each(['completed', 'cancelled'] as const)(
      'frees the table when the order reaches %s',
      async (target) => {
        const from = target === 'completed' ? 'paid' : 'placed';
        repo.findById.mockResolvedValue(order({ status: from }));
        repo.updateStatus.mockResolvedValue(order({ status: target }));

        await moveOrder(connection, T1, ORDER1, target);

        expect(branchService.setTableStatus).toHaveBeenCalledWith(
          connection,
          T1,
          TABLE1,
          'free',
        );
      },
    );

    it.each([
      'confirmed',
      'preparing',
      'ready',
      'served',
      'awaiting_payment',
      'paid',
    ] as const)('leaves the table alone on %s', async (target) => {
      const previous: Record<string, OrderStatus> = {
        confirmed: 'placed',
        preparing: 'confirmed',
        ready: 'preparing',
        served: 'ready',
        awaiting_payment: 'served',
        paid: 'awaiting_payment',
      };
      repo.findById.mockResolvedValue(order({ status: previous[target] }));
      repo.updateStatus.mockResolvedValue(order({ status: target }));

      await moveOrder(connection, T1, ORDER1, target);

      expect(branchService.setTableStatus).not.toHaveBeenCalled();
    });

    it('keeps the table busy while another order on it is still open', async () => {
      // A table can hold more than one ticket (a second party joining, a split
      // check). Freeing it here would tell the floor a still-seated party has no
      // table — the floor would then seat a walk-in on it.
      repo.findById.mockResolvedValue(order({ status: 'paid' }));
      repo.updateStatus.mockResolvedValue(order({ status: 'completed' }));
      repo.countOtherOpenOrdersForTable.mockResolvedValue(1);

      await moveOrder(connection, T1, ORDER1, 'completed');

      expect(repo.countOtherOpenOrdersForTable).toHaveBeenCalledWith(
        connection,
        T1,
        TABLE1,
        ORDER1,
      );
      expect(branchService.setTableStatus).not.toHaveBeenCalled();
    });

    it('does not touch a table for a takeaway order', async () => {
      repo.findById.mockResolvedValue(
        order({ status: 'placed', table_id: null, order_type: 'takeaway' }),
      );
      repo.updateStatus.mockResolvedValue(
        order({ status: 'cancelled', table_id: null, order_type: 'takeaway' }),
      );

      await moveOrder(connection, T1, ORDER1, 'cancelled');

      expect(branchService.setTableStatus).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------- reads

  /**
   * The event bus is a PUBLIC contract for modules written later (Inventory 06,
   * CRM 08, Notification 10), and those subscribers will read the order from
   * their own database connection. Inside the request the transaction is still
   * open — it commits on `res.finish` — so anything emitted earlier names an
   * order that does not exist yet as far as any other connection is concerned.
   */
  describe('after-commit emission', () => {
    beforeEach(() => {
      repo.create.mockResolvedValue(order());
      repo.updateStatus.mockResolvedValue(order({ status: 'confirmed' }));
    });

    it('emits nothing for a new order until the transaction commits', async () => {
      const placed = jest.fn();
      const statusChanged = jest.fn();
      events.on(ORDER_EVENTS.placed, placed);
      events.on(ORDER_EVENTS.statusChanged, statusChanged);

      await service.create(connection, T1, 'staff-1', createDto());

      expect(placed).not.toHaveBeenCalled();
      expect(statusChanged).not.toHaveBeenCalled();

      commit();

      expect(placed).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER1 }),
      );
      expect(statusChanged).toHaveBeenCalledWith(
        expect.objectContaining({ orderId: ORDER1, newStatus: 'placed' }),
      );
    });

    it('emits nothing for a transition until the transaction commits', async () => {
      repo.findById.mockResolvedValue(order({ status: 'placed' }));
      const statusChanged = jest.fn();
      events.on(ORDER_EVENTS.statusChanged, statusChanged);

      await service.transition(connection, T1, ORDER1, 'confirmed');

      expect(statusChanged).not.toHaveBeenCalled();

      commit();

      expect(statusChanged).toHaveBeenCalledTimes(1);
      expect(statusChanged).toHaveBeenCalledWith(
        expect.objectContaining({
          previousStatus: 'placed',
          newStatus: 'confirmed',
        }),
      );
    });

    it('keeps order.placed ahead of the status_changed it implies', async () => {
      const seen: string[] = [];
      events.on(ORDER_EVENTS.placed, () => seen.push(ORDER_EVENTS.placed));
      events.on(ORDER_EVENTS.statusChanged, () =>
        seen.push(ORDER_EVENTS.statusChanged),
      );

      await service.create(connection, T1, 'staff-1', createDto());
      commit();

      expect(seen).toEqual([ORDER_EVENTS.placed, ORDER_EVENTS.statusChanged]);
    });

    it('drops the events entirely if the request rolls back', async () => {
      // A rolled-back transaction must not announce an order that was never
      // written, so `onCommit` callbacks are discarded rather than run.
      const placed = jest.fn();
      events.on(ORDER_EVENTS.placed, placed);

      await service.create(connection, T1, 'staff-1', createDto());
      deferred = [];

      expect(placed).not.toHaveBeenCalled();
    });
  });

  describe('reads', () => {
    it('lists the active (KDS) orders for a branch', async () => {
      const rows = [order()];
      repo.listActiveByBranch.mockResolvedValue(rows);
      await expect(
        service.listActiveByBranch(connection, T1, B1),
      ).resolves.toBe(rows);
    });

    it('throws OrderNotFoundException rather than returning null', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.findById(connection, T1, ORDER1)).rejects.toThrow(
        OrderNotFoundException,
      );
    });
  });
});
