import { Module } from '@nestjs/common';
import { OrderModule } from '../order/order.module';
import { CheckoutController } from './checkout.controller';
import { PaymentConfigCipher } from './config/payment-config.cipher';
import { PaymentConfigController } from './config/payment-config.controller';
import { PaymentConfigService } from './config/payment-config.service';
import { PaymentController } from './payment.controller';
import { PaymentRepository } from './payment.repository';
import { PaymentService } from './payment.service';
import { FetchPaymentHttpClient, PAYMENT_HTTP } from './providers/payment-http';
import { PaymentProviderFactory } from './providers/payment-provider.factory';
import { EsewaWebhookController } from './webhooks/esewa-webhook.controller';
import { RazorpayWebhookController } from './webhooks/razorpay-webhook.controller';
import { StripeWebhookController } from './webhooks/stripe-webhook.controller';
import { WebhookService } from './webhooks/webhook.service';

/**
 * # PaymentModule
 *
 * Multi-gateway payments: Strategy/Adapter per provider, a factory that picks
 * the tenant's active gateway, dynamic QR checkout, signed webhooks and
 * refunds.
 *
 * ## Why it imports `OrderModule`
 *
 * Payment moves an order to `awaiting_payment` and, on settlement, to `paid`
 * through `OrderService.transition`. That is deliberate: the transition is what
 * publishes `order.paid`, so going around it would record money without telling
 * CRM (loyalty) or anyone else. The dependency points payment → order, never
 * the reverse; checkout is a separate route rather than logic inside
 * `OrderService`, so there is no cycle.
 *
 * ## The HTTP seam
 *
 * `PAYMENT_HTTP` is the single outbound network dependency. Production binds
 * `FetchPaymentHttpClient`; tests override it with a scripted transport, which
 * is why the shared provider-contract suite can run three real adapters without
 * calling a gateway.
 */
@Module({
  imports: [OrderModule],
  controllers: [
    CheckoutController,
    PaymentController,
    PaymentConfigController,
    StripeWebhookController,
    EsewaWebhookController,
    RazorpayWebhookController,
  ],
  providers: [
    PaymentRepository,
    PaymentConfigCipher,
    PaymentConfigService,
    PaymentProviderFactory,
    PaymentService,
    WebhookService,
    { provide: PAYMENT_HTTP, useClass: FetchPaymentHttpClient },
  ],
})
export class PaymentModule {}
