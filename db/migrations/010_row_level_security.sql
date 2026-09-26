-- Enforces tenant isolation at the database level.
-- The application must SET LOCAL app.tenant_id = '<uuid>' at the start of every
-- transaction (a NestJS interceptor does this right after auth resolves the tenant).
-- Any query that forgets a WHERE tenant_id = ... clause is still safe: Postgres
-- silently filters rows outside the current tenant.

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
