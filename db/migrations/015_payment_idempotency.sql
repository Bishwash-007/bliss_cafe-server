-- Payment idempotency and audit columns.
--
-- WHY THIS EXISTS
--
-- `payments` (migration 009) records a payment but has no notion of when it was
-- last touched or when the money actually arrived. More importantly, nothing
-- stops two rows from claiming the same gateway transaction. A webhook is
-- delivered by the provider, not by us, and providers retry aggressively: the
-- same `payment_intent.succeeded` can arrive twice, and two app instances can
-- process both copies at once.
--
-- The settlement rule is enforced with a conditional UPDATE
-- (`WHERE status = 'pending'`), which makes the SECOND delivery a no-op even
-- under concurrency. This index is the structural backstop against two
-- different checkout attempts recording the SAME gateway reference — without
-- it, a retried checkout could create two pending rows and the webhook would
-- have no way to know which one it settles.
--
-- The index is partial because `provider_reference` is nullable (a cash
-- payment has no gateway reference), and Postgres treats NULLs as distinct in
-- a normal unique index anyway — spelling out the predicate documents the
-- intent and keeps the index small.
--
-- RLS was already enabled on `payments` by migration 010; no policy changes
-- are needed here.

ALTER TABLE payments
    ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN paid_at    TIMESTAMPTZ;

-- One gateway transaction can map to at most one payment row.
CREATE UNIQUE INDEX idx_payments_provider_reference
    ON payments(tenant_id, provider, provider_reference)
    WHERE provider_reference IS NOT NULL;
