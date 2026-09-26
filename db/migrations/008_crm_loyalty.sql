CREATE TABLE loyalty_accounts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    points_balance  INT NOT NULL DEFAULT 0,
    tier            VARCHAR(30) NOT NULL DEFAULT 'standard',
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, customer_id)
);
CREATE INDEX idx_loyalty_tenant ON loyalty_accounts(tenant_id);

CREATE TABLE promotions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code            VARCHAR(50) NOT NULL,
    description     TEXT,
    discount_type   VARCHAR(20) NOT NULL,  -- percentage, flat
    discount_value  NUMERIC(10,2) NOT NULL,
    starts_at       TIMESTAMPTZ,
    ends_at         TIMESTAMPTZ,
    is_active       BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (tenant_id, code)
);
CREATE INDEX idx_promotions_tenant ON promotions(tenant_id);
