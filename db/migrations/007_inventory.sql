CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name            VARCHAR(150) NOT NULL,
    contact_phone   VARCHAR(30),
    contact_email   VARCHAR(150),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_suppliers_tenant ON suppliers(tenant_id);

CREATE TABLE inventory_items (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id           UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name                VARCHAR(150) NOT NULL,
    unit                VARCHAR(20) NOT NULL,          -- kg, l, pcs
    quantity_on_hand    NUMERIC(12,3) NOT NULL DEFAULT 0,
    reorder_threshold   NUMERIC(12,3) NOT NULL DEFAULT 0,
    supplier_id         UUID REFERENCES suppliers(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_inventory_tenant ON inventory_items(tenant_id);
CREATE INDEX idx_inventory_branch ON inventory_items(branch_id);

CREATE TABLE recipe_ingredients (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    menu_item_id        UUID NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    quantity_used       NUMERIC(12,3) NOT NULL
);
CREATE INDEX idx_recipe_tenant ON recipe_ingredients(tenant_id);

CREATE TABLE stock_movements (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    inventory_item_id   UUID NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
    movement_type       VARCHAR(20) NOT NULL, -- purchase, usage, wastage, adjustment
    quantity            NUMERIC(12,3) NOT NULL, -- positive = stock in, negative = stock out
    reference_order_id  UUID REFERENCES orders(id),
    note                TEXT,
    created_by          UUID REFERENCES users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_movements_tenant ON stock_movements(tenant_id);
