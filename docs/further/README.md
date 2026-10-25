# Agent Prompts — Remaining Work (Further)

These prompts cover product/provider gaps that cannot be completed in-session. Follow the same patterns as `docs/modules/` (read migrations first, reuse existing abstractions, keep `curl.md` in sync). Do **not** commit unless explicitly asked.

## Build/order (recommended)

1. `18-broad-pagination.md` — standardize pagination early to avoid breaking changes later
2. `19-branch-scope-extension.md` — extend `assertBranchAccess`/`assertOrgWide` to inventory, staff, CRM, reporting
3. `13-card-tokenization-ux.md` — card-on-file via provider vaults (depends on `PaymentProviderFactory`)
4. `14-invoice-ledger-ux.md` — invoices/ledger tied to Billing (depends on subscription state)
5. `17-notification-adapters.md` — concrete adapters on top of existing BullMQ queue + DLQ
6. `16-otp.md` — OTP/MFA provider abstraction
7. `15-staff-management-api.md` — HR APIs (invites, leave, permissions, payroll) extending shifts/clock-in

## Cross-cutting rules

- **Reuse abstractions**: `PaymentProviderFactory` (never duplicate Stripe/eSewa/Razorpay clients), Order event bus (`EventEmitter2`), `SubscriptionAccessGuard`/`assertBranchAccess`, tenant-scoped connections, RLS.
- **Security**: no raw PAN/CVV in logs or DB; tokenization only; encrypt provider secrets with `PAYMENT_CONFIG_ENCRYPTION_KEY`; webhook signature verification; hashed OTPs; enumeration-safe errors; rate limiting.
- **Validation**: use `class-validator` DTOs via global `ValidationPipe` (APP_PIPE); preserve existing service error messages/status codes.
- **Docs**: update `curl.md` for every new route/behavior; update `.env.example` for new env vars.
- **Billing separation**: `PaymentModule` charges customers; `BillingModule` charges tenants via `PaymentProviderFactory`.
- **Idempotency**: webhook/webhook-like flows must be idempotent; avoid double-firing events.

## Verification checklist

- [ ] `npx tsc --noEmit` clean
- [ ] `npx eslint "{src,apps,libs,test}/**/*.ts" --max-warnings 0` clean
- [ ] `npx nest build` clean
- [ ] Unit tests added/updated; `npx jest` passes
- [ ] E2E tests added/updated where applicable; `npx jest --config ./test/jest-e2e.json --runInBand` passes
- [ ] `curl.md` updated
- [ ] Migrations added (if schema changes) and migration runner still idempotent
