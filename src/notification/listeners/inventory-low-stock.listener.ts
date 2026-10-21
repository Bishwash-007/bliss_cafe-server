import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { INVENTORY_EVENTS, type InventoryLowStockEvent } from '../../inventory';
import { NotificationService } from '../notification.service';

/**
 * `inventory.low_stock` -> email the branch manager(s).
 *
 * The inventory module publishes after the movement has committed, which is
 * what makes it safe for this listener to open its own connection and read
 * `users`: the row it needs is already visible. It does not re-read the item,
 * because the payload carries the level the movement produced.
 *
 * A second movement while the item is still low is a fresh event with a new
 * `triggeredByMovementId`, and the service keys jobs on that id. Redelivery of
 * the SAME event is deduped by the queue instead of emailing twice.
 */
@Injectable()
export class InventoryLowStockNotificationListener {
  private readonly logger = new Logger(
    InventoryLowStockNotificationListener.name,
  );

  constructor(private readonly notifications: NotificationService) {}

  @OnEvent(INVENTORY_EVENTS.lowStock)
  async onLowStock(event: InventoryLowStockEvent): Promise<void> {
    try {
      const outcome = await this.notifications.notifyLowStock(event);
      if (outcome.queued === 0) {
        this.logger.debug(
          `No low-stock email for ${event?.inventoryItemId}: ${outcome.skipped}.`,
        );
      }
    } catch (error) {
      // The stock movement is already committed. An alerting failure must not
      // turn into a failed stock operation.
      this.logger.error(
        `Could not queue the low-stock alert for ${event?.inventoryItemId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }
}
