# Agent Prompt: TenantModule

## Context
You're implementing a module in a multi-tenant cafe management SaaS (NestJS + PostgreSQL). Multi-tenancy is enforced via Postgres Row-Level Security keyed on a session variable `app.tenant_id`. Read `db/migrations/010_row_level_security.sql` before writing any code — it defines the exact enforcement mechanism this module is responsible for driving correctly.

## Scope
Resolve which tenant an incoming request belongs to, and ensure every database call for that request runs inside that tenant's RLS context. Get this wrong and either legitimate requests get zero rows back, or — worse — tenant isolation silently breaks.

## Design Patterns

**Chain of Responsibility** — tenant resolution should try multiple strategies in priority order until one succeeds:
1. Subdomain (e.g. `beanhouse.yourapp.com` → slug `beanhouse`)
2. `X-Tenant-Id` header (for API clients / mobile apps)
3. JWT claim (`tenantId` embedded in the access token, for already-authenticated requests)

Chaining these means adding a new resolution method later (e.g. custom domain mapping) doesn't require touching the existing resolvers.

**Proxy** — wrap the raw `pg` client so that tenant-scoping is structurally impossible to forget. Repository code should never call `SET LOCAL app.tenant_id` itself.

## Task

1. Define a `TenantResolver` interface with `resolve(req): string | null`. Implement `SubdomainTenantResolver`, `HeaderTenantResolver`, `JwtClaimTenantResolver` in that priority order.
2. Build a `TenantChainResolver` that runs the chain and returns the first non-null result, or throws `TenantNotFoundException`.
3. Build `TenantContextMiddleware`: runs the chain, validates the resolved tenant exists and has `status = 'active'` in the `tenants` table (reject `suspended`/`cancelled` tenants with a clear error), and attaches `req.tenantId`.
4. Build `TenantScopedConnection` (the Proxy): wraps a pooled `pg` client. On acquisition within a request, runs `SET LOCAL app.tenant_id = $1` transactionally before any repository touches it.
5. Handle the platform-admin case: routes under `/platform/*` (SuperAdmin dashboard) should skip tenant resolution entirely and query without RLS (via a role with `BYPASSRLS`, or a separate unscoped connection) — don't force every route through the tenant chain.

## Acceptance Criteria (write tests for these)
- Each resolver works correctly in isolation given a matching request shape.
- The chain falls through correctly when higher-priority resolvers return null.
- A suspended/cancelled tenant is rejected even if resolution succeeds.
- A query run without `app.tenant_id` set returns zero rows, not an error and not other tenants' data (proves RLS fail-safe).
- Platform-admin routes bypass tenant scoping without needing a valid tenant to resolve.
