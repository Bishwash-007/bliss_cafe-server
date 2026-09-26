# Agent Prompt: OrgModule / BranchModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/002_tenants_and_plans.sql` and `db/migrations/003_branches_and_tables.sql` before writing code.

## Scope
Tenant self-registration/onboarding flow, and ongoing branch + table CRUD.

## Design Patterns

**Builder** — onboarding is a multi-step process (create org → create first branch → seed default tables → create owner account) that needs to succeed or fail as a unit. A Builder makes each step explicit and lets the whole chain roll back atomically on failure — a half-created tenant is worse than none.

**Repository** — standard data-access abstraction for branches/tables, scoped through `TenantModule`'s connection proxy.

## Task

1. Build `TenantOnboardingBuilder` with fluent methods:
   - `.withOrgDetails(name, slug)`
   - `.withPlan(planId)`
   - `.withFirstBranch(name, address)`
   - `.withDefaultTables(count)`
   - `.withOwnerAccount(email, passwordHash)`
   - `.build()` — runs all inserts inside a single DB transaction; any failure rolls back everything, including the tenant row itself.
2. Validate slug uniqueness against `tenants.slug` before the builder commits — fail fast with a clear `SlugAlreadyTakenException`, not a raw DB constraint error.
3. Build `BranchService` / `BranchRepository` for standard CRUD (create, update, deactivate — avoid hard deletes, use `is_active`), tenant-scoped via the existing `TenantScopedConnection`.
4. Enforce `plans.max_branches`: when creating a branch beyond what the tenant's plan allows, throw `PlanLimitExceededException` with a message telling them their current limit.
5. Table CRUD nested under branches (`POST /branches/:id/tables`), enforcing the `UNIQUE (branch_id, label)` constraint already in the schema with a friendly error on violation.

## Acceptance Criteria (write tests for these)
- Full onboarding builder happy path creates tenant + branch + tables + owner user, all correctly linked.
- A failure partway through the builder chain (e.g. duplicate slug caught late, or a forced DB error) leaves zero rows behind — verify no orphaned tenant/branch records.
- Branch creation is blocked once the plan's `max_branches` is hit, with a clear error, not a generic 500.
- Duplicate table label within the same branch is rejected with a friendly error, not a raw Postgres constraint message.
