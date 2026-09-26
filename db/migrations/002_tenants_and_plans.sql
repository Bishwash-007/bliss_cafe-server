-- Platform-level tables (no tenant_id — these ARE the tenants)

CREATE TABLE plans (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(50) NOT NULL UNIQUE,   -- free, starter, pro
    max_branches    INT NOT NULL DEFAULT 1,
    max_staff       INT NOT NULL DEFAULT 5,
    price_monthly   NUMERIC(10,2) NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(150) NOT NULL,
    slug        VARCHAR(100) NOT NULL UNIQUE,      -- used for subdomain routing
    plan_id     UUID REFERENCES plans(id),
    status      VARCHAR(20) NOT NULL DEFAULT 'active', -- active, suspended, cancelled
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_subscriptions (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan_id     UUID NOT NULL REFERENCES plans(id),
    started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at     TIMESTAMPTZ,
    status      VARCHAR(20) NOT NULL DEFAULT 'active'
);
CREATE INDEX idx_tenant_subscriptions_tenant ON tenant_subscriptions(tenant_id);
