# Agent Prompt: CrmModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/006_orders.sql` (for `customers`) and `db/migrations/008_crm_loyalty.sql` before writing code. **Depends on `OrderModule`'s event bus** — subscribe to its existing events; do not create a second one.

## Scope
Customer profiles, loyalty points, promotions/discounts.

## Design Patterns

**Strategy** — loyalty point accrual and promotion discount calculation both vary by rule type (points-per-currency vs. points-per-visit; percentage discount vs. flat discount). This directly replaces what would otherwise be an `if (type === 'percentage') ... else ...` branch.

**Observer** — this module subscribes to `order.paid` (published by `OrderModule`) to award loyalty points; it does not get called synchronously from checkout code.

## Task

1. Register a listener on `order.paid`. Award loyalty points via a **Strategy**: define `LoyaltyAccrualStrategy` interface with a `calculatePoints(orderTotal): number` method. Implement `PointsPerCurrencyStrategy` (e.g. 1 point per 100 currency units spent) as the default, upserting into `loyalty_accounts`.
2. Ensure idempotency: if the same `order.paid` event is somehow delivered twice (retries, at-least-once delivery), points must not be awarded twice for the same order. Track which orders have already been credited.
3. **Strategy pattern** for discounts: define `DiscountStrategy` interface with an `apply(subtotal): number` method. Implement `PercentageDiscountStrategy` and `FlatDiscountStrategy`, both reading their parameters from the `promotions` table's `discount_type`/`discount_value` columns. A `PromotionService.getStrategyFor(promotion)` factory-style lookup picks the right one — this is the direct replacement for a type-check branch.
4. Reject expired or inactive promotions at apply-time (`starts_at`/`ends_at`/`is_active` checks), with a clear error rather than silently applying a stale discount.
5. Customer lookup/creation by phone number, usable from `OrderModule`'s checkout flow to optionally attach a loyalty account to a dine-in order.

## Acceptance Criteria (write tests for these)
- Correct discount strategy is selected purely from `discount_type`, with correct output for both percentage and flat cases.
- Loyalty points are awarded exactly once per paid order, even if the underlying event fires twice.
- An expired or inactive promotion is rejected when a customer tries to apply it.
- Customer lookup by phone returns the existing record if present, creates one if not, scoped correctly per tenant.
