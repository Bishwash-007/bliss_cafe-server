CREATE TABLE branches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name        VARCHAR(150) NOT NULL,
    address     TEXT,
    phone       VARCHAR(30),
    timezone    VARCHAR(50) NOT NULL DEFAULT 'UTC',
    is_active   BOOLEAN NOT NULL DEFAULT true,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_branches_tenant ON branches(tenant_id);

CREATE TABLE tables (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    label       VARCHAR(50) NOT NULL,          -- "T1", "Patio 3"
    seats       INT NOT NULL DEFAULT 2,
    status      VARCHAR(20) NOT NULL DEFAULT 'free', -- free, occupied, reserved
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (branch_id, label)
);
CREATE INDEX idx_tables_tenant ON tables(tenant_id);
CREATE INDEX idx_tables_branch ON tables(branch_id);
