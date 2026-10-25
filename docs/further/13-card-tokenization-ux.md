# Agent Prompt: Card Tokenization UX (Card-on-File)

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. This extends the existing `PaymentModule` (customer checkout) to support saving cards for reuse. **Never store raw PAN/CVV.** Use provider vaults/tokenization only. Delegate all charging through `PaymentProviderFactory` and respect `PAYMENT_CONFIG_ENCRYPTION_KEY` for tenant provider configs.

Read relevant migrations: `db/migrations/009_payments.sql` and any existing `tenant_payment_configs` usage.

## Scope
PCI-safe card-on-file, saved payment methods, 3DS/setup intents, attach/detach/list, and reuse at checkout/recurring billing where applicable.

## Design Patterns
- **Strategy + Adapter**: extend existing `PaymentProvider` implementations to support setup/intents and payment methods without leaking provider SDK shapes.
- **Factory**: use `PaymentProviderFactory.getProvider(tenantId)` — never instantiate providers directly.
- **Idempotency**: setup/attach operations should be idempotent where the provider supports it.

## Task
1. **Schema**: Add `payment_methods` table (tenant-scoped, RLS) with fields like `id`, `tenant_id`, `customer_id` (or order context), `provider`, `provider_payment_method_id`, `brand`, `last4`, `exp_month`, `exp_year`, `is_default`, `status`, timestamps. Never store card numbers.
2. **Provider interface**: Extend `PaymentProvider` with `createSetupIntent(...)`, `attachPaymentMethod(...)`, `listPaymentMethods(...)`, `detachPaymentMethod(...)`, `chargeWithPaymentMethod(...)` (or equivalent). Keep result shapes normalized.
3. **Implementations**: 
   - Stripe: use SetupIntents + PaymentMethods
   - Razorpay: use saved cards/tokens per their API
   - eSewa/Khalti: implement per provider capabilities or clearly return `501 Not Implemented` with reason if unsupported
4. **API**: Add endpoints (tenant-scoped, authenticated) e.g. `POST /payments/setup-intent`, `GET /payments/methods`, `POST /payments/methods/attach`, `DELETE /payments/methods/:id`. Follow existing auth/roles.
5. **Checkout reuse**: Allow selecting a saved `payment_method_id` at checkout; fall back to QR flow if not provided.
6. **Security**: Enforce tenant isolation, validate ownership of payment methods, log no sensitive data, rate limit setup/attach.

## Acceptance Criteria
- [ ] No raw card data is persisted or logged
- [ ] `PaymentProviderFactory` used for all provider interactions
- [ ] SetupIntent flow works per provider with normalized responses
- [ ] Saved methods are tenant-isolated and deletable
- [ ] 3DS/setup failures surface as proper errors
- [ ] Tests cover attach/detach, default selection, tenant isolation
- [ ] `curl.md` updated with new endpoints and errors

## Notes
- Respect PCI SAQ scope; prefer provider-hosted fields (Elements/Checkout)
- This is UX+API work; cardholder data must never hit application logs
