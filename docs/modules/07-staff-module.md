# Agent Prompt: StaffModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/004_users_and_roles.sql` before writing code. This module needs new tables not yet in the schema — add them via a new migration following the existing numbering and RLS pattern.

## Scope
Staff scheduling (shifts/roster), attendance (clock-in/out), and basic payroll calculation.

## Design Patterns

**Strategy** — wage calculation legitimately differs by staff type (hourly vs. fixed salary vs. tip-pooled). Isolating this now means payroll export doesn't hardcode one formula that becomes wrong the moment a tenant hires a salaried manager.

## Task

1. Write `db/migrations/011_staff_scheduling.sql`:
   - `shifts` (id, tenant_id, branch_id, user_id, start_time, end_time, created_at)
   - `attendance_records` (id, tenant_id, shift_id, clock_in, clock_out)
   - Both tables get `tenant_id` + indexes + an RLS policy following the exact pattern in `db/migrations/010_row_level_security.sql` — do not invent a different enforcement approach.
2. Shift CRUD + a roster view: `GET /branches/:id/roster?week=YYYY-MM-DD` returning all shifts for that branch/week grouped by staff member.
3. Clock-in/out endpoints. Validate clock-in happens within a reasonable window of the scheduled shift start (e.g. ±30 min, configurable) and clock-out is after clock-in — reject otherwise with a clear error rather than silently accepting bad data.
4. **Strategy pattern**: define `WageCalculationStrategy` interface with a `calculate(attendanceRecords, rate): number` method. Implement `HourlyWageStrategy` (hours worked × hourly rate) as the concrete starting implementation. Document the interface clearly enough that `SalariedStrategy` or `TipPooledStrategy` can be added later without any change to `PayrollService`.
5. CSV export of a pay period's calculated wages per staff member (`GET /branches/:id/payroll/export?from=&to=`).

## Acceptance Criteria (write tests for these)
- New tables enforce tenant isolation identically to existing tables (same RLS test pattern as the DB migration validation already run).
- Clock-out before clock-in is rejected.
- Clock-in far outside the scheduled shift window is rejected with a clear error.
- `HourlyWageStrategy` produces correct totals for partial-hour shifts (e.g. 7.5 hours, not rounded incorrectly).
- CSV export totals match the sum of individually calculated wages for the same period.
