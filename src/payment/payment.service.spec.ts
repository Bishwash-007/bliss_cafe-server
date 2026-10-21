import { InvalidOrderTransitionException, type OrderService } from '../order';
import type { OrderRow } from '../order/order.repository';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import {
  OrderAlreadyPaidException,
  PaymentNotRefundableException,
  PaymentNotFoundException,
} from './exceptions/payment.exceptions';
import type { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import type { PaymentRow } from './payment.types';
import type { QrPayload } from './providers/payment-provider.types';
import type { PaymentProviderFactory } from './providers/payment-provider.factory';

const connection = {} as TenantScopedConnection;
const TENANT = 'tenant-1';
const ORDER_ID = 'order-1';

function orderRow(overrides: Partial<OrderRow> = {}): OrderRow {
  return {
    id: ORDER_ID,
    tenant_id: TENANT,
    branch_id: 'branch-1',
    table_id: null,
    customer_id: null,
    created_by: null,
    order_type: 'dine_in',
    status: 'served',
    subtotal: 250.5,
    tax_amount: 0,
    discount_amount: 0,
    total_amount: 250.5,
    client_action_id: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function paymentRow(overrides: Partial<PaymentRow> = {}): PaymentRow {
  return {
    id: 'payment-1',
    tenant_id: TENANT,
    order_id: ORDER_ID,
    provider: 'stripe',
    provider_reference: 'pi_1',
    method: 'qr',
    amount: '250.50',
    status: 'pending',
    received_by: null,
    created_at: new Date(),
    updated_at: new Date(),
    paid_at: null,
    ...overrides,
  };
}

const QR: QrPayload = {
  provider: 'stripe',
  orderId: ORDER_ID,
  amount: 250.5,
  format: 'url',
  data: 'https://pay.test/cs_1',
  providerReference: 'pi_1',
  expiresAt: null,
};

describe('PaymentService', () => {
  let repository: {
    createPending: jest.Mock;
    listByOrder: jest.Mock;
    findPaymentById: jest.Mock;
    findPaymentByReference: jest.Mock;
    markSucceeded: jest.Mock;
    markFailed: jest.Mock;
    markRefunded: jest.Mock;
  };
  let factory: { getProvider: jest.Mock; getProviderByName: jest.Mock };
  let orders: { findById: jest.Mock; transition: jest.Mock };
  let provider: {
    name: 'stripe';
    charge: jest.Mock;
    refund: jest.Mock;
    generateQr: jest.Mock;
    verifyWebhookSignature: jest.Mock;
  };
  let service: PaymentService;

  beforeEach(() => {
    repository = {
      createPending: jest.fn().mockResolvedValue(paymentRow()),
      listByOrder: jest.fn().mockResolvedValue([]),
      findPaymentById: jest.fn(),
      findPaymentByReference: jest.fn(),
      markSucceeded: jest.fn(),
      markFailed: jest.fn(),
      markRefunded: jest.fn(),
    };
    provider = {
      name: 'stripe',
      charge: jest.fn(),
      refund: jest.fn().mockResolvedValue({
        provider: 'stripe',
        providerReference: 'pi_1',
        refundReference: 're_1',
        status: 'succeeded',
        amount: 250.5,
      }),
      generateQr: jest.fn().mockResolvedValue(QR),
      verifyWebhookSignature: jest.fn(),
    };
    factory = {
      getProvider: jest.fn().mockResolvedValue(provider),
      getProviderByName: jest.fn().mockResolvedValue(provider),
    };
    orders = {
      findById: jest.fn().mockResolvedValue(orderRow()),
      transition: jest.fn().mockResolvedValue(orderRow({ status: 'paid' })),
    };

    service = new PaymentService(
      repository as unknown as PaymentRepository,
      factory as unknown as PaymentProviderFactory,
      orders as unknown as OrderService,
    );
  });

  describe('checkout', () => {
    it('parks the order at awaiting_payment and stores the pending payment', async () => {
      const result = await service.checkout(
        connection,
        TENANT,
        ORDER_ID,
        'user-1',
      );

      expect(orders.transition).toHaveBeenCalledWith(
        connection,
        TENANT,
        ORDER_ID,
        'awaiting_payment',
      );
      expect(provider.generateQr).toHaveBeenCalledWith(ORDER_ID, 250.5);
      expect(repository.createPending).toHaveBeenCalledWith(
        connection,
        TENANT,
        {
          orderId: ORDER_ID,
          provider: 'stripe',
          providerReference: 'pi_1',
          method: 'qr',
          amount: '250.50',
          receivedBy: 'user-1',
        },
      );
      expect(result.qr).toEqual({
        provider: 'stripe',
        orderId: ORDER_ID,
        amount: 250.5,
        format: 'url',
        data: 'https://pay.test/cs_1',
        expiresAt: null,
      });
    });

    it('does not re-transition an order already awaiting payment', async () => {
      orders.findById.mockResolvedValue(
        orderRow({ status: 'awaiting_payment' }),
      );

      await service.checkout(connection, TENANT, ORDER_ID, null);

      expect(orders.transition).not.toHaveBeenCalled();
    });

    it('refuses a second checkout for a paid order', async () => {
      orders.findById.mockResolvedValue(orderRow({ status: 'paid' }));

      await expect(
        service.checkout(connection, TENANT, ORDER_ID, null),
      ).rejects.toBeInstanceOf(OrderAlreadyPaidException);
      expect(provider.generateQr).not.toHaveBeenCalled();
    });
  });

  describe('settleWebhook', () => {
    it('settles the payment and moves the order to paid on the first delivery', async () => {
      repository.markSucceeded.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );

      const result = await service.settleWebhook(connection, TENANT, 'stripe', {
        kind: 'succeeded',
        providerReference: 'pi_1',
      });

      expect(result.duplicate).toBe(false);
      expect(orders.transition).toHaveBeenCalledWith(
        connection,
        TENANT,
        ORDER_ID,
        'paid',
      );
    });

    it('treats a redelivery as a duplicate and does not transition twice', async () => {
      repository.markSucceeded.mockResolvedValue(null);
      repository.findPaymentByReference.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );

      const result = await service.settleWebhook(connection, TENANT, 'stripe', {
        kind: 'succeeded',
        providerReference: 'pi_1',
      });

      expect(result.duplicate).toBe(true);
      expect(orders.transition).not.toHaveBeenCalled();
    });

    it('404s a webhook for a reference this tenant never created', async () => {
      repository.markSucceeded.mockResolvedValue(null);
      repository.findPaymentByReference.mockResolvedValue(null);

      await expect(
        service.settleWebhook(connection, TENANT, 'stripe', {
          kind: 'succeeded',
          providerReference: 'pi_unknown',
        }),
      ).rejects.toBeInstanceOf(PaymentNotFoundException);
    });

    it('records a failure without moving the order', async () => {
      repository.markFailed.mockResolvedValue(paymentRow({ status: 'failed' }));

      const result = await service.settleWebhook(connection, TENANT, 'stripe', {
        kind: 'failed',
        providerReference: 'pi_1',
      });

      expect(result.payment?.status).toBe('failed');
      expect(orders.transition).not.toHaveBeenCalled();
    });

    it('acknowledges ignored events without touching the database', async () => {
      const result = await service.settleWebhook(connection, TENANT, 'stripe', {
        kind: 'ignored',
        reason: 'payment_intent.created',
      });

      expect(result.ignored).toBe(true);
      expect(repository.markSucceeded).not.toHaveBeenCalled();
      expect(repository.markFailed).not.toHaveBeenCalled();
    });

    it('keeps the payment succeeded when the order cannot move to paid', async () => {
      repository.markSucceeded.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );
      orders.transition.mockRejectedValue(
        new InvalidOrderTransitionException(ORDER_ID, 'paid', 'paid', []),
      );

      const result = await service.settleWebhook(connection, TENANT, 'stripe', {
        kind: 'succeeded',
        providerReference: 'pi_1',
      });

      expect(result.payment?.status).toBe('succeeded');
    });

    it('propagates unexpected transition errors so the request rolls back', async () => {
      repository.markSucceeded.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );
      orders.transition.mockRejectedValue(new Error('database down'));

      await expect(
        service.settleWebhook(connection, TENANT, 'stripe', {
          kind: 'succeeded',
          providerReference: 'pi_1',
        }),
      ).rejects.toThrow('database down');
    });
  });

  describe('refund', () => {
    it('refunds a succeeded payment and marks it refunded', async () => {
      repository.findPaymentById.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );
      repository.markRefunded.mockResolvedValue(
        paymentRow({ status: 'refunded' }),
      );

      const result = await service.refund(
        connection,
        TENANT,
        'payment-1',
        'manager-1',
      );

      expect(provider.refund).toHaveBeenCalledWith('pi_1');
      expect(result.payment.status).toBe('refunded');
    });

    it('refuses to refund a pending payment', async () => {
      repository.findPaymentById.mockResolvedValue(paymentRow());

      await expect(
        service.refund(connection, TENANT, 'payment-1', null),
      ).rejects.toBeInstanceOf(PaymentNotRefundableException);
      expect(provider.refund).not.toHaveBeenCalled();
    });

    it('404s an unknown payment', async () => {
      repository.findPaymentById.mockResolvedValue(null);

      await expect(
        service.refund(connection, TENANT, 'missing', null),
      ).rejects.toBeInstanceOf(PaymentNotFoundException);
    });

    it('does not mark a payment refunded while the gateway says pending', async () => {
      repository.findPaymentById.mockResolvedValue(
        paymentRow({ status: 'succeeded' }),
      );
      provider.refund.mockResolvedValue({
        provider: 'stripe',
        providerReference: 'pi_1',
        refundReference: 're_1',
        status: 'pending',
        amount: null,
      });

      const result = await service.refund(
        connection,
        TENANT,
        'payment-1',
        null,
      );

      expect(result.payment.status).toBe('succeeded');
      expect(repository.markRefunded).not.toHaveBeenCalled();
    });
  });
});
