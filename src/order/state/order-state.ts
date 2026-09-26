/**
 * ## State pattern (GoF) — the order lifecycle
 *
 * `orders.status` is a plain `VARCHAR(20)` in the schema (`006_orders.sql`),
 * and deliberately stays that way: no enum type, no CHECK-triggered state
 * machine in the database. Every rule about *which* status may follow *which*
 * lives here in application code, so the transition table is one readable file
 * instead of a trigger nobody can diff in review.
 *
 * The payoff is that `served -> placed` is not merely rejected by an `if` in
 * one handler that a new endpoint could forget — it is absent from the
 * transition table, so it is unwritable from anywhere in the codebase. Adding
 * a "rush order" endpoint cannot accidentally widen the graph: the graph is
 * owned by these classes and nothing else.
 *
 * Each concrete status gets its own class (`PlacedState`, `ConfirmedState`, …)
 * so that the rules for a status live in the class *for that status* — a
 * reviewer reading "what can happen after `ready`?" reads `ReadyState` and
 * nothing else.
 *
 * ## The graph, end to end
 *
 * ```
 *  placed -> confirmed -> preparing -> ready -> served -> awaiting_payment -> paid -> completed
 *     |          |            |          |         |             |
 *     +----------+---------- [cancelled] - - - - - +------------- +     (any pre-payment state)
 *
 *  completed  = terminal (read-only history)
 *  cancelled  = terminal
 * ```
 *
 * Business rules encoded below, and why:
 *   - `cancelled` is reachable from every PRE-PAYMENT status. A guest who
 *     changes their mind is a routine event at the counter, and blocking it
 *     would force staff to invent a fake `placed -> confirmed -> preparing ->
 *     ready -> served -> awaiting_payment -> cancelled` run just to cancel.
 *   - `cancelled` is NOT reachable from `paid`. Once money has moved the
 *     correct operation is a refund, which is a Payment-module concern, not an
 *     order status. Modelling a refund as a status change would let anyone
 *     holding an order-write token erase a settled sale.
 *   - the happy path is strictly linear. `served -> placed` (and every other
 *     "backwards" or "skip ahead" edge) is simply absent from the table, so it
 *     cannot be expressed.
 */

/**
 * The canonical status set, mirroring the comment on
 * `orders.status` in `db/migrations/006_orders.sql`. Kept as a runtime array
 * (not just a type) so the DTO layer, the state registry and the validation
 * errors can all iterate the one authoritative list.
 */
export const ORDER_STATUSES = [
  'placed',
  'confirmed',
  'preparing',
  'ready',
  'served',
  'awaiting_payment',
  'paid',
  'completed',
  'cancelled',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** Narrows an untrusted string (DTO body, query param) to a known status. */
export function isOrderStatus(value: unknown): value is OrderStatus {
  return (
    typeof value === 'string' &&
    (ORDER_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * One node of the order lifecycle graph.
 *
 * `allowedTransitions()` returns `OrderStatus[]` (a `string[]`, as the module
 * brief specifies) — the statuses reachable from here, in a stable order.
 */
export interface OrderState {
  readonly status: OrderStatus;
  allowedTransitions(): OrderStatus[];
  /** Convenience predicate for "this status is a dead end". */
  isTerminal(): boolean;
  canTransitionTo(target: OrderStatus): boolean;
}

/**
 * Shared implementation: a subclass only declares its status and the statuses
 * it may move to. `allowedTransitions()` hands back a COPY so a caller cannot
 * mutate the table by writing into the returned array.
 */
export abstract class AbstractOrderState implements OrderState {
  abstract readonly status: OrderStatus;
  protected abstract transitions(): readonly OrderStatus[];

  allowedTransitions(): OrderStatus[] {
    return [...this.transitions()];
  }

  isTerminal(): boolean {
    return this.transitions().length === 0;
  }

  canTransitionTo(target: OrderStatus): boolean {
    return this.transitions().includes(target);
  }
}
