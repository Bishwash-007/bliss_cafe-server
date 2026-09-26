import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BranchService } from '../branch/branch.service';
import {
  MenuRepository,
  type MenuItemModifierRow,
  type ResolvedMenuItem,
} from '../menu/menu.repository';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { CreateOrderDto } from './dto/order.dto';
import {
  ORDER_EVENTS,
  isOrderType,
  type OrderPaidEvent,
  type OrderPlacedEvent,
  type OrderStatusChangedEvent,
  type OrderType,
} from './events/order-events';
import {
  InvalidOrderTransitionException,
  OrderNotFoundException,
  UnknownOrderStatusException,
} from './exceptions/order.exceptions';
import {
  isUniqueViolation,
  OrderRepository,
  type NewOrderItem,
  type NewOrderModifier,
  type OrderRow,
} from './order.repository';
import { isOrderStatus } from './state/order-state';
import { orderStateFor } from './state/order-state.factory';

const MAX_ITEM_QUANTITY = 99;
const MAX_LINES = 100;

/**
 * The order hub.
 *
 * ## Why nothing here knows about KDS, inventory, CRM or notifications
 *
 * `OrderService` publishes three domain events and returns. The KDS gateway,
 * the ingredient deduction, the loyalty accrual and the guest SMS are all
 * subscribers — none of them is imported, referenced or awaited by this class.
 * That is the Observer half of the design: adding a fourth consumer must cost
 * one `@OnEvent` method in another module, never a new `if` in here.
 *
 * The three event names, their payloads, and the rules for when each fires are
 * documented in `./events/order-events.ts` — that file, not this class, is the
 * contract other modules code against.
 *
 * ## Connections are passed in, never acquired
 *
 * `TenantModule` is global and hands out a per-request, RLS-pinned connection;
 * controllers pass it down explicitly so this class stays unit-testable and so
 * there is no way to accidentally run an order write outside a tenant scope.
 */
@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  constructor(
    private readonly repository: OrderRepository,
    private readonly menuRepository: MenuRepository,
    private readonly branchService: BranchService,
    private readonly events: EventEmitter2,
  ) {}

  // ---------------------------------------------------------------- reads

  findById(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<OrderRow> {
    return this.loadOrder(connection, tenantId, orderId);
  }

  listByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<OrderRow[]> {
    return this.repository.listByBranch(connection, tenantId, branchId);
  }

  /** The KDS snapshot: everything still in flight for one branch, oldest first. */
  listActiveByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<OrderRow[]> {
    return this.repository.listActiveByBranch(connection, tenantId, branchId);
  }

  // --------------------------------------------------------------- create

  /**
   * Places an order.
   *
   * ## Idempotency — the reason the mobile offline queue is safe
   *
   * A phone that was offline for an hour replays its action queue on reconnect,
   * over a connection that may have dropped mid-response. So the same action
   * can arrive two, three or five times, and the client cannot tell which
   * attempt got through. Three defences, in order:
   *
   *   1. **Pre-check** — a `client_action_id` that already exists for this
   *      tenant short-circuits to the original order. This is the common case
   *      (a plain retry) and it fires no events, so a replayed action never
   *      re-notifies the kitchen or re-deducts stock.
   *   2. **The database** — `idx_orders_client_action` is a UNIQUE partial index
   *      on `(tenant_id, client_action_id)`, so even a concurrent double-submit
   *      cannot produce two rows. The tenant id is part of the index, so two
   *      different cafés reusing the same client-generated UUID never collide.
   *   3. **Post-violation recovery** — if the INSERT loses that race, the
   *      winner's row is read back and returned instead of surfacing a 500 to a
   *      phone that did nothing wrong.
   *
   * An order with NO `client_action_id` (the POS path, where a human is
   * watching the screen) is deliberately not deduplicated: two identical
   * tickets in a row are two real tickets.
   */
  async create(
    connection: TenantScopedConnection,
    tenantId: string,
    createdBy: string | null,
    dto: CreateOrderDto,
  ): Promise<OrderRow> {
    const clientActionId = dto.clientActionId?.trim() || null;

    if (clientActionId) {
      const existing = await this.repository.findByClientActionId(
        connection,
        tenantId,
        clientActionId,
      );
      if (existing) {
        this.logger.debug(
          `Idempotent replay of client_action_id ${clientActionId}; ` +
            `returning existing order ${existing.id}`,
        );
        return existing;
      }
    }

    const orderType: OrderType = this.resolveOrderType(dto);
    const tableId = this.resolveTableId(dto, orderType);
    const items = await this.price(connection, tenantId, dto);

    // Per-unit, matching the menu module's Decorator semantics: a line's unit
    // price is base + Σ modifier extras, so a "Large" on a quantity-2 line is
    // charged twice, not once.
    const subtotal = round2(
      items.reduce(
        (sum, item) =>
          sum + (item.unitPrice + modifierTotal(item)) * item.quantity,
        0,
      ),
    );
    const discountAmount = nonNegative(dto.discountAmount, 'discountAmount');
    const taxAmount = nonNegative(dto.taxAmount, 'taxAmount');
    const totalAmount = round2(subtotal - discountAmount + taxAmount);

    let order: OrderRow;
    try {
      // Inside a SAVEPOINT: a unique-index violation aborts the enclosing
      // transaction in Postgres, which would make the recovery read below fail
      // with 25P02. See `OrderRepository.withSavepoint`.
      order = await this.repository.withSavepoint(connection, () =>
        this.repository.create(connection, tenantId, {
          branchId: dto.branchId,
          tableId,
          customerId: dto.customerId ?? null,
          createdBy,
          orderType,
          subtotal,
          taxAmount,
          discountAmount,
          totalAmount,
          clientActionId,
          items,
        }),
      );
    } catch (error) {
      // Lost the race against a concurrent replay of the same action. The
      // transaction is usable again thanks to the savepoint, so the winner's row
      // can now actually be read.
      if (clientActionId && isUniqueViolation(error)) {
        const winner = await this.repository.findByClientActionId(
          connection,
          tenantId,
          clientActionId,
        );
        if (winner) {
          return winner;
        }
      }
      throw error;
    }

    // A dine-in ticket claims its table. Done AFTER the insert so a rollback
    // can never leave a table marked busy for an order that does not exist,
    // and before the events so subscribers already observe the table change.
    if (orderType === 'dine_in' && tableId) {
      await this.branchService.setTableStatus(
        connection,
        tenantId,
        tableId,
        'occupied',
      );
    }

    this.publishPlaced(connection, tenantId, order, items);
    return order;
  }

  // ----------------------------------------------------------- transition

  /**
   * Moves an order to `newStatus`, rejecting anything the State pattern does
   * not permit.
   *
   * The three rejection layers, cheapest first:
   *   1. unknown target status -> `UnknownOrderStatusException`
   *   2. not an edge from the current state -> `InvalidOrderTransitionException`
   *   3. the guarded UPDATE matched no row -> someone else moved it first; the
   *      real status is re-read and reported, because the client's optimistic
   *      view is wrong and silently succeeding would desync every subscriber.
   */
  async transition(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    newStatus: string,
  ): Promise<OrderRow> {
    const order = await this.loadOrder(connection, tenantId, orderId);
    // Both ends of the move go through the same authority. Resolving the
    // current one first also validates the stored value, so a row written by a
    // newer deploy fails loudly here instead of behaving like a state with no
    // outgoing edges.
    const currentState = orderStateFor(order.status);
    if (!isOrderStatus(newStatus)) {
      throw new UnknownOrderStatusException(newStatus);
    }

    if (!currentState.canTransitionTo(newStatus)) {
      throw new InvalidOrderTransitionException(
        order.id,
        currentState.status,
        newStatus,
        currentState.allowedTransitions(),
      );
    }

    const previousStatus = order.status;
    const updated = await this.repository.updateStatus(
      connection,
      tenantId,
      order.id,
      previousStatus,
      newStatus,
    );
    if (!updated) {
      const fresh = await this.repository.findById(
        connection,
        tenantId,
        order.id,
      );
      if (!fresh) {
        throw new OrderNotFoundException(orderId);
      }
      throw new InvalidOrderTransitionException(
        order.id,
        previousStatus,
        newStatus,
        orderStateFor(fresh.status).allowedTransitions(),
      );
    }

    // Line statuses are a KDS convenience; the header is the record of truth,
    // so a failure here is logged rather than rolled into the caller's error.
    try {
      await this.repository.syncItemStatuses(
        connection,
        tenantId,
        updated.id,
        updated.status,
      );
    } catch (error) {
      this.logger.warn(
        `Could not sync line statuses for order ${updated.id}: ${String(error)}`,
      );
    }

    // Completing or cancelling releases the table — but only once this order is
    // the LAST thing on it. Placed/paid transitions deliberately do not touch it.
    if (
      updated.table_id &&
      (newStatus === 'completed' || newStatus === 'cancelled')
    ) {
      await this.releaseTable(
        connection,
        tenantId,
        updated.id,
        updated.table_id,
      );
    }

    const occurredAt = new Date().toISOString();
    const statusChanged: OrderStatusChangedEvent = {
      event: ORDER_EVENTS.statusChanged,
      orderId: updated.id,
      tenantId,
      branchId: updated.branch_id,
      previousStatus,
      newStatus,
      tableId: updated.table_id,
      orderType: updated.order_type,
      totalAmount: updated.total_amount,
      occurredAt,
    };

    // Fires only once the transition is durable. Subscribers on the shared bus
    // read the order from their own connection, and this transaction is still
    // open (it commits on res.finish) — so emitting here would hand them a row
    // they cannot yet see. See `TenantScopedConnection.onCommit`.
    connection.onCommit(() => {
      this.events.emit(ORDER_EVENTS.statusChanged, statusChanged);

      if (newStatus === 'paid') {
        this.events.emit(ORDER_EVENTS.paid, {
          ...statusChanged,
          event: ORDER_EVENTS.paid,
          previousStatus,
        } satisfies OrderPaidEvent);
      }
    });

    return updated;
  }

  // -------------------------------------------------------------- helpers

  /**
   * Frees a table once its last open order is done.
   *
   * A table can hold more than one open ticket (a second party joining, a split
   * check), so a completed order does not by itself mean the table is empty —
   * releasing it unconditionally would tell the floor a still-seated party has
   * no table. The count makes "last one out turns off the lights" the rule.
   */
  private async releaseTable(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    tableId: string,
  ): Promise<void> {
    const stillOpen = await this.repository.countOtherOpenOrdersForTable(
      connection,
      tenantId,
      tableId,
      orderId,
    );
    if (stillOpen > 0) {
      return;
    }
    await this.branchService.setTableStatus(
      connection,
      tenantId,
      tableId,
      'free',
    );
  }

  private async loadOrder(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<OrderRow> {
    const order = await this.repository.findById(connection, tenantId, orderId);
    if (!order) {
      throw new OrderNotFoundException(orderId);
    }
    return order;
  }

  private publishPlaced(
    connection: TenantScopedConnection,
    tenantId: string,
    order: OrderRow,
    items: NewOrderItem[],
  ): void {
    const occurredAt = new Date().toISOString();

    const placed: OrderPlacedEvent = {
      event: ORDER_EVENTS.placed,
      orderId: order.id,
      tenantId,
      branchId: order.branch_id,
      orderType: order.order_type,
      status: 'placed',
      tableId: order.table_id,
      customerId: order.customer_id,
      totalAmount: order.total_amount,
      occurredAt,
      items: items.map((item) => ({
        menuItemId: item.menuItemId,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        notes: item.notes,
      })),
    };

    // Subscribers that only care about the order moving also get the initial
    // placement, so a KDS built solely on `order.status_changed` still sees a
    // brand new ticket without a second, creation-only event to handle.
    const statusChanged = {
      event: ORDER_EVENTS.statusChanged,
      orderId: order.id,
      tenantId,
      branchId: order.branch_id,
      previousStatus: null,
      newStatus: 'placed',
      tableId: order.table_id,
      orderType: order.order_type,
      totalAmount: order.total_amount,
      occurredAt,
    } satisfies OrderStatusChangedEvent;

    // Defer both until the order row is committed — see the note in
    // `transition`. Registration order is preserved, so `order.placed` still
    // arrives before the matching `order.status_changed`.
    connection.onCommit(() => {
      this.events.emit(ORDER_EVENTS.placed, placed);
      this.events.emit(ORDER_EVENTS.statusChanged, statusChanged);
    });
  }

  private resolveOrderType(dto: CreateOrderDto): OrderType {
    const orderType = dto.orderType ?? 'dine_in';
    if (!isOrderType(orderType)) {
      throw new BadRequestException(
        `orderType must be one of dine_in, takeaway, delivery (received '${String(orderType)}')`,
      );
    }
    return orderType;
  }

  /**
   * A dine-in order without a table cannot be served and has no table to
   * occupy, so it is refused at the door rather than stored as an order that
   * will confuse the floor staff. Takeaway/delivery must NOT carry a table:
   * the column is what every table side-effect keys on, and a takeaway order
   * that silently freed a dine-in table would be a support incident.
   */
  private resolveTableId(
    dto: CreateOrderDto,
    orderType: OrderType,
  ): string | null {
    const tableId = dto.tableId?.trim() || null;
    if (orderType === 'dine_in') {
      if (!tableId) {
        throw new BadRequestException('tableId is required for dine_in orders');
      }
      return tableId;
    }
    return null;
  }

  /**
   * Turns the request into priced lines using the MENU, not the client.
   *
   * Every unit price comes from `menu_items` (branch merge applied) and every
   * modifier extra from `menu_item_modifiers`. Nothing monetary is trusted from
   * the request body, and the result is frozen onto the order so a later menu
   * edit cannot rewrite history.
   */
  private async price(
    connection: TenantScopedConnection,
    tenantId: string,
    dto: CreateOrderDto,
  ): Promise<NewOrderItem[]> {
    if (!Array.isArray(dto.items) || dto.items.length === 0) {
      throw new BadRequestException('An order must contain at least one item');
    }
    if (dto.items.length > MAX_LINES) {
      throw new BadRequestException(
        `An order may not exceed ${MAX_LINES} lines`,
      );
    }

    const requestedIds = dto.items.map((item) => item.menuItemId);
    const resolved = await this.menuRepository.resolveItemsForBranch(
      connection,
      tenantId,
      dto.branchId,
      requestedIds,
    );

    const lines: NewOrderItem[] = [];
    for (const requested of dto.items) {
      const match: ResolvedMenuItem | undefined = resolved.get(
        requested.menuItemId,
      );
      if (!match) {
        throw new BadRequestException(
          `Menu item ${requested.menuItemId} does not exist on this branch's menu`,
        );
      }
      if (!match.isAvailable) {
        throw new BadRequestException(
          `Menu item ${requested.menuItemId} is currently unavailable`,
        );
      }

      const quantity = requested.quantity ?? 1;
      if (
        !Number.isInteger(quantity) ||
        quantity < 1 ||
        quantity > MAX_ITEM_QUANTITY
      ) {
        throw new BadRequestException(
          `quantity for menu item ${requested.menuItemId} must be a whole number between 1 and ${MAX_ITEM_QUANTITY}`,
        );
      }

      lines.push({
        menuItemId: match.menuItemId,
        quantity,
        unitPrice: match.price,
        notes: requested.notes ?? null,
        modifiers: await this.priceModifiers(
          connection,
          tenantId,
          match.menuItemId,
          requested.modifiers ?? [],
        ),
      });
    }
    return lines;
  }

  /**
   * Resolves each requested variant against the item's real modifier list and
   * takes the price from the menu. An unknown (`name`, `optionName`) pair is
   * refused rather than passed through at the caller's price — otherwise the
   * price of a drink would be whatever the phone decided to say it was.
   *
   * `order_item_modifiers` stores a single `name` snapshot, so the option is
   * what gets recorded ("Large"); the winning `modifier_id` is stored alongside
   * it, which is what lets a receipt re-join the group it belongs to ("Size").
   */
  private async priceModifiers(
    connection: TenantScopedConnection,
    tenantId: string,
    menuItemId: string,
    requested: NonNullable<CreateOrderDto['items'][number]['modifiers']>,
  ): Promise<NewOrderModifier[]> {
    if (requested.length === 0) {
      return [];
    }

    const available = await this.menuRepository.findModifiersForItems(
      connection,
      tenantId,
      [menuItemId],
    );
    const catalogue: MenuItemModifierRow[] = available.get(menuItemId) ?? [];

    return requested.map((chosen) => {
      const match = catalogue.find(
        (candidate) =>
          candidate.name.toLowerCase() === chosen.name.trim().toLowerCase() &&
          candidate.option_name.toLowerCase() ===
            chosen.optionName.trim().toLowerCase(),
      );
      if (!match) {
        throw new BadRequestException(
          `'${chosen.name}: ${chosen.optionName}' is not a modifier of menu item ${menuItemId}`,
        );
      }
      return {
        modifierId: chosen.modifierId ?? match.id,
        name: match.option_name,
        extraPrice: Number(match.extra_price),
      };
    });
  }
}

function modifierTotal(item: NewOrderItem): number {
  return item.modifiers.reduce((sum, modifier) => sum + modifier.extraPrice, 0);
}

/** Half-up to 2dp — `NUMERIC(10,2)` in the schema, not JS's float rules. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function nonNegative(value: number | undefined, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative number`);
  }
  return round2(value);
}
