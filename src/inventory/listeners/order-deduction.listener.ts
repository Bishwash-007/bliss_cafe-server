import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ORDER_EVENTS, type OrderStatusChangedEvent } from '../../order';
import { InventoryService, type DeductionOutcome } from '../inventory.service';

/**
 * # Turns a completed order into a stock deduction
 *
 * This class is the entire reason `InventoryModule` depends on `OrderModule`, and
 * the dependency is one import of one event name. The listener never touches
 * `OrderService` or `OrderRepository`: it does not re-read the order, does not
 * ask the order module for permission, and does not care how an order reaches
 * `completed` (the API, a payment webhook, a manager override). All of that is
 * the order module's business and none of it is this module's.
 *
 * `ORDER_EVENTS` is imported from the order module's public barrel
 * (`../../order`) rather than from deep paths, so the only thing that has to stay
 * stable for inventory is the event contract itself.
 */
@Injectable()
export class OrderDeductionListener {
  private readonly logger = new Logger(OrderDeductionListener.name);

  constructor(private readonly inventory: InventoryService) {}

  /**
   * Deductions are triggered ONLY by `completed`.
   *
   * The terminal state is the trigger rather than `ready` or `served` because a
   * dish can be served and then sent back, or a table order can be paid without
   * every line having been made. `completed` is the first point at which the
   * sale is final, so it is the only point at which the stock is definitely
   * gone.
   */
  @OnEvent(ORDER_EVENTS.statusChanged)
  async handleOrderStatusChanged(
    event: OrderStatusChangedEvent,
  ): Promise<DeductionOutcome | null> {
    if (event.newStatus !== 'completed') {
      return null;
    }

    // `deductForOrder` never throws: it rolls back, records the discrepancy on
    // its own connection, and resolves. Anything that DID escape would be a bug
    // in the failure path itself, and is still caught here so that a bug in it
    // cannot take down the request that completed the order.
    try {
      const outcome = await this.inventory.deductForOrder(
        event.tenantId,
        event.orderId,
      );
      if (outcome.deduplicated) {
        // Not an error: the bus is best-effort, so the same event can arrive
        // twice. Worth a log line because a stream of these means something is
        // re-emitting, and an order is never deducted twice.
        this.logger.debug(
          `Order ${event.orderId} was already deducted (${outcome.status}); ignoring the duplicate event.`,
        );
      } else if (outcome.status === 'partial') {
        this.logger.warn(
          `Order ${event.orderId} completed with a PARTIAL stock deduction: ` +
            `${outcome.menuItemsWithoutRecipe.join(', ') || 'see discrepancies'}. ` +
            `Stock was deducted for the rest; see GET /inventory/discrepancies.`,
        );
      }
      return outcome;
    } catch (error) {
      this.logger.error(
        `Unhandled error deducting stock for order ${event.orderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }
}
