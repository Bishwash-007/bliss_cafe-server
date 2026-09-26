CREATE TABLE tenant_payment_configs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider            VARCHAR(30) NOT NULL, -- stripe, esewa, razorpay
    config_encrypted    TEXT NOT NULL,        -- encrypted JSON blob (api keys, merchant ids...)
    is_active           BOOLEAN NOT NULL DEFAULT true,
    UNIQUE (tenant_id, provider)
);
CREATE INDEX idx_payment_configs_tenant ON tenant_payment_configs(tenant_id);

CREATE TABLE payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    order_id            UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    provider            VARCHAR(30) NOT NULL,
    provider_reference  VARCHAR(150),          -- gateway transaction/QR id
    method              VARCHAR(20) NOT NULL,  -- cash, card, qr, wallet
    amount              NUMERIC(10,2) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending, succeeded, failed, refunded
    received_by         UUID REFERENCES users(id), -- receptionist/waiter for cash payments
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_payments_tenant ON payments(tenant_id);
CREATE INDEX idx_payments_order ON payments(order_id);
