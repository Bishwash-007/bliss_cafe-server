CREATE TABLE customers (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    full_name   VARCHAR(150),
    phone       VARCHAR(30),
    email       VARCHAR(150),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, phone)
);
CREATE INDEX idx_customers_tenant ON customers(tenant_id);

CREATE TABLE orders (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    table_id            UUID REFERENCES tables(id) ON DELETE SET NULL,
    customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
    created_by          UUID REFERENCES users(id),   -- waiter/cashier who took the order
    order_type          VARCHAR(20) NOT NULL DEFAULT 'dine_in', -- dine_in, takeaway, delivery
    status              VARCHAR(20) NOT NULL DEFAULT 'placed',
        -- placed, confirmed, preparing, ready, served, awaiting_payment, paid, completed, cancelled
    subtotal            NUMERIC(10,2) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(10,2) NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(10,2) NOT NULL DEFAULT 0,
    total_amount        NUMERIC(10,2) NOT NULL DEFAULT 0,
    client_action_id    UUID,  -- idempotency key from the offline action queue (mobile clients)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_tenant ON orders(tenant_id);
CREATE INDEX idx_orders_branch ON orders(branch_id);
CREATE INDEX idx_orders_table ON orders(table_id);
-- Prevents a retried offline action from creating a duplicate order
CREATE UNIQUE INDEX idx_orders_client_action ON orders(tenant_id, client_action_id)
    WHERE client_action_id IS NOT NULL;

CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id    UUID NOT NULL REFERENCES menu_items(id),
    quantity        INT NOT NULL DEFAULT 1,
    unit_price      NUMERIC(10,2) NOT NULL,
    notes           TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'placed' -- placed, preparing, ready, served, cancelled
);
CREATE INDEX idx_order_items_tenant ON order_items(tenant_id);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE order_item_modifiers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_item_id   UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
    modifier_id     UUID REFERENCES menu_item_modifiers(id),
    name            VARCHAR(100) NOT NULL,
    extra_price     NUMERIC(10,2) NOT NULL DEFAULT 0
);
CREATE INDEX idx_order_item_modifiers_tenant ON order_item_modifiers(tenant_id);
