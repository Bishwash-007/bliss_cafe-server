import { ORDER_EVENTS, type OrderPaidEvent } from '../../order';
import type { CrmService } from '../crm.service';
import { OrderPaidLoyaltyListener } from './order-paid.listener';

const EVENT: OrderPaidEvent = {
  event: ORDER_EVENTS.paid,
  orderId: 'order-1',
  tenantId: 'tenant-1',
  branchId: 'branch-1',
  previousStatus: 'awaiting_payment',
  tableId: null,
  totalAmount: 250.5,
  occurredAt: '2026-10-21T12:00:00.000Z',
};

function makeListener() {
  const crm = { awardForPaidOrder: jest.fn() };
  const listener = new OrderPaidLoyaltyListener(crm as unknown as CrmService);
  return { listener, crm };
}

describe('OrderPaidLoyaltyListener', () => {
  it('credits the order named by the event', async () => {
    const { listener, crm } = makeListener();
    crm.awardForPaidOrder.mockResolvedValue({
      credited: true,
      points: 2,
      account: null,
      orderId: 'order-1',
      customerId: 'customer-1',
    });

    const outcome = await listener.handleOrderPaid(EVENT);

    expect(crm.awardForPaidOrder).toHaveBeenCalledWith('tenant-1', 'order-1');
    expect(outcome).toMatchObject({ credited: true, points: 2 });
  });

  it('does not throw when the credit fails', async () => {
    // The order has already committed; a loyalty error must not escape into
    // the publisher and couple a bookkeeping problem to a completed sale.
    const { listener, crm } = makeListener();
    crm.awardForPaidOrder.mockRejectedValue(new Error('database down'));

    await expect(listener.handleOrderPaid(EVENT)).resolves.toBeNull();
  });

  it('returns the duplicate outcome without treating it as an error', async () => {
    const { listener, crm } = makeListener();
    crm.awardForPaidOrder.mockResolvedValue({
      credited: false,
      points: 0,
      account: null,
      orderId: 'order-1',
      reason: 'duplicate',
      customerId: 'customer-1',
    });

    await expect(listener.handleOrderPaid(EVENT)).resolves.toMatchObject({
      credited: false,
      reason: 'duplicate',
    });
  });
});
