# Agent Prompt: PaymentModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/009_payments.sql` before writing code. This is the module the cafe uses to charge *its own customers* (dine-in/takeaway checkout) — distinct from any future SaaS billing module that would charge the tenant itself.

## Scope
Multi-gateway payment processing (Stripe, eSewa, Razorpay), dynamic QR checkout, webhook handling, refunds.

## Design Patterns

This module genuinely needs three patterns working together, not one:

**Strategy** — one interface shape (`charge`, `refund`, `generateQr`), multiple gateway implementations, swappable at runtime per tenant.

**Factory** — `PaymentProviderFactory.getProvider(tenantId)` reads the tenant's configured provider and instantiates the right concrete strategy. Callers never do `new StripeProvider()` directly — they ask the factory.

**Adapter** — Stripe's SDK, eSewa's REST quirks, and Razorpay's API are all shaped differently. Each concrete provider class is simultaneously the Strategy implementation AND an Adapter normalizing that gateway's real API to your common interface.

## Task

1. Define a `PaymentProvider` interface: `charge(amount, orderId): Promise<PaymentResult>`, `refund(paymentId): Promise<RefundResult>`, `generateQr(orderId, amount): Promise<QrPayload>`, `verifyWebhookSignature(payload, headers): boolean`.
2. Implement `StripeProvider`, `EsewaProvider`, `RazorpayProvider` against that interface:
   - Stripe: `generateQr` creates a Payment Intent and encodes its hosted checkout URL as a QR.
   - eSewa/Khalti: use their native QR generation API directly.
   - Each provider adapts its own SDK's actual response shape into your common `PaymentResult`/`RefundResult` types — don't leak gateway-specific fields into the interface.
3. Build `PaymentProviderFactory.getProvider(tenantId)`: reads `tenant_payment_configs`, decrypts `config_encrypted`, returns the matching concrete provider instance. This is the only place that should know which providers exist.
4. Webhook controllers per provider (`POST /webhooks/stripe`, `POST /webhooks/esewa`, `POST /webhooks/razorpay`): verify signature via the adapter's `verifyWebhookSignature`, then update the matching `payments` row's `status`, and publish `order.paid` on success — **reuse `OrderModule`'s existing event bus**, do not create a parallel one.
5. Checkout flow: `POST /orders/:id/checkout` resolves the provider via the factory, calls `generateQr`, creates a `payments` row with `status = 'pending'`, and returns the QR payload to the Receptionist's client.
6. Idempotency: a webhook retry for an already-processed payment should not double-fire `order.paid` or double-update status.

## Acceptance Criteria (write tests for these)
- `PaymentProviderFactory` returns the correct concrete provider for a given tenant's config.
- A single shared test suite runs against all three providers, asserting each conforms to the `PaymentProvider` interface contract (same method signatures, same result shapes) even though internals differ.
- An invalid webhook signature is rejected before any state changes.
- A duplicate webhook delivery for an already-`succeeded` payment is a no-op, not a double-charge-confirmation.
- Checkout correctly creates a `pending` payment row and returns a QR payload shaped consistently regardless of which provider is active.
