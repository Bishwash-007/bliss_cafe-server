import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ORDER_EVENTS, type OrderPaidEvent } from '../../order';
import { CrmService } from '../crm.service';
import type { LoyaltyAccrualOutcome } from '../crm.types';

/**
 * # Turns a paid order into loyalty points
 *
 * This is the Observer half of the module: `OrderModule` publishes
 * `order.paid`, and this listener reacts. Nothing in the checkout path calls
 * CRM, so a loyalty failure cannot fail a payment that has already been taken,
 * and the order module stays unaware that loyalty exists.
 *
 * The dependency is one import of one event name — never `OrderService`,
 * never `OrderRepository`. The listener does not care whether the order was
 * paid by the POS, a webhook or a manager override.
 *
 * ## Idempotency lives in the database, not here
 *
 * This class deliberately keeps no "already handled" set. The bus is
 * in-process and best-effort, so the same order can arrive twice — including
 * from two instances and therefore two listener objects. The UNIQUE
 * `(tenant_id, order_id)` index on `loyalty_credits` is the authority;
 * `CrmService.awardForPaidOrder` reports a duplicate rather than awarding
 * again, and this listener logs it at debug level (a stream of duplicates is
 * worth seeing, but it is not an error).
 */
@Injectable()
export class OrderPaidLoyaltyListener {
  private readonly logger = new Logger(OrderPaidLoyaltyListener.name);

  constructor(private readonly crm: CrmService) {}

  @OnEvent(ORDER_EVENTS.paid)
  async handleOrderPaid(
    event: OrderPaidEvent,
  ): Promise<LoyaltyAccrualOutcome | null> {
    // A handler that throws here runs inside the publisher's event loop after
    // the order transaction has committed. There is nothing left to roll back,
    // and letting the error escape would only couple a loyalty bookkeeping
    // problem to a completed sale.
    try {
      const outcome = await this.crm.awardForPaidOrder(
        event.tenantId,
        event.orderId,
      );

      if (!outcome.credited) {
        if (outcome.reason === 'duplicate') {
          this.logger.debug(
            `Order ${event.orderId} was already credited; ignoring the duplicate order.paid event.`,
          );
        } else if (outcome.reason === 'no_customer') {
          this.logger.debug(
            `Order ${event.orderId} has no customer; no loyalty points to award.`,
          );
        } else {
          this.logger.warn(
            `Order ${event.orderId} was not found for tenant ${event.tenantId}; ` +
              `no loyalty points were awarded.`,
          );
        }
      }

      return outcome;
    } catch (error) {
      this.logger.error(
        `Unhandled error awarding loyalty points for order ${event.orderId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      return null;
    }
  }
}
