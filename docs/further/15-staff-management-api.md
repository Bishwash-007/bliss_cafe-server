# Agent Prompt: Staff Management API (Full HR)

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Basic staff/scheduling exists (`staff` module with shifts/clock-in). Extend to full staff management. Read `db/migrations/013_staff_scheduling.sql` and staff module code.

## Scope
Staff CRUD, invites, roles/permissions, leave requests/approvals, contracts, payroll periods, org chart support.

## Design Patterns
- **RBAC + Permissions**: extend role-based checks with fine-grained permissions
- **State**: leave request states (pending/approved/rejected/cancelled), shift states as applicable
- **Factory/Service**: invite flow with token generation/expiry

## Task
1. **Schema**: Add `staff_invites` (token hash, email, role, branch_id, expires_at, accepted_at), `staff_leave` (request/approval flow), `staff_contracts`, `payroll_periods`, `staff_permissions`/mappings as needed.
2. **Invites**: `POST /staff/invites`, `POST /staff/invites/accept` with token validation, rate limiting.
3. **CRUD**: Extend staff endpoints for create/update/deactivate, role assignment, branch assignment respecting org-wide rules.
4. **Leave**: Request/approve/reject/cancel with branch/org-wide authz.
5. **Payroll**: Define periods, compute hours from shifts/clock-ins, export support.
6. **AuthZ**: Apply `assertBranchAccess`/`assertOrgWide` consistently; branch managers limited to their branch.

## Acceptance Criteria
- [ ] Invites expire and are single-use
- [ ] Role changes respect permissions
- [ ] Leave approvals require proper authority
- [ ] Branch scope enforced
- [ ] Cannot escalate privileges beyond caller
- [ ] Tests cover invites, leave workflow, branch isolation
- [ ] `curl.md` updated

## Notes
- Don't break existing shifts/clock-in
- Consider audit logging for sensitive changes
