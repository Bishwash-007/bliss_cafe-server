import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  CrmBirthdayEvent,
  CrmCustomerEvent,
  CrmPromotionEvent,
} from '../crm/events/crm-events';
import type {
  InventoryLowStockEvent,
  LowStockSeverity,
} from '../inventory/events/inventory-events';
import type { OrderStatusChangedEvent } from '../order/events/order-events';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import {
  isNotificationChannel,
  type NotificationChannelName,
  type NotificationDeadLetter,
  type NotificationJob,
  type NotificationMessage,
  type NotificationSource,
} from './notification.types';
import {
  NotificationRepository,
  type CustomerContactRow,
  type OrderNotificationContextRow,
} from './notification.repository';
import {
  NOTIFICATION_QUEUE,
  type NotificationQueue,
} from './queue/notification.queue';

/**
 * Why a notification was not queued.
 *
 * These are normal outcomes, not errors: a customer with no contact details,
 * an order with no customer, an opted-out guest, a branch with no manager.
 * Returning the reason lets the listener log a useful line at debug rather
 * than silently swallowing the event.
 */
export type NotificationSkipReason =
  | 'order_not_found'
  | 'customer_not_found'
  | 'no_customer'
  | 'opted_out'
  | 'no_recipient'
  | 'no_manager'
  | 'not_ready';

export type NotificationDispatchResult =
  | { queued: number; skipped: null }
  | { queued: 0; skipped: NotificationSkipReason };

/**
 * # NotificationService
 *
 * Turns a domain event into zero or more queued jobs.
 *
 * This is the only place that decides WHO gets a notification, on WHICH
 * channel, and whether they have opted out. Listeners stay thin (map event ->
 * call); the queue stays dumb (JSON in, delivery attempt out); channels stay
 * transport-only. That division is what lets the opt-out rule be tested once
 * instead of once per listener.
 *
 * ## Opt-out is checked here, before enqueue
 *
 * A `customers.notification_opt_out` row is honoured for every customer-facing
 * message. It is deliberately NOT a channel-level concern: if a customer opts
 * out, falling back from push to SMS would defeat the point. Operational
 * mail to staff (low stock) is not a customer preference and is not filtered.
 *
 * ## The listener has no request
 *
 * Like the CRM and inventory listeners, this service acquires its own
 * tenant-scoped connection with `TenantConnectionService`; it never injects
 * `TenantRequestContext`, which is bound to a request that has already
 * finished. The job also carries `tenantId` so the worker and the dead-letter
 * inspector can stay tenant-correct without a request.
 */
@Injectable()
export class NotificationService {
  private readonly logger = new Logger(NotificationService.name);

  constructor(
    private readonly repository: NotificationRepository,
    private readonly connections: TenantConnectionService,
    @Inject(NOTIFICATION_QUEUE)
    private readonly queue: NotificationQueue,
  ) {}

  /**
   * `order.status_changed` -> `ready`.
   *
   * Channel choice follows what can actually be delivered:
   *   - a registered device token (a customer/loyalty account with the app) gets
   *     push;
   *   - otherwise a phone number gets SMS;
   *   - a customer with neither is skipped. There is no email fallback here on
   *     purpose: the brief routes "ready" to push or SMS, and quietly emailing
   *     a time-sensitive pickup alert is worse than sending nothing.
   */
  async notifyOrderReady(
    event: Pick<
      OrderStatusChangedEvent,
      'tenantId' | 'orderId' | 'branchId' | 'newStatus'
    >,
  ): Promise<NotificationDispatchResult> {
    if (event.newStatus !== 'ready') {
      return { queued: 0, skipped: 'not_ready' };
    }

    return this.withConnection(event.tenantId, async (connection) => {
      const order = await this.repository.findOrderContext(
        connection,
        event.tenantId,
        event.orderId,
      );
      if (!order) {
        return { queued: 0, skipped: 'order_not_found' };
      }
      if (!order.customer) {
        return { queued: 0, skipped: 'no_customer' };
      }
      if (order.customer.notification_opt_out) {
        return { queued: 0, skipped: 'opted_out' };
      }

      const target = orderReadyTarget(order.customer);
      if (!target) {
        return { queued: 0, skipped: 'no_recipient' };
      }

      const message = orderReadyMessage(order);
      await this.queue.enqueue(
        this.job({
          tenantId: event.tenantId,
          channel: target.channel,
          recipient: target.recipient,
          message,
          eventKey: `order-ready:${event.orderId}:${target.channel}`,
          source: 'order.ready',
          context: {
            orderId: event.orderId,
            branchId: event.branchId,
            customerId: order.customer.id,
          },
        }),
      );

      return { queued: 1, skipped: null };
    });
  }

  /**
   * `inventory.low_stock` -> email every active branch manager for the branch.
   *
   * One job per manager, each with its own `eventKey`. A shared key would let
   * the queue dedupe the second manager away — the classic bug where the
   * on-call manager is the one who does not get the alert.
   */
  async notifyLowStock(
    event: InventoryLowStockEvent,
  ): Promise<NotificationDispatchResult> {
    return this.withConnection(event.tenantId, async (connection) => {
      const managers = await this.repository.listBranchManagers(
        connection,
        event.tenantId,
        event.branchId,
      );
      const deliverable = managers.filter(
        (manager) => manager.email?.trim().length > 0,
      );
      if (deliverable.length === 0) {
        return { queued: 0, skipped: 'no_manager' };
      }

      const message = lowStockMessage(event);
      const dedupe = event.triggeredByMovementId ?? `at-${event.occurredAt}`;

      for (const manager of deliverable) {
        await this.queue.enqueue(
          this.job({
            tenantId: event.tenantId,
            channel: 'email',
            recipient: manager.email.trim(),
            message,
            eventKey: `inventory-low-stock:${event.inventoryItemId}:${dedupe}:${manager.id}`,
            source: 'inventory.low_stock',
            context: {
              inventoryItemId: event.inventoryItemId,
              branchId: event.branchId,
              managerId: manager.id,
            },
          }),
        );
      }

      return { queued: deliverable.length, skipped: null };
    });
  }

  /**
   * CRM promo/birthday -> the customer's preferred channel.
   *
   * Preference comes from `customers.notification_channel` (migration 016), but
   * a preference is a wish, not an address: if the customer picked push and has
   * no device token, the service falls back to SMS/email rather than dropping
   * the message. Opt-out still wins over every fallback.
   */
  async notifyCrmEvent(
    event: CrmCustomerEvent,
  ): Promise<NotificationDispatchResult> {
    return this.withConnection(event.tenantId, async (connection) => {
      const customer = await this.repository.findCustomerContact(
        connection,
        event.tenantId,
        event.customerId,
      );
      if (!customer) {
        return { queued: 0, skipped: 'customer_not_found' };
      }
      if (customer.notification_opt_out) {
        return { queued: 0, skipped: 'opted_out' };
      }

      const target = crmTarget(customer);
      if (!target) {
        return { queued: 0, skipped: 'no_recipient' };
      }

      const message =
        event.event === 'crm.promotion'
          ? promotionMessage(event)
          : birthdayMessage(event, customer);
      const eventKey =
        event.event === 'crm.promotion'
          ? `crm-promotion:${event.promotionId}:${event.customerId}`
          : `crm-birthday:${event.customerId}:${event.occurredAt.slice(0, 4)}`;

      await this.queue.enqueue(
        this.job({
          tenantId: event.tenantId,
          channel: target.channel,
          recipient: target.recipient,
          message,
          eventKey,
          source: event.event,
          context: {
            customerId: event.customerId,
            ...(event.event === 'crm.promotion'
              ? { promotionId: event.promotionId }
              : {}),
          },
        }),
      );

      return { queued: 1, skipped: null };
    });
  }

  async listDeadLetters(
    tenantId: string,
    limit: number,
  ): Promise<NotificationDeadLetter[]> {
    return this.queue.listDeadLetters(tenantId, limit);
  }

  /** The queue driver, exposed for the health/inspect endpoint and tests. */
  get driver() {
    return this.queue.driver;
  }

  private job(input: {
    tenantId: string;
    channel: NotificationChannelName;
    recipient: string;
    message: NotificationMessage;
    eventKey: string;
    source: NotificationSource;
    context: Record<string, string>;
  }): NotificationJob {
    return {
      ...input,
      enqueuedAt: new Date().toISOString(),
    };
  }

  /**
   * Runs `work` on a tenant-scoped connection and always returns it to the pool.
   *
   * These reads are short and the listeners are not inside a request, so a
   * fresh scoped transaction is the simplest correct option. On error the
   * transaction is rolled back explicitly; a commit of an aborted transaction
   * is not a substitute.
   */
  private async withConnection<T>(
    tenantId: string,
    work: (connection: TenantScopedConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      return await work(connection);
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      throw error;
    } finally {
      if (!connection.isReleased) {
        await connection.release().catch((releaseError: unknown) => {
          this.logger.warn(
            `Could not release notification connection: ${
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError)
            }`,
          );
        });
      }
    }
  }
}

// -------------------------------------------------------------------- mapping

interface NotificationTarget {
  channel: NotificationChannelName;
  recipient: string;
}

/** Push if a device token exists, otherwise SMS, otherwise nothing. */
export function orderReadyTarget(
  customer: Pick<CustomerContactRow, 'phone' | 'push_token'>,
): NotificationTarget | null {
  const pushToken = customer.push_token?.trim();
  if (pushToken) {
    return { channel: 'push', recipient: pushToken };
  }
  const phone = customer.phone?.trim();
  if (phone) {
    return { channel: 'sms', recipient: phone };
  }
  return null;
}

/** Preferred channel first, then the other channels the customer has a contact for. */
export function crmTarget(
  customer: Pick<
    CustomerContactRow,
    'phone' | 'email' | 'push_token' | 'notification_channel'
  >,
): NotificationTarget | null {
  const preferred = isNotificationChannel(customer.notification_channel)
    ? customer.notification_channel
    : null;
  const candidates: NotificationChannelName[] = preferred
    ? [preferred, 'push', 'sms', 'email']
    : ['push', 'sms', 'email'];

  for (const channel of candidates) {
    const recipient = recipientFor(channel, customer);
    if (recipient) {
      return { channel, recipient };
    }
  }
  return null;
}

function recipientFor(
  channel: NotificationChannelName,
  customer: Pick<CustomerContactRow, 'phone' | 'email' | 'push_token'>,
): string | null {
  const value =
    channel === 'push'
      ? customer.push_token
      : channel === 'sms'
        ? customer.phone
        : customer.email;
  return value?.trim() || null;
}

function orderReadyMessage(
  order: Pick<OrderNotificationContextRow, 'order_id' | 'order_type'>,
): NotificationMessage {
  const reference = order.order_id.slice(0, 8);
  const destination =
    order.order_type === 'dine_in'
      ? 'Our team will bring it to your table.'
      : 'It is ready for pickup.';
  return {
    title: 'Your order is ready',
    body: `Order #${reference} is ready. ${destination}`,
    data: {
      type: 'order.ready',
      orderId: order.order_id,
    },
  };
}

function lowStockMessage(event: InventoryLowStockEvent): NotificationMessage {
  const out = event.severity === LOW_STOCK_OUT;
  const title = `${out ? 'Out of stock' : 'Low stock'}: ${event.name}`;
  const body =
    `${event.name} is ${out ? 'out of stock' : 'below its reorder point'}. ` +
    `${event.quantityOnHand} ${event.unit} on hand; reorder at ${event.reorderThreshold} ${event.unit}.`;
  return {
    title,
    body,
    data: {
      type: 'inventory.low_stock',
      inventoryItemId: event.inventoryItemId,
      branchId: event.branchId,
      severity: event.severity,
    },
  };
}

const LOW_STOCK_OUT: LowStockSeverity = 'out_of_stock';

function promotionMessage(event: CrmPromotionEvent): NotificationMessage {
  const description = event.description?.trim();
  return {
    title: 'A promotion for you',
    body: description
      ? `${event.code}: ${description}`
      : `${event.code} is waiting for you.`,
    data: {
      type: 'crm.promotion',
      promotionId: event.promotionId,
      code: event.code,
    },
  };
}

function birthdayMessage(
  event: CrmBirthdayEvent,
  customer: Pick<CustomerContactRow, 'full_name'>,
): NotificationMessage {
  const name = customer.full_name?.trim() || event.customerName?.trim();
  return {
    title: name ? `Happy birthday, ${name}!` : 'Happy birthday!',
    body: 'Everyone here wishes you a wonderful birthday. Treat yourself today.',
    data: { type: 'crm.birthday' },
  };
}
