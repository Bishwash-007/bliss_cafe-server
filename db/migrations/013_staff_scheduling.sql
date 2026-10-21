-- Staff scheduling, attendance and wage configuration.
--
-- NUMBERING
--
-- The module brief asks for `011_staff_scheduling.sql`, but 011 and 012 are
-- already taken (`011_user_sessions.sql`, `012_inventory_deductions.sql`) and
-- both have been applied to existing databases. This is therefore 013, and the
-- migrations must be applied in filename order.
--
-- RLS
--
-- Declared here rather than added to the loop in 010, following the pattern
-- `user_sessions` (011) and `order_inventory_deductions` (012) already
-- established: 010 has run on every existing database, so a table added to its
-- loop would never get a policy there. The policy itself is character-for-
-- character the same enforcement as 010's loop produces:
--
--   ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY tenant_isolation ON <t>
--       USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
--
-- The application must `SET LOCAL app.tenant_id` at the start of every
-- transaction (see `TenantScopedConnection`), and a query that forgets a
-- `tenant_id` predicate is still safe because Postgres filters the rows out.
--
-- NOTE FOR AN EXISTING DATABASE: this migration is additive. It creates three
-- new tables and touches nothing that already exists, so it applies cleanly to a
-- populated database.

-- ------------------------------------------------------------------- shifts
--
-- A scheduled block of work for one staff member at one branch.
--
-- `user_id` and `branch_id` are both NOT NULL and both cascade: a shift belongs
-- to exactly one person at exactly one branch. That is what makes the roster a
-- per-branch view rather than a per-tenant one, and it is why the deduction and
-- payroll paths can join a single way to "who worked where".
--
-- A shift is NOT NULL on `end_time` — a shift with no end is not a shift, it is
-- a typo, and a scheduled block whose length is unknown cannot be paid for.
CREATE TABLE shifts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    start_time  TIMESTAMPTZ NOT NULL,
    end_time    TIMESTAMPTZ NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- A zero-length or reversed shift would make every attendance calculation
    -- nonsense, and would be silently accepted by the database otherwise.
    CONSTRAINT shifts_end_after_start CHECK (end_time > start_time)
);

CREATE INDEX idx_shifts_tenant ON shifts(tenant_id);
-- The roster query is "this branch, this week", so branch and start_time lead.
CREATE INDEX idx_shifts_branch_start ON shifts(tenant_id, branch_id, start_time);
CREATE INDEX idx_shifts_user ON shifts(tenant_id, user_id, start_time);

-- -------------------------------------------------------- attendance_records
--
-- One record per shift: the clock-in and the clock-out that close it.
--
-- The relationship is 1:1 with `shifts` rather than 1:N, and the UNIQUE index
-- is what enforces it. A shift is a scheduled block; clocking in covers it and
-- clocking out ends it. Allowing several records per shift would mean deciding
-- what a break is, and whether a break is paid — a business decision this module
-- has no basis to make.
--
-- The consequence is that "already clocked in" and "already clocked out" are
-- answered by the database rather than by a check-then-act in the service, which
-- is the only way two simultaneous clock-ins cannot both succeed.
--
-- `clock_out` is NULL while the person is still working. `clock_in` is NOT
-- NULL: a record with no clock-in has no start time and cannot be paid for.
--
-- The CHECK is the last line of defence for an impossible record. The service
-- rejects a clock-out before a clock-in with a 400 and a clear message, because
-- a constraint violation would otherwise arrive as an opaque 500 from the
-- driver.
CREATE TABLE attendance_records (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    shift_id    UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    clock_in    TIMESTAMPTZ NOT NULL,
    clock_out   TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT attendance_clock_out_after_in
        CHECK (clock_out IS NULL OR clock_out > clock_in)
);

CREATE INDEX idx_attendance_tenant ON attendance_records(tenant_id);
CREATE INDEX idx_attendance_shift ON attendance_records(tenant_id, shift_id);
-- Payroll aggregates attendance by time window, so the clock-in time is the
-- leading column of the range scan.
CREATE INDEX idx_attendance_clock_in ON attendance_records(tenant_id, clock_in);

-- One attendance record per shift. See the note above: this is the 1:1 rule
-- stated as a constraint rather than as a convention.
CREATE UNIQUE INDEX idx_attendance_one_per_shift
    ON attendance_records(tenant_id, shift_id);

-- ----------------------------------------------------------- staff_wage_rates
--
-- How a staff member is paid, and at what rate.
--
-- This table exists because a payroll calculation needs a rate from somewhere,
-- and there is nowhere in the schema to put one: `users` (004) holds identity
-- and credentials, not compensation, and the auth module should not have to
-- know about payroll. It also carries `pay_type`, which is what selects the
-- strategy — see `src/staff/payroll/wage-calculation.strategy.ts`.
--
-- `pay_type` values map to strategy names:
--   hourly     - `HourlyWageStrategy` (the one implemented)
--   salaried   - `SalariedStrategy`   (not implemented — see the module barrel)
--   tip_pooled - `TipPooledStrategy`  (not implemented)
--
-- `rate` is money per hour for `hourly`, money per period for `salaried`, and
-- the pool share for `tip_pooled`. The meaning is the strategy's business, so
-- the column is deliberately not named for any one of them.
--
-- The UNIQUE (tenant_id, user_id) makes a rate per person per tenant: two
-- different rates for one person would make the payroll total depend on which
-- row the query happened to read.
--
-- There is no currency column, because the schema has no currency concept at
-- all — not on the tenant, not on the menu, not on payments. Introducing one
-- here would mean inventing a per-tenant currency that the rest of the system
-- does not agree with. The rate is a plain amount in the tenant's own currency,
-- and adding a currency is a schema decision for the tenant/billing work.
CREATE TABLE staff_wage_rates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pay_type    VARCHAR(20) NOT NULL DEFAULT 'hourly',
    rate        NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, user_id),
    CONSTRAINT staff_wage_rate_non_negative CHECK (rate >= 0)
);

CREATE INDEX idx_staff_wage_rates_tenant ON staff_wage_rates(tenant_id);
CREATE INDEX idx_staff_wage_rates_user ON staff_wage_rates(tenant_id, user_id);

-- --------------------------------------------------------------------- RLS
ALTER TABLE shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shifts
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE attendance_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON attendance_records
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE staff_wage_rates ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staff_wage_rates
    USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
