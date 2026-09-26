-- Sample data for local dev/testing. Run manually AFTER migrations:
--   docker exec -i cafe_saas_db psql -U cafe_admin -d cafe_saas < db/seed/seed.sql

INSERT INTO plans (name, max_branches, max_staff, price_monthly) VALUES
    ('free', 1, 3, 0),
    ('starter', 3, 15, 29.00),
    ('pro', 20, 100, 99.00);

INSERT INTO roles (name) VALUES
    ('super_admin'), ('org_owner'), ('branch_manager'),
    ('receptionist'), ('waiter'), ('kitchen_staff'), ('customer');

-- One sample tenant: "Bean House"
WITH new_tenant AS (
    INSERT INTO tenants (name, slug, plan_id)
    SELECT 'Bean House', 'beanhouse', id FROM plans WHERE name = 'starter'
    RETURNING id
),
new_branch AS (
    INSERT INTO branches (tenant_id, name, address)
    SELECT id, 'Bean House - Thamel', 'Thamel, Kathmandu' FROM new_tenant
    RETURNING id, tenant_id
)
INSERT INTO tables (tenant_id, branch_id, label, seats)
SELECT tenant_id, id, label, 4
FROM new_branch, (VALUES ('T1'), ('T2'), ('T3')) AS t(label);

-- Owner account for that tenant (password hash is a placeholder — hash "password123" in app code)
INSERT INTO users (tenant_id, branch_id, role_id, full_name, email, password_hash)
SELECT
    t.id, b.id, r.id,
    'Bishwash (Owner)', 'owner@beanhouse.test', '$2b$10$replace_with_real_bcrypt_hash'
FROM tenants t
JOIN branches b ON b.tenant_id = t.id
JOIN roles r ON r.name = 'org_owner'
WHERE t.slug = 'beanhouse';
