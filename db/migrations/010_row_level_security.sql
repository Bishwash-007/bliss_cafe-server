-- Enforces tenant isolation at the database level.
-- The application must SET LOCAL app.tenant_id = '<uuid>' at the start of every
-- transaction (a NestJS interceptor does this right after auth resolves the tenant).
-- Any query that forgets a WHERE tenant_id = ... clause is still safe: Postgres
-- silently filters rows outside the current tenant.
--
-- IDEMPOTENT
-- ----------
-- This file creates its policies inside a DO block, so the migration runner
-- cannot tell from the schema alone whether it has already run. It is
-- therefore written to be safe to run twice: the policy is dropped first and
-- recreated with the same definition. Re-running it changes nothing, which is
-- what lets the runner apply it to a database that already has it.

DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT unnest(ARRAY[
            'branches', 'tables', 'users',
            'menu_categories', 'menu_items', 'menu_item_modifiers',
            'customers', 'orders', 'order_items', 'order_item_modifiers',
            'suppliers', 'inventory_items', 'recipe_ingredients', 'stock_movements',
            'loyalty_accounts', 'promotions',
            'tenant_payment_configs', 'payments',
            'tenant_subscriptions'
        ])
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I;', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
                USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid);',
            t
        );
    END LOOP;
END $$;

-- Platform super-admins bypass RLS entirely by connecting as a role with BYPASSRLS,
-- or by having the app skip SET LOCAL app.tenant_id for platform-only queries
-- (e.g. the SaaS admin dashboard listing all tenants).
