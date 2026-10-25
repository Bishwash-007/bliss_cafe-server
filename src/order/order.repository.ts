import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { OrderType } from './events/order-events';
import type { OrderStatus } from './state/order-state';

export interface OrderRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  table_id: string | null;
  customer_id: string | null;
  created_by: string | null;
  order_type: OrderType;
  status: OrderStatus;
  subtotal: number;
  tax_amount: number;
  discount_amount: number;
  total_amount: number;
  client_action_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OrderItemRow {
  id: string;
  tenant_id: string;
  order_id: string;
  menu_item_id: string;
  quantity: number;
  unit_price: number;
  notes: string | null;
  status: string;
}

export interface OrderItemModifierRow {
  id: string;
  tenant_id: string;
  order_item_id: string;
  modifier_id: string | null;
  name: string;
  extra_price: number;
}

/** A priced line, as `OrderService` computes it before handing it to SQL. */
export interface NewOrderItem {
  menuItemId: string;
  quantity: number;
  unitPrice: number;
  notes: string | null;
  modifiers: NewOrderModifier[];
}

export interface NewOrderModifier {
  modifierId: string | null;
  /** Snapshot label — see `order_item_modifiers.name` in the migration. */
  name: string;
  extraPrice: number;
}

export interface CreateOrderInput {
  branchId: string;
  tableId: string | null;
  customerId: string | null;
  createdBy: string | null;
  orderType: OrderType;
  subtotal: number;
  taxAmount: number;
  discountAmount: number;
  totalAmount: number;
  clientActionId: string | null;
  items: NewOrderItem[];
}

const ORDER_COLUMNS = `id, tenant_id, branch_id, table_id, customer_id, created_by,
       order_type, status, subtotal, tax_amount, discount_amount, total_amount,
       client_action_id, created_at, updated_at`;

/**
 * `pg` returns `NUMERIC` as a STRING (to avoid silently losing precision on
 * values it cannot hold as a float), so `total_amount` arrives as `"12.50"`.
 * Money is coerced to `number` here, at the DAL boundary, so the declared row
 * types above are truthful and the domain never re-parses. Same reasoning and
 * same caveat as `MenuRepository` — Postgres still stores/aggregates NUMERIC
 * exactly, but anything needing exact decimal arithmetic (Payment) should
 * carry integer minor units rather than trust float addition.
 */
function money(value: string | number | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value);
}

function toOrderRow(row: OrderRow): OrderRow {
  return {
    ...row,
    subtotal: money(row.subtotal),
    tax_amount: money(row.tax_amount),
    discount_amount: money(row.discount_amount),
    total_amount: money(row.total_amount),
  };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PostgreSQL raises `23505` (unique_violation) when the partial unique index
 * `idx_orders_client_action` rejects a duplicate idempotency key. Exported so
 * `OrderService` can tell "this retry is someone else's already-created order"
 * apart from a genuine constraint failure.
 */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

/**
 * Data access for orders, their lines and their modifier snapshots. Every
 * statement is tenant-scoped through `TenantScopedConnection`, so RLS is the
 * second layer of defence rather than the only one.
 *
 * Note the asymmetry with `MenuRepository`: there are no price lookups here.
 * Pricing belongs to the menu, and the *order* records the result — this layer
 * only writes down the numbers `OrderService` derived.
 */
@Injectable()
export class OrderRepository {
  private savepointCounter = 0;

  /**
   * Runs `work` inside a SAVEPOINT.
   *
   * ## Why the idempotency path needs this
   *
   * `TenantScopedConnection` gives each request ONE transaction. In Postgres a
   * constraint violation ABORTS the whole transaction: every later statement on
   * that connection fails with `25P02` ("current transaction is aborted") until
   * something rolls back. So the naive shape —
   *
   * ```ts
   * try { await insert() } catch { return await findByClientActionId() }
   * ```
   *
   * cannot work: the recovery query is itself rejected. The observable symptom
   * is a retried offline action returning 500 instead of the original order,
   * which is exactly the failure the idempotency key exists to prevent.
   *
   * Rolling back to a savepoint un-poisons the transaction while keeping the
   * work done BEFORE it (the tenant pinning, and anything else this request
   * legitimately wrote). This is the standard Postgres idiom and it is what
   * makes the "one request, one transaction" model compatible with
   * recover-and-retry.
   */
  async withSavepoint<T>(
    connection: TenantScopedConnection,
    work: () => Promise<T>,
  ): Promise<T> {
    const name = `order_sp_${++this.savepointCounter}`;
    await connection.query(`SAVEPOINT ${name}`);
    try {
      const value = await work();
      await connection.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await connection
        .query(`ROLLBACK TO SAVEPOINT ${name}`)
        .catch(() => undefined);
      await connection
        .query(`RELEASE SAVEPOINT ${name}`)
        .catch(() => undefined);
      throw error;
    }
  }

  /**
   * The idempotency lookup for the mobile offline action queue.
   *
   * This is the read half of the `idx_orders_client_action` partial unique
   * index: the index makes a duplicate INSERT impossible, this makes a
   * duplicate INSERT *harmless* by returning the row that won the race.
   */
  findByClientActionId(
    connection: TenantScopedConnection,
    tenantId: string,
    clientActionId: string,
  ): Promise<OrderRow | null> {
    if (!UUID_RE.test(clientActionId)) {
      return Promise.resolve(null);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders
          WHERE tenant_id = $1 AND client_action_id = $2`,
        [tenantId, clientActionId],
      )
      .then((result) => (result.rows[0] ? toOrderRow(result.rows[0]) : null));
  }

  findById(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<OrderRow | null> {
    if (!UUID_RE.test(orderId)) {
      return Promise.resolve(null);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS} FROM orders WHERE id = $1 AND tenant_id = $2`,
        [orderId, tenantId],
      )
      .then((result) => (result.rows[0] ? toOrderRow(result.rows[0]) : null));
  }

  /**
   * Orders still on the rail for one branch, oldest first — exactly what a KDS
   * screen shows on (re)connect. Terminal statuses are excluded so a display
   * does not have to filter them client-side.
   */
  listActiveByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<OrderRow[]> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve([]);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders
          WHERE tenant_id = $1
            AND branch_id = $2
            AND status NOT IN ('completed', 'cancelled')
          ORDER BY created_at, id`,
        [tenantId, branchId],
      )
      .then((result) => result.rows.map(toOrderRow));
  }

  countActiveByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<number> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve(0);
    }
    return connection
      .query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM orders
          WHERE tenant_id = $1
            AND branch_id = $2
            AND status NOT IN ('completed', 'cancelled')`,
        [tenantId, branchId],
      )
      .then((result) => Number(result.rows[0]?.count ?? 0));
  }

  listActiveByBranchPaginated(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    limit: number,
    offset: number,
  ): Promise<OrderRow[]> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve([]);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders
          WHERE tenant_id = $1
            AND branch_id = $2
            AND status NOT IN ('completed', 'cancelled')
          ORDER BY created_at, id
          LIMIT $3 OFFSET $4`,
        [tenantId, branchId, limit, offset],
      )
      .then((result) => result.rows.map(toOrderRow));
  }

  listByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<OrderRow[]> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve([]);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders
          WHERE tenant_id = $1 AND branch_id = $2
          ORDER BY created_at DESC, id DESC`,
        [tenantId, branchId],
      )
      .then((result) => result.rows.map(toOrderRow));
  }

  countByBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<number> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve(0);
    }
    return connection
      .query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM orders
          WHERE tenant_id = $1 AND branch_id = $2`,
        [tenantId, branchId],
      )
      .then((result) => Number(result.rows[0]?.count ?? 0));
  }

  listByBranchPaginated(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    limit: number,
    offset: number,
  ): Promise<OrderRow[]> {
    if (!UUID_RE.test(branchId)) {
      return Promise.resolve([]);
    }
    return connection
      .query<OrderRow>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders
          WHERE tenant_id = $1 AND branch_id = $2
          ORDER BY created_at DESC, id DESC
          LIMIT $3 OFFSET $4`,
        [tenantId, branchId, limit, offset],
      )
      .then((result) => result.rows.map(toOrderRow));
  }

  /**
   * Inserts the order header and its lines, then the modifier snapshots.
   *
   * All three writes go through the caller's single tenant-scoped connection,
   * so the ticket is atomic: a failure part-way rolls the whole thing back
   * rather than leaving an order with half its lines.
   */
  async create(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreateOrderInput,
  ): Promise<OrderRow> {
    const header = await connection
      .query<OrderRow>(
        `INSERT INTO orders
           (tenant_id, branch_id, table_id, customer_id, created_by, order_type,
            status, subtotal, tax_amount, discount_amount, total_amount,
            client_action_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'placed', $7, $8, $9, $10, $11)
         RETURNING ${ORDER_COLUMNS}`,
        [
          tenantId,
          input.branchId,
          input.tableId,
          input.customerId,
          input.createdBy,
          input.orderType,
          input.subtotal,
          input.taxAmount,
          input.discountAmount,
          input.totalAmount,
          input.clientActionId,
        ],
      )
      .then((result) => {
        const row = result.rows[0];
        if (!row) {
          throw new Error('orders insert returned no row');
        }
        return toOrderRow(row);
      });

    for (const item of input.items) {
      const inserted = await connection
        .query<OrderItemRow>(
          `INSERT INTO order_items
             (tenant_id, order_id, menu_item_id, quantity, unit_price, notes)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id`,
          [
            tenantId,
            header.id,
            item.menuItemId,
            item.quantity,
            item.unitPrice,
            item.notes,
          ],
        )
        .then((result) => {
          const row = result.rows[0];
          if (!row) {
            throw new Error('order_items insert returned no row');
          }
          return row;
        });

      for (const modifier of item.modifiers) {
        await connection.query(
          `INSERT INTO order_item_modifiers
             (tenant_id, order_item_id, modifier_id, name, extra_price)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            tenantId,
            inserted.id,
            modifier.modifierId,
            modifier.name,
            modifier.extraPrice,
          ],
        );
      }
    }

    return header;
  }

  /**
   * How many OTHER orders are still open on a table.
   *
   * A table can legitimately carry more than one ticket at a time (a second
   * party joining mid-visit, a split check, an order placed before the previous
   * one was closed out), so "this order is done" does not on its own mean "this
   * table is free". Without this count, cancelling one of two open orders would
   * hand a still-seated party a table the floor now believes is empty.
   */
  countOtherOpenOrdersForTable(
    connection: TenantScopedConnection,
    tenantId: string,
    tableId: string,
    excludeOrderId: string,
  ): Promise<number> {
    return connection
      .query<{ count: number }>(
        `SELECT count(*)::int AS count
           FROM orders
          WHERE tenant_id = $1
            AND table_id = $2
            AND id <> $3
            AND status NOT IN ('completed', 'cancelled')`,
        [tenantId, tableId, excludeOrderId],
      )
      .then((result) => result.rows[0]?.count ?? 0);
  }

  findItems(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<OrderItemRow[]> {
    return connection
      .query<OrderItemRow>(
        `SELECT id, tenant_id, order_id, menu_item_id, quantity, unit_price,
                notes, status
           FROM order_items
          WHERE tenant_id = $1 AND order_id = $2
          ORDER BY id`,
        [tenantId, orderId],
      )
      .then((result) =>
        result.rows.map((row) => ({
          ...row,
          unit_price: money(row.unit_price),
        })),
      );
  }

  /**
   * Moves the order to `newStatus`.
   *
   * The `AND status = $current` in the WHERE clause is an optimistic
   * concurrency guard, not a State-pattern rule: two waiters tapping "start
   * cooking" at the same instant both pass the in-memory transition check, and
   * only one of them may actually write. The loser gets `null` back and the
   * service re-reads and reports the truth rather than emitting a second
   * `order.status_changed` for a move that never happened.
   */
  updateStatus(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    currentStatus: OrderStatus,
    newStatus: OrderStatus,
  ): Promise<OrderRow | null> {
    if (!UUID_RE.test(orderId)) {
      return Promise.resolve(null);
    }
    return connection
      .query<OrderRow>(
        `UPDATE orders
            SET status = $4, updated_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = $3
          RETURNING ${ORDER_COLUMNS}`,
        [orderId, tenantId, currentStatus, newStatus],
      )
      .then((result) => (result.rows[0] ? toOrderRow(result.rows[0]) : null));
  }

  /**
   * Mirrors the header status onto the lines, so the KDS can show "2 of 3
   * items ready" without a join. `order_items.status` only knows
   * placed/preparing/ready/served/cancelled, so a payment-side order status
   * maps onto the closest line status rather than being written through as an
   * unrecognised value.
   *
   * Best-effort by design: a failure here must not fail the transition, since
   * the header status is the record of truth.
   */
  async syncItemStatuses(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    status: OrderStatus,
  ): Promise<void> {
    const lineStatus = ORDER_ITEM_STATUS_FOR_ORDER_STATUS[status];
    if (!lineStatus) {
      return;
    }
    await connection.query(
      `UPDATE order_items
          SET status = $3
        WHERE tenant_id = $1 AND order_id = $2 AND status <> $3`,
      [tenantId, orderId, lineStatus],
    );
  }
}

/**
 * Header status -> line status. The order lifecycle is longer than the line
 * lifecycle, so several header statuses collapse onto "the line is done"
 * (`served`) and the payment-only statuses collapse onto it too.
 */
const ORDER_ITEM_STATUS_FOR_ORDER_STATUS: Partial<Record<OrderStatus, string>> =
  {
    placed: 'placed',
    confirmed: 'placed',
    preparing: 'preparing',
    ready: 'ready',
    served: 'served',
    awaiting_payment: 'served',
    paid: 'served',
    completed: 'served',
    cancelled: 'cancelled',
  };
