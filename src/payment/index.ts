/**
 * # PaymentModule — public surface
 *
 * What other features are allowed to import. Gateway adapters, the repository
 * and the config cipher stay internal: a caller that reached for
 * `StripeProvider` could bypass the factory's "exactly one active provider"
 * rule, and one that touched `tenant_payment_configs` directly could store
 * plaintext secrets.
 *
 * ## HTTP surface
 *
 * ```
 * POST   /orders/:id/checkout     start payment; returns { payment, qr }
 * GET    /payments/order/:id      payment attempts for an order, newest first
 * POST   /payments/:id/refund     full refund (manager+)
 * GET    /payments/config         configured providers (no secrets)
 * PUT    /payments/config/:name   store/activate a provider config (owner)
 * POST   /webhooks/stripe         signed, public
 * POST   /webhooks/esewa          signed, public
 * POST   /webhooks/razorpay       signed, public
 * ```
 *
 * ## How a checkout settles
 *
 * 1. `POST /orders/:id/checkout` moves the order to `awaiting_payment`, asks
 *    the factory for the tenant's one active gateway, and stores a `pending`
 *    `payments` row keyed by the gateway reference.
 * 2. The customer pays the QR out-of-band.
 * 3. The gateway posts a signed webhook. The adapter verifies the signature
 *    over the RAW body, the controller normalizes the event to
 *    `succeeded|failed|ignored`, and `PaymentService` does a conditional
 *    `UPDATE … WHERE status = 'pending'`.
 * 4. Only the delivery that wins that UPDATE calls
 *    `OrderService.transition(…, 'paid')`, which publishes `order.paid` after
 *    the request commits. A redelivery updates zero rows and publishes nothing.
 *
 * ## Multi-tenant webhook URLs
 *
 * Gateway dashboards are configured per tenant with the tenant's host —
 * `https://<tenant-host>/webhooks/<provider>` (or an `X-Tenant-Id` header if
 * the gateway supports custom headers). The route itself is not
 * tenant-agnostic; tenancy comes from the same resolver chain as every other
 * request. The signature is what authenticates the caller, and it is only
 * looked up after the tenant is known.
 *
 * ## Deliberate gaps
 *
 * - **No partial refunds.** `PaymentProvider.refund` is full-refund only, and
 *   the HTTP endpoint exposes exactly that. Partial refunds need a refund
 *   ledger (one payment can be refunded many times up to its amount) rather
 *   than mutating a single status.
 * - **No cash / card-present settlement path.** The schema's `method` column
 *   and `received_by` exist for it, but nothing records a cash payment yet;
 *   `checkout` always uses the gateway's QR.
 * - **No refund-triggered order reversal.** Refunding money does not reopen or
 *   cancel an order. That is a lifecycle decision for `OrderModule`.
 * - **No provider failover.** Exactly one provider may be active; if it is
 *   down, checkout fails rather than silently charging through another gateway
 *   with different fees and reconciliation.
 * - **No webhook event table.** Ignored events are acknowledged but not stored;
 *   if reconciliation needs an audit trail of every delivery, that is a new
 *   table, not a change to this module's contract.
 * - **`charge` is contract-complete but not used by checkout.** It exists so
 *   the adapter interface is honest for a future card-present flow; Stripe
 *   requires a configured `paymentMethod` to use it, Razorpay returns a gateway
 *   order (its capture model), and eSewa calls its charge product.
 * - **No currency conversion.** Each gateway is configured with its own
 *   currency code (Stripe defaults to `usd`, eSewa `NPR`, Razorpay `INR`); the
 *   order has one amount and is not converted.
 */

export { PaymentModule } from './payment.module';
export { PaymentService } from './payment.service';
export type { RefundResponse } from './payment.service';
export { PaymentConfigService } from './config/payment-config.service';
export { PaymentProviderFactory } from './providers/payment-provider.factory';
export { PAYMENT_HTTP } from './providers/payment-http';
export type {
  PaymentHttpClient,
  PaymentHttpRequest,
  PaymentHttpResponse,
} from './providers/payment-http';
export {
  PAYMENT_PROVIDERS,
  isPaymentProviderName,
} from './providers/payment-provider.types';
export type {
  PaymentOutcome,
  PaymentProvider,
  PaymentProviderName,
  PaymentResult,
  ProviderConfig,
  QrPayload,
  RefundResult,
} from './providers/payment-provider.types';
export type {
  CheckoutResponse,
  PaymentConfigRow,
  PaymentRow,
  WebhookOutcome,
  WebhookResult,
} from './payment.types';
export {
  AmbiguousPaymentProviderException,
  InvalidPaymentAmountException,
  InvalidWebhookPayloadException,
  InvalidWebhookSignatureException,
  OrderAlreadyPaidException,
  PaymentConfigDecryptionException,
  PaymentConfigKeyException,
  PaymentConfigurationException,
  PaymentNotFoundException,
  PaymentNotRefundableException,
  PaymentProviderNotConfiguredException,
  PaymentProviderNotConfiguredForException,
  PaymentProviderRequestException,
  PaymentReferenceConflictException,
  UnsupportedPaymentProviderException,
} from './exceptions/payment.exceptions';
