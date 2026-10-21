import type { CrmBirthdayEvent, CrmPromotionEvent } from '../crm';
import type { InventoryLowStockEvent } from '../inventory';
import type { OrderStatusChangedEvent } from '../order';
import { NotificationService } from './notification.service';
import type {
  NotificationJob,
  NotificationQueueReceipt,
} from './notification.types';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';

const ORDER_EVENT: OrderStatusChangedEvent = {
  event: 'order.status_changed',
  orderId: '11111111-1111-4111-8111-111111111111',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  previousStatus: 'preparing',
  newStatus: 'ready',
  tableId: null,
  orderType: 'takeaway',
  totalAmount: 250,
  occurredAt: '2026-10-21T12:00:00.000Z',
};

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'customer-1',
    tenant_id: 'tenant-1',
    full_name: 'Asha Rai',
    phone: '9800000000',
    email: 'asha@example.test',
    push_token: null,
    notification_opt_out: false,
    notification_channel: null,
    ...overrides,
  };
}

function orderContext(customerOverrides: Record<string, unknown> | null = {}) {
  return {
    order_id: ORDER_EVENT.orderId,
    tenant_id: 'tenant-1',
    branch_id: 'branch-1',
    order_type: 'takeaway',
    table_id: null,
    total_amount: '250.00',
    customer:
      customerOverrides === null
        ? null
        : customer({ id: 'customer-1', ...customerOverrides }),
  };
}

function makeService() {
  const repository = {
    findOrderContext: jest.fn(),
    findCustomerContact: jest.fn(),
    listBranchManagers: jest.fn(),
  };
  let released = false;
  const connection = {
    release: jest.fn(() => {
      released = true;
      return Promise.resolve();
    }),
    rollback: jest.fn(() => {
      released = true;
      return Promise.resolve();
    }),
    get isReleased() {
      return released;
    },
  };
  const connections = {
    acquireScoped: jest.fn(() => Promise.resolve(connection)),
  };
  const queue = {
    driver: 'memory' as const,
    enqueue: jest.fn<Promise<NotificationQueueReceipt>, [NotificationJob]>(),
    listDeadLetters: jest.fn(),
    close: jest.fn(() => Promise.resolve()),
  };
  queue.enqueue.mockResolvedValue({
    id: 'job-1',
    driver: 'memory',
    duplicate: false,
  });
  const service = new NotificationService(
    repository,
    connections as unknown as TenantConnectionService,
    queue,
  );
  return { service, repository, connection, connections, queue };
}

function jobFrom(
  queue: ReturnType<typeof makeService>['queue'],
): NotificationJob {
  return queue.enqueue.mock.calls[0][0];
}

describe('NotificationService', () => {
  describe('order ready', () => {
    it('uses push when the customer has a device token', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue(
        orderContext({ push_token: 'device-token-1' }),
      );

      const outcome = await service.notifyOrderReady(ORDER_EVENT);

      expect(outcome).toEqual({ queued: 1, skipped: null });
      const job = jobFrom(queue);
      expect(job).toMatchObject({
        tenantId: 'tenant-1',
        channel: 'push',
        recipient: 'device-token-1',
        source: 'order.ready',
        eventKey: `order-ready:${ORDER_EVENT.orderId}:push`,
      });
      expect(job.message.title).toBe('Your order is ready');
      expect(job.message.body).toContain(ORDER_EVENT.orderId.slice(0, 8));
      expect(job.message.body).toContain('ready for pickup');
      expect(job.message.data).toMatchObject({
        type: 'order.ready',
        orderId: ORDER_EVENT.orderId,
      });
      expect(job.context).toMatchObject({
        orderId: ORDER_EVENT.orderId,
        branchId: 'branch-1',
        customerId: 'customer-1',
      });
    });

    it('falls back to SMS when there is only a phone number', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue(orderContext());

      await service.notifyOrderReady(ORDER_EVENT);

      expect(jobFrom(queue)).toMatchObject({
        channel: 'sms',
        recipient: '9800000000',
        eventKey: `order-ready:${ORDER_EVENT.orderId}:sms`,
      });
    });

    it('says the team will serve a dine-in order at the table', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue({
        ...orderContext(),
        order_type: 'dine_in',
        table_id: 'table-1',
      });

      await service.notifyOrderReady(ORDER_EVENT);

      expect(jobFrom(queue).message.body).toContain('bring it to your table');
    });

    it('honours opt-out before choosing any channel', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue(
        orderContext({ notification_opt_out: true, push_token: 'token' }),
      );

      await expect(service.notifyOrderReady(ORDER_EVENT)).resolves.toEqual({
        queued: 0,
        skipped: 'opted_out',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('does nothing for an order without a customer', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue(orderContext(null));

      await expect(service.notifyOrderReady(ORDER_EVENT)).resolves.toEqual({
        queued: 0,
        skipped: 'no_customer',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue for a status other than ready', async () => {
      const { service, repository, connections, queue } = makeService();

      await expect(
        service.notifyOrderReady({ ...ORDER_EVENT, newStatus: 'preparing' }),
      ).resolves.toEqual({ queued: 0, skipped: 'not_ready' });
      expect(connections.acquireScoped).not.toHaveBeenCalled();
      expect(repository.findOrderContext).not.toHaveBeenCalled();
      expect(queue.enqueue).not.toHaveBeenCalled();
    });

    it('reports a customer with neither a push token nor a phone', async () => {
      const { service, repository, queue } = makeService();
      repository.findOrderContext.mockResolvedValue(
        orderContext({ phone: null, push_token: null }),
      );

      await expect(service.notifyOrderReady(ORDER_EVENT)).resolves.toEqual({
        queued: 0,
        skipped: 'no_recipient',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('inventory low stock', () => {
    const EVENT: InventoryLowStockEvent = {
      event: 'inventory.low_stock',
      inventoryItemId: 'item-1',
      tenantId: 'tenant-1',
      branchId: 'branch-1',
      name: 'Milk',
      unit: 'litre',
      quantityOnHand: 0,
      reorderThreshold: 5,
      severity: 'out_of_stock',
      triggeredByMovementId: 'movement-1',
      occurredAt: '2026-10-21T12:00:00.000Z',
    };

    it('emails every active branch manager with an item-specific message', async () => {
      const { service, repository, queue } = makeService();
      repository.listBranchManagers.mockResolvedValue([
        {
          id: 'manager-1',
          full_name: 'Maya',
          email: 'maya@cafe.test',
          branch_id: 'branch-1',
        },
        {
          id: 'manager-2',
          full_name: 'Rup',
          email: 'rup@cafe.test',
          branch_id: 'branch-1',
        },
      ]);

      await expect(service.notifyLowStock(EVENT)).resolves.toEqual({
        queued: 2,
        skipped: null,
      });

      expect(queue.enqueue).toHaveBeenCalledTimes(2);
      const jobs = queue.enqueue.mock.calls.map((call) => call[0]);
      expect(jobs.map((job) => job.recipient)).toEqual([
        'maya@cafe.test',
        'rup@cafe.test',
      ]);
      // Different managers must not share an event key, or the queue would
      // dedupe the second one away.
      expect(new Set(jobs.map((job) => job.eventKey)).size).toBe(2);
      expect(jobs[0].channel).toBe('email');
      expect(jobs[0].message.title).toBe('Out of stock: Milk');
      expect(jobs[0].message.body).toContain('0 litre on hand');
      expect(jobs[0].message.body).toContain('reorder at 5 litre');
      expect(jobs[0].source).toBe('inventory.low_stock');
    });

    it('says a branch has no manager instead of guessing an audience', async () => {
      const { service, repository, queue } = makeService();
      repository.listBranchManagers.mockResolvedValue([]);

      await expect(service.notifyLowStock(EVENT)).resolves.toEqual({
        queued: 0,
        skipped: 'no_manager',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('CRM events', () => {
    const PROMOTION: CrmPromotionEvent = {
      event: 'crm.promotion',
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      promotionId: 'promo-1',
      code: 'TENOFF',
      description: 'Ten percent off',
      occurredAt: '2026-10-21T12:00:00.000Z',
    };

    const BIRTHDAY: CrmBirthdayEvent = {
      event: 'crm.birthday',
      tenantId: 'tenant-1',
      customerId: 'customer-1',
      customerName: 'Asha',
      occurredAt: '2026-10-21T12:00:00.000Z',
    };

    it('uses the customer preference and composes the promotion copy', async () => {
      const { service, repository, queue } = makeService();
      repository.findCustomerContact.mockResolvedValue(
        customer({ notification_channel: 'email' }),
      );

      await expect(service.notifyCrmEvent(PROMOTION)).resolves.toEqual({
        queued: 1,
        skipped: null,
      });

      expect(jobFrom(queue)).toMatchObject({
        channel: 'email',
        recipient: 'asha@example.test',
        source: 'crm.promotion',
        eventKey: 'crm-promotion:promo-1:customer-1',
      });
      expect(jobFrom(queue).message.title).toBe('A promotion for you');
      expect(jobFrom(queue).message.body).toBe('TENOFF: Ten percent off');
    });

    it('falls back to an available contact when the preferred one is missing', async () => {
      const { service, repository, queue } = makeService();
      repository.findCustomerContact.mockResolvedValue(
        customer({
          notification_channel: 'push',
          push_token: null,
          phone: '9800000000',
        }),
      );

      await service.notifyCrmEvent(PROMOTION);

      expect(jobFrom(queue)).toMatchObject({
        channel: 'sms',
        recipient: '9800000000',
      });
    });

    it('uses push for a birthday when the customer has a device', async () => {
      const { service, repository, queue } = makeService();
      repository.findCustomerContact.mockResolvedValue(
        customer({ push_token: 'device-1' }),
      );

      await service.notifyCrmEvent(BIRTHDAY);

      const job = jobFrom(queue);
      expect(job.channel).toBe('push');
      expect(job.eventKey).toBe('crm-birthday:customer-1:2026');
      expect(job.message.title).toBe('Happy birthday, Asha Rai!');
    });

    it('does not send a promotion to an opted-out customer', async () => {
      const { service, repository, queue } = makeService();
      repository.findCustomerContact.mockResolvedValue(
        customer({ notification_opt_out: true, notification_channel: 'email' }),
      );

      await expect(service.notifyCrmEvent(PROMOTION)).resolves.toEqual({
        queued: 0,
        skipped: 'opted_out',
      });
      expect(queue.enqueue).not.toHaveBeenCalled();
    });
  });

  it('releases the connection after a read, even when the queue rejects', async () => {
    const { service, repository, connection, queue } = makeService();
    repository.findOrderContext.mockResolvedValue(orderContext());
    queue.enqueue.mockRejectedValue(new Error('redis down'));

    await expect(service.notifyOrderReady(ORDER_EVENT)).rejects.toThrow(
      'redis down',
    );
    expect(connection.rollback).toHaveBeenCalled();
    expect(connection.isReleased).toBe(true);
  });
});
