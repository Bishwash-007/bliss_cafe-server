import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { OrderStatus } from '../state/order-state';

/**
 * Order-domain failures, each a distinct class so callers (and the HTTP layer)
 * can branch on the exact reason a write was refused without string-matching
 * messages. Mirrors the menu module's approach in
 * `src/menu/exceptions/menu-not-found.exception.ts`.
 */

/** The order id does not exist for this tenant (or the tenant may not see it). */
export class OrderNotFoundException extends NotFoundException {
  constructor(orderId: string) {
    super(`Order ${orderId} was not found for this tenant`);
  }
}

/**
 * The requested status is not one of the nine known values. Raised while
 * resolving the *current* state, which means it also fires for a row written by
 * a future/rolled-back version of this code — i.e. corrupt data, not a client
 * mistake. It is a 409 rather than a 400 for that reason: the request was
 * well-formed, the stored state is what is wrong.
 */
export class UnknownOrderStatusException extends BadRequestException {
  constructor(status: string) {
    super(`'${status}' is not a recognised order status`);
  }
}

/**
 * The core State-pattern rejection: `current -> target` is not an edge in the
 * transition table.
 *
 * The message names both ends of the attempted move and lists what IS legal
 * next, because this is the error a client developer sees first and "invalid
 * transition" alone sends them hunting through the source. An empty
 * `allowed` list means the order is in a terminal state.
 */
export class InvalidOrderTransitionException extends BadRequestException {
  constructor(
    readonly orderId: string,
    readonly currentStatus: OrderStatus,
    readonly targetStatus: string,
    readonly allowed: readonly OrderStatus[],
  ) {
    super(
      `Order ${orderId} cannot move from '${currentStatus}' to ` +
        `'${targetStatus}'. ` +
        (allowed.length > 0
          ? `Allowed next: ${allowed.join(', ')}.`
          : `'${currentStatus}' is a terminal state.`),
    );
  }
}
