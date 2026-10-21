-- Loyalty credit ledger — the exactly-once record for `order.paid` accrual.
--
-- WHY THIS EXISTS
--
-- `CrmModule` awards loyalty points from `order.paid`, which `OrderModule`
-- publishes through `TenantScopedConnection.onCommit(...)` — AFTER the order
-- transaction has committed. The bus is in-process and best-effort (see
-- `src/order/events/order-events.ts`), so the same event can be delivered twice:
-- a retry, two instances racing on a shared adapter, or a publisher that
-- re-emits. Awarding twice would quietly inflate a customer's balance, and no
-- later screen would look wrong enough to notice.
--
-- An application-level "has this order been credited?" check cannot guarantee
-- exactly-once: two deliveries can both read "no" before either writes. The
-- UNIQUE (tenant_id, order_id) index is the authority, and the credit and the
-- balance update happen in ONE transaction, so a crash can never leave points
-- awarded without the ledger row (or the reverse).
--
-- `orders(id)` is referenced ON DELETE CASCADE, matching
-- `order_inventory_deductions` in 012: the ledger is an audit of what the order
-- caused, and an order that no longer exists has no audit to keep. Deleting an
-- order is an administrative action, not something checkout does.
--
-- RLS is declared here rather than added to the 010 loop, following the same
-- pattern as `user_sessions` (011), `order_inventory_deductions` (012) and the
-- staff tables (013): 010 has already run on every existing database, so a
-- table added to its loop would never get a policy there.

CREATE TABLE loyalty_credits (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    points      INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The exactly-once guard, and the lookup key for "was this order credited?".
-- Deliberately narrow: one row per order per tenant, by construction.
CREATE UNIQUE INDEX idx_loyalty_credits_once
    ON loyalty_credits(tenant_id, order_id);

-- Supports a customer's credit history, newest first.
CREATE INDEX idx_loyalty_credits_customer
    ON loyalty_credits(tenant_id, customer_id, created_at DESC);

ALTER TABLE loyalty_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON loyalty_credits
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
