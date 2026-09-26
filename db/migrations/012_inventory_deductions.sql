-- Order -> inventory deduction ledger.
--
-- WHY THIS EXISTS
--
-- The module brief asks for the deduction and the order's `completed` status to
-- be atomic. They cannot be, and it is worth being precise about why:
--
--   `OrderModule` publishes `order.status_changed` through
--   `TenantScopedConnection.onCommit(...)`, i.e. AFTER the order transaction has
--   committed (see `src/order/events/order-events.ts`). By the time this module
--   hears about `completed`, the order row is already durable and visible to
--   every other connection. There is no open transaction left to roll back.
--
--   The only way to get true cross-boundary atomicity would be for
--   `OrderService` to call into Inventory synchronously inside the transition —
--   which the brief explicitly forbids, because the whole point of the Observer
--   bus is that `OrderService` must not know inventory exists.
--
-- So atomicity is bought where it is actually available, and the gap is made
-- visible instead of silent:
--
--   1. ATOMIC DEDUCTION. Every ingredient of the whole order is deducted, every
--      `stock_movements` row written and every `quantity_on_hand` updated inside
--      ONE transaction, together with the ledger row below. Stock is never half
--      deducted, and a crash mid-deduction leaves no trace at all.
--   2. IDEMPOTENCY. The UNIQUE (tenant_id, order_id) constraint is the
--      exactly-once guard. The bus is in-process and best-effort, so a
--      redelivered `completed` event must not deduct twice; the constraint
--      makes a double deduction impossible even under concurrent redelivery,
--      which application-level "have I done this?" checks cannot guarantee.
--   3. NO SILENT FAILURE. A failed deduction rolls back completely, and is then
--      recorded as `failed` on its own connection — the write happens OUTSIDE
--      the rolled-back transaction, because a row written inside it would vanish
--      with the rollback and take the only evidence of the problem with it.
--      `GET /inventory/discrepancies` lists them for manual review.
--
-- `status` values:
--   pending   - claimed, work in flight (only ever visible mid-transaction)
--   completed - every recipe ingredient deducted
--   partial   - deducted what it could; `detail` names menu items with no recipe
--   failed    - nothing deducted; `detail` is the error
--
-- RLS is declared here rather than added to the 010 loop, following the same
-- pattern as `user_sessions` in 011 (010 has already run on existing databases).

-- ---------------------------------------------------------------- recipe integrity
--
-- A second, smaller integrity fix that the ledger DEPENDS on, so it belongs with
-- it rather than in a migration of its own.
--
-- 007 has no uniqueness on `recipe_ingredients`, which is a correctness bug rather
-- than a tidiness one: the deduction aggregates with
-- `SUM(quantity_used * order_item.quantity)`, so the same ingredient listed twice
-- in one recipe is counted twice and twice as much stock leaves the shelf. Nothing
-- downstream can detect that, because the arithmetic is self-consistent.
--
-- With this index, `InventoryRepository.upsertRecipeIngredient` can be a real
-- `INSERT ... ON CONFLICT` (edit the quantity in place) instead of a
-- check-then-insert, which would race: two concurrent recipe edits could both
-- decide the ingredient is absent and both insert.
--
-- NOTE FOR AN EXISTING DATABASE: this fails if 007 already has duplicate rows.
-- Deduplicate first (keep the highest `quantity_used` per
-- (tenant_id, menu_item_id, inventory_item_id)), then run this migration.
CREATE UNIQUE INDEX idx_recipe_ingredients_unique
    ON recipe_ingredients(tenant_id, menu_item_id, inventory_item_id);

CREATE TABLE order_inventory_deductions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',
    detail          TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The exactly-once guard. Also the lookup key for "has this order been
-- deducted?", so it is deliberately narrow.
CREATE UNIQUE INDEX idx_order_inventory_deductions_once
    ON order_inventory_deductions(tenant_id, order_id);

-- Supports the review queue: "show me the failures", newest first.
CREATE INDEX idx_order_inventory_deductions_status
    ON order_inventory_deductions(tenant_id, status, created_at DESC);

ALTER TABLE order_inventory_deductions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON order_inventory_deductions
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
