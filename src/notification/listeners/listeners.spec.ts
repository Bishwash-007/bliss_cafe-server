import type { CrmBirthdayEvent, CrmPromotionEvent } from '../../crm';
import type { InventoryLowStockEvent } from '../../inventory';
import type { OrderStatusChangedEvent } from '../../order';
import { CrmCustomerNotificationListener } from './crm-customer.listener';
import { InventoryLowStockNotificationListener } from './inventory-low-stock.listener';
import { OrderReadyNotificationListener } from './order-ready.listener';

function service() {
  return {
    notifyOrderReady: jest.fn().mockResolvedValue({ queued: 1, skipped: null }),
    notifyLowStock: jest.fn().mockResolvedValue({ queued: 1, skipped: null }),
    notifyCrmEvent: jest.fn().mockResolvedValue({ queued: 1, skipped: null }),
  };
}

const ORDER_EVENT: OrderStatusChangedEvent = {
  event: 'order.status_changed',
  orderId: 'order-1',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  previousStatus: 'preparing',
  newStatus: 'ready',
  tableId: null,
  orderType: 'takeaway',
  totalAmount: 100,
  occurredAt: '2026-10-21T12:00:00.000Z',
};

describe('OrderReadyNotificationListener', () => {
  it('maps order.status_changed(ready) to the service', async () => {
    const notifications = service();
    const listener = new OrderReadyNotificationListener(notifications as never);

    await listener.onOrderStatusChanged(ORDER_EVENT);

    expect(notifications.notifyOrderReady).toHaveBeenCalledWith(ORDER_EVENT);
  });

  it('ignores every other status', async () => {
    const notifications = service();
    const listener = new OrderReadyNotificationListener(notifications as never);

    await listener.onOrderStatusChanged({
      ...ORDER_EVENT,
      newStatus: 'served',
    });

    expect(notifications.notifyOrderReady).not.toHaveBeenCalled();
  });

  it('does not throw when queueing fails after the order committed', async () => {
    const notifications = service();
    notifications.notifyOrderReady.mockRejectedValue(new Error('queue down'));
    const listener = new OrderReadyNotificationListener(notifications as never);

    await expect(
      listener.onOrderStatusChanged(ORDER_EVENT),
    ).resolves.toBeUndefined();
  });
});

describe('InventoryLowStockNotificationListener', () => {
  const EVENT: InventoryLowStockEvent = {
    event: 'inventory.low_stock',
    inventoryItemId: 'item-1',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    name: 'Milk',
    unit: 'litre',
    quantityOnHand: 1,
    reorderThreshold: 5,
    severity: 'reorder',
    triggeredByMovementId: 'movement-1',
    occurredAt: '2026-10-21T12:00:00.000Z',
  };

  it('maps inventory.low_stock to the service', async () => {
    const notifications = service();
    const listener = new InventoryLowStockNotificationListener(
      notifications as never,
    );

    await listener.onLowStock(EVENT);

    expect(notifications.notifyLowStock).toHaveBeenCalledWith(EVENT);
  });

  it('does not throw when alerting fails', async () => {
    const notifications = service();
    notifications.notifyLowStock.mockRejectedValue(new Error('smtp down'));
    const listener = new InventoryLowStockNotificationListener(
      notifications as never,
    );

    await expect(listener.onLowStock(EVENT)).resolves.toBeUndefined();
  });
});

describe('CrmCustomerNotificationListener', () => {
  const PROMOTION: CrmPromotionEvent = {
    event: 'crm.promotion',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    promotionId: 'promo-1',
    code: 'TENOFF',
    description: null,
    occurredAt: '2026-10-21T12:00:00.000Z',
  };

  const BIRTHDAY: CrmBirthdayEvent = {
    event: 'crm.birthday',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    customerName: 'Asha',
    occurredAt: '2026-10-21T12:00:00.000Z',
  };

  it('maps a promotion event to the service', async () => {
    const notifications = service();
    const listener = new CrmCustomerNotificationListener(
      notifications as never,
    );

    await listener.onPromotion(PROMOTION);

    expect(notifications.notifyCrmEvent).toHaveBeenCalledWith(PROMOTION);
  });

  it('maps a birthday event to the service', async () => {
    const notifications = service();
    const listener = new CrmCustomerNotificationListener(
      notifications as never,
    );

    await listener.onBirthday(BIRTHDAY);

    expect(notifications.notifyCrmEvent).toHaveBeenCalledWith(BIRTHDAY);
  });

  it('logs and swallows a failure', async () => {
    const notifications = service();
    notifications.notifyCrmEvent.mockRejectedValue(new Error('provider down'));
    const listener = new CrmCustomerNotificationListener(
      notifications as never,
    );

    await expect(listener.onBirthday(BIRTHDAY)).resolves.toBeUndefined();
  });
});
