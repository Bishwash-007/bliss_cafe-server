# Agent Prompt: BillingModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/002_tenants_and_plans.sql` for `plans`/`tenant_subscriptions` before writing code. **This module is distinct from `PaymentModule`**: `PaymentModule` is the cafe charging its own customers at checkout; `BillingModule` is the SaaS platform charging the cafe (tenant) for its subscription. Don't conflate the two, and delegate actual card charging to `PaymentModule`'s existing `PaymentProviderFactory` rather than talking to Stripe/eSewa directly here.

## Scope
Tenant subscription lifecycle, plan upgrades/downgrades with proration, renewal billing.

## Design Patterns

**State** — a subscription's valid actions genuinely differ by status: a `past_due` subscription can retry payment or be cancelled, but shouldn't be allowed to upgrade until it's current. Same rationale as `OrderModule`'s use of State.

**Strategy** — proration math differs by the type of plan change (upgrade mid-cycle vs. downgrade vs. change taking effect next cycle). Isolating this avoids an unmaintainable branch of billing-date arithmetic.

## Task

1. Define a `SubscriptionState` interface with `TrialingState`, `ActiveState`, `PastDueState`, `CancelledState` concrete classes, each defining `allowedActions(): string[]` (e.g. `PastDueState` allows `['retry_payment', 'cancel']`, not `['upgrade']`).
2. `SubscriptionService.performAction(tenantId, action)` checks the current state's allowed actions before proceeding, throwing `InvalidSubscriptionActionException` otherwise.
3. **Strategy pattern**: define `ProrationStrategy` interface with a `calculate(oldPlan, newPlan, daysRemainingInCycle): number` method. Implement `DaysRemainingProrationStrategy` as the default for mid-cycle plan changes.
4. For actually charging the tenant's card on file, call `PaymentProviderFactory.getProvider(tenantId)` from `PaymentModule` — do not implement a second, separate gateway integration here.
5. Build a scheduled job (cron, e.g. daily) that checks `tenant_subscriptions.ends_at`: attempts renewal charge via the payment provider, transitions to `PastDueState` on failure (do not silently leave it `active`), transitions to `ActiveState` with a new `ends_at` on success.
6. Plan upgrade/downgrade endpoint: validates the current state allows it, calculates proration via the strategy, charges/credits accordingly, updates `tenant_subscriptions` and `tenants.plan_id`.

## Acceptance Criteria (write tests for these)
- State transitions enforce allowed-action rules for every state (e.g. `past_due` correctly rejects an upgrade attempt).
- `DaysRemainingProrationStrategy` computes the correct prorated amount for a mid-cycle upgrade, verified against a hand-calculated example.
- A failed renewal charge correctly moves the subscription to `PastDueState`, not silently stays `ActiveState`.
- A successful renewal correctly extends `ends_at` and keeps the subscription `ActiveState`.
- Billing charges route through `PaymentModule`'s existing provider abstraction — no duplicate Stripe/eSewa client instantiated in this module.
