# Agent Prompt: Branch Scope Extension (Inventory/Staff/CRM/Reporting)

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Branch scope currently enforced on orders, branches, menu. RLS confines by tenant; extend to inventory, staff, CRM, reporting.

Read `src/auth/branch-scope.ts`, existing controllers (order/branch/menu) for patterns.

## Scope
Apply `assertBranchAccess`/`assertOrgWide` consistently, respect org-wide roles, maintain tenant isolation.

## Task
1. **Inventory**: branch-scoped items/stock where applicable; org-wide items handled correctly
2. **Staff**: shifts/roster scoped by branch; org-wide roles see all
3. **CRM**: customers/loyalty - determine org-wide vs branch-scoped; apply rules
4. **Reporting**: branch-scoped reports for branch users, org-wide for owners/super_admin; respect RLS
5. **Services**: add filters in services, not just controllers
6. **Tests**: cross-branch access denied, org-wide allowed

## Acceptance Criteria
- [ ] Branch-confined users cannot access other branches' data
- [ ] Org-wide roles (super_admin, org_owner) have appropriate access
- [ ] RLS + application checks both enforced
- [ ] No privilege escalation
- [ ] Tests cover cases
- [ ] `curl.md` updated (branch scope section)

## Notes
- Some entities may be intentionally tenant-wide; document decisions
