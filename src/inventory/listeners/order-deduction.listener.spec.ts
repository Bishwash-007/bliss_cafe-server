import type { OrderStatusChangedEvent } from '../../order';
import type { DeductionOutcome, InventoryService } from '../inventory.service';
import { OrderDeductionListener } from './order-deduction.listener';

const TENANT = 'tenant-1';
const ORDER = 'order-1';

function statusEvent(
  newStatus: string,
  overrides: Partial<OrderStatusChangedEvent> = {},
): OrderStatusChangedEvent {
  return {
    event: 'order.status_changed',
    tenantId: TENANT,
    orderId: ORDER,
    branchId: 'branch-1',
    previousStatus: 'paid',
    newStatus,
    occurredAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as OrderStatusChangedEvent;
}

function listener(deduct: jest.Mock) {
  const inventory = { deductForOrder: deduct } as unknown as InventoryService;
  return { listener: new OrderDeductionListener(inventory), deduct };
}

const settled: DeductionOutcome = {
  status: 'completed',
  deduplicated: false,
  menuItemsWithoutRecipe: [],
};

describe('OrderDeductionListener', () => {
  it('deducts stock when an order completes', async () => {
    const { listener: subject, deduct } = listener(
      jest.fn().mockResolvedValue(settled),
    );

    const outcome = await subject.handleOrderStatusChanged(
      statusEvent('completed'),
    );

    expect(deduct).toHaveBeenCalledWith(TENANT, ORDER);
    expect(outcome).toEqual(settled);
  });

  it('ignores every status that is not the final one', async () => {
    // `ready` is the trap: a dish can be served and then sent back, and a table
    // can be paid without every line being made. Only `completed` means the stock
    // is definitely gone.
    const { listener: subject, deduct } = listener(jest.fn());

    for (const status of [
      'placed',
      'confirmed',
      'preparing',
      'ready',
      'served',
      'awaiting_payment',
      'paid',
      'cancelled',
    ]) {
      const outcome = await subject.handleOrderStatusChanged(
        statusEvent(status),
      );
      expect(outcome).toBeNull();
    }
    expect(deduct).not.toHaveBeenCalled();
  });

  it('passes the TENANT FROM THE EVENT, not from a request', async () => {
    // A subscriber runs after the order's request is over, so there is no request
    // context left to read a tenant from. The signed event payload is the only
    // trustworthy source.
    const { listener: subject, deduct } = listener(
      jest.fn().mockResolvedValue(settled),
    );

    await subject.handleOrderStatusChanged(
      statusEvent('completed', { tenantId: 'tenant-other' }),
    );

    expect(deduct).toHaveBeenCalledWith('tenant-other', ORDER);
  });

  it('swallows an error so a stock problem cannot fail the checkout', async () => {
    // `deductForOrder` is written not to throw; this guards the case where even
    // its failure path is buggy. A thrown error here would propagate out of the
    // synchronous emit inside `onCommit` and out of the request that completed
    // the order — the order would look failed when it is durably completed.
    const { listener: subject } = listener(
      jest.fn().mockRejectedValue(new Error('ledger unreachable')),
    );

    await expect(
      subject.handleOrderStatusChanged(statusEvent('completed')),
    ).resolves.toBeNull();
  });

  it('reports a partial deduction so a misconfigured recipe is not silent', async () => {
    const { listener: subject } = listener(
      jest.fn().mockResolvedValue({
        status: 'partial',
        deduplicated: false,
        menuItemsWithoutRecipe: ['menu-9'],
      } satisfies DeductionOutcome),
    );

    const outcome = await subject.handleOrderStatusChanged(
      statusEvent('completed'),
    );

    expect(outcome?.status).toBe('partial');
  });

  it('treats a redelivery as a no-op rather than a second deduction', async () => {
    const { listener: subject, deduct } = listener(
      jest.fn().mockResolvedValue({
        ...settled,
        deduplicated: true,
      } satisfies DeductionOutcome),
    );

    const outcome = await subject.handleOrderStatusChanged(
      statusEvent('completed'),
    );

    expect(deduct).toHaveBeenCalledTimes(1);
    expect(outcome?.deduplicated).toBe(true);
  });
});
