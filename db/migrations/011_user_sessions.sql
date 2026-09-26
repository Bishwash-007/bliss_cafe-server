-- Refresh-token sessions with rotation chains.
--
-- A refresh token is stored only as a SHA-256 hash. Each rotation revokes the
-- presented token and mints a new one in the same `family_id`. If a revoked
-- (already rotated) token is ever presented again, the whole family is
-- revoked: reuse means the token leaked and the session may be compromised.
--
-- Unlike migration 010, this table is defined here, so its RLS policy is
-- added here rather than from the 010 loop.

CREATE TABLE user_sessions (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family_id           UUID NOT NULL,                    -- rotation chain
    refresh_token_hash  TEXT NOT NULL,                     -- sha256 hex of the token
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    rotated_from        UUID REFERENCES user_sessions(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at        TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_user_sessions_token ON user_sessions(tenant_id, refresh_token_hash);
CREATE INDEX idx_user_sessions_family ON user_sessions(tenant_id, family_id);
CREATE INDEX idx_user_sessions_user ON user_sessions(tenant_id, user_id);

ALTER TABLE user_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON user_sessions
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);