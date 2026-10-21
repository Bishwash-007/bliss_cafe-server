import { Injectable, Logger } from '@nestjs/common';
import { InvalidOrderTransitionException, OrderService } from '../order';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import {
  OrderAlreadyPaidException,
  PaymentNotRefundableException,
  PaymentNotFoundException,
  PaymentReferenceConflictException,
} from './exceptions/payment.exceptions';
import { money } from './money';
import { PaymentRepository, isUniqueViolation } from './payment.repository';
import type {
  CheckoutResponse,
  PaymentRow,
  WebhookOutcome,
  WebhookResult,
} from './payment.types';
import type {
  PaymentProviderName,
  RefundResult,
} from './providers/payment-provider.types';
import { PaymentProviderFactory } from './providers/payment-provider.factory';

/** The status a checkout parks an order in while the customer pays. */
const AWAITING_PAYMENT = 'awaiting_payment';

export interface RefundResponse {
  refund: RefundResult;
  payment: PaymentRow;
}

/**
 * # PaymentService
 *
 * The use cases: start a checkout, settle a webhook, refund.
 *
 * ## What this class does NOT know
 *
 * Which gateways exist, what their payloads look like, or how their APIs are
 * shaped. It asks `PaymentProviderFactory` for a `PaymentProvider` and speaks
 * the shared interface. Provider selection by string happens exactly once, in
 * the factory.
 *
 * ## Idempotency
 *
 * Settlement is `UPDATE … WHERE status = 'pending'` in the repository. The
 * service turns "zero rows updated" into a duplicate response and, critically,
 * does not transition the order again — so the duplicate delivery that every
 * gateway sends does not publish a second `order.paid`. This is enforced by the
 * database, not by an in-memory set that a second app instance would not share.
 *
 * ## Who is allowed to pay?
 *
 * `checkout` transitions the order to `awaiting_payment`; the state machine
 * decides whether that is legal from its current status. A `placed` order that
 * has not been served cannot jump straight to payment — it goes through the
 * normal lifecycle. An already-`paid` order is refused up front, because
 * generating a second QR for it would invite a double charge.
 */
@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly repository: PaymentRepository,
    private readonly factory: PaymentProviderFactory,
    private readonly orders: OrderService,
  ) {}

  // ---------------------------------------------------------------- checkout

  async checkout(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
    actorId: string | null,
  ): Promise<CheckoutResponse> {
    const order = await this.orders.findById(connection, tenantId, orderId);

    if (order.status === 'paid') {
      throw new OrderAlreadyPaidException(orderId);
    }

    // The state machine owns the legality of this move; a status with no edge
    // to `awaiting_payment` raises its usual 400.
    if (order.status !== AWAITING_PAYMENT) {
      await this.orders.transition(
        connection,
        tenantId,
        orderId,
        AWAITING_PAYMENT,
      );
    }

    const amount = money(order.total_amount);
    const provider = await this.factory.getProvider(tenantId);
    const qr = await provider.generateQr(orderId, amount);

    let payment: PaymentRow;
    try {
      payment = await this.repository.createPending(connection, tenantId, {
        orderId,
        provider: qr.provider,
        providerReference: qr.providerReference,
        method: 'qr',
        amount: amount.toFixed(2),
        receivedBy: actorId,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new PaymentReferenceConflictException(
          qr.provider,
          qr.providerReference,
        );
      }
      throw error;
    }

    return {
      payment,
      qr: {
        provider: qr.provider,
        orderId: qr.orderId,
        amount: qr.amount,
        format: qr.format,
        data: qr.data,
        expiresAt: qr.expiresAt,
      },
    };
  }

  // ------------------------------------------------------------------ reads

  async listForOrder(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<PaymentRow[]> {
    // Reuse the order loader so a missing/foreign order is a 404 before the
    // (empty) payment list is returned.
    await this.orders.findById(connection, tenantId, orderId);
    return this.repository.listByOrder(connection, tenantId, orderId);
  }

  // ----------------------------------------------------------------- refund

  async refund(
    connection: TenantScopedConnection,
    tenantId: string,
    paymentId: string,
    _actorId: string | null,
  ): Promise<RefundResponse> {
    const payment = await this.repository.findPaymentById(
      connection,
      tenantId,
      paymentId,
    );
    if (!payment) {
      throw new PaymentNotFoundException(paymentId);
    }
    if (payment.status !== 'succeeded' || !payment.provider_reference) {
      throw new PaymentNotRefundableException(paymentId, payment.status);
    }

    const provider = await this.factory.getProviderByName(
      tenantId,
      payment.provider,
    );
    const refund = await provider.refund(payment.provider_reference);

    // `pending` and `failed` refunds leave the payment as `succeeded`: the
    // money has not demonstrably left the gateway yet, and marking it
    // `refunded` would make a retry look like a double refund.
    if (refund.status === 'succeeded') {
      const refunded = await this.repository.markRefunded(
        connection,
        tenantId,
        paymentId,
      );
      if (refunded) {
        return { refund, payment: refunded };
      }
      // Lost a race with another refund request. Re-read the authoritative row.
      const current = await this.repository.findPaymentById(
        connection,
        tenantId,
        paymentId,
      );
      return { refund, payment: current ?? payment };
    }

    return { refund, payment };
  }

  // --------------------------------------------------------------- webhooks

  async settleWebhook(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: PaymentProviderName,
    outcome: WebhookOutcome,
  ): Promise<WebhookResult> {
    if (outcome.kind === 'ignored') {
      return {
        received: true,
        duplicate: false,
        ignored: true,
        payment: null,
      };
    }

    if (outcome.kind === 'failed') {
      return this.markFailed(connection, tenantId, provider, outcome);
    }

    const updated = await this.repository.markSucceeded(
      connection,
      tenantId,
      provider,
      outcome.providerReference,
    );

    if (!updated) {
      // Either a retry of a delivery we already processed, or a reference we
      // have never seen. Distinguishing them matters: the first is a 200 the
      // gateway should stop retrying, the second is a 404 (wrong tenant/URL).
      const current = await this.repository.findPaymentByReference(
        connection,
        tenantId,
        provider,
        outcome.providerReference,
      );
      if (!current) {
        throw new PaymentNotFoundException(outcome.providerReference);
      }
      return {
        received: true,
        duplicate: true,
        ignored: false,
        payment: current,
      };
    }

    // The order transition publishes `order.paid` through OrderModule's bus
    // once THIS request commits, so subscribers still see the payment row.
    try {
      await this.orders.transition(
        connection,
        tenantId,
        updated.order_id,
        'paid',
      );
    } catch (error) {
      if (error instanceof InvalidOrderTransitionException) {
        // The money arrived but the order was already paid (a cash payment
        // recorded by a manager, say) or was cancelled. Keeping the payment
        // `succeeded` is the truthful record; rewriting the order here would
        // undo a legitimate lifecycle decision. A cancellation needs a refund,
        // not a silent resurrection.
        this.logger.warn(
          `Payment ${updated.id} succeeded but order ${updated.order_id} ` +
            `could not move to paid: ${error.message}`,
        );
      } else {
        // Anything else rolls the whole request back, including the payment
        // status, so the gateway's retry can settle it again.
        throw error;
      }
    }

    return {
      received: true,
      duplicate: false,
      ignored: false,
      payment: updated,
    };
  }

  private async markFailed(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: PaymentProviderName,
    outcome: Extract<WebhookOutcome, { kind: 'failed' }>,
  ): Promise<WebhookResult> {
    const updated = await this.repository.markFailed(
      connection,
      tenantId,
      provider,
      outcome.providerReference,
    );

    if (!updated) {
      const current = await this.repository.findPaymentByReference(
        connection,
        tenantId,
        provider,
        outcome.providerReference,
      );
      if (!current) {
        throw new PaymentNotFoundException(outcome.providerReference);
      }
      return {
        received: true,
        duplicate: true,
        ignored: false,
        payment: current,
      };
    }

    return {
      received: true,
      duplicate: false,
      ignored: false,
      payment: updated,
    };
  }
}
