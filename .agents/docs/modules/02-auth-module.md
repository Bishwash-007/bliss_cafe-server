# Agent Prompt: AuthModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/004_users_and_roles.sql` before writing code — it defines `users` and `roles`. Assume `TenantModule` already resolves `req.tenantId` upstream; this module scopes login/auth to that tenant.

## Scope
Login (staff + customer), JWT issuance/refresh, role-based access control (RBAC).

## Design Patterns

**Strategy** — NestJS's Passport integration is a direct application of Strategy: `LocalStrategy`, `JwtStrategy`, and `OtpStrategy` are interchangeable authentication methods behind one `AuthService.validate()` call. Adding a future social-login strategy shouldn't require touching the others.

**Decorator** — a `@Roles(...roles)` custom decorator plus a `RolesGuard` adds authorization behavior to route handlers declaratively, without any route handler needing to check roles itself.

## Task

1. Implement `LocalStrategy`: validates email + password against `users.password_hash` (bcrypt) scoped to the current tenant.
2. Implement `JwtStrategy`: validates access token signature/expiry, loads user + role + tenant_id + branch_id from the payload.
3. Implement `OtpStrategy` (stub is fine): validates an OTP code, returns the same shape as the other strategies so `AuthService` doesn't care which one ran.
4. `AuthService.login()` returns `{ accessToken, refreshToken, user }`. Access token payload must include `sub` (user id), `tenantId`, `branchId`, `role`.
5. Refresh token rotation: store a hashed refresh token per session; invalidate the old one on every refresh; detect reuse of an already-rotated token as a possible compromise and revoke the whole session chain.
6. Build `@Roles(...roles: string[])` decorator + `RolesGuard`: reads the authenticated user's role from the JWT payload, throws `ForbiddenException` if not in the allowed list.
7. Apply `@Roles()` to at least one real endpoint from another module as a working example (e.g. checkout should require `receptionist` or `branch_manager`) — coordinate with whoever builds `OrderModule`/`PaymentModule` on the exact roles.

## Role hierarchy to test against
`super_admin > org_owner > branch_manager > receptionist/waiter/kitchen_staff > customer`

## Verifying a token outside an HTTP request (implemented)

`AuthModule` exports its own `JwtModule` registration, so any module that must verify a token itself can inject `JwtService` and verify against the same secret and expiry config. This exists for the KDS WebSocket gateway, which authenticates its own handshake rather than relying on `JwtAuthGuard`.

Do **not** call `JwtModule.register(...)` again in a consuming module. Two registrations are two copies of the secret to keep in sync, and the day they drift, sockets reject tokens the HTTP API accepts.

Note that verifying a signature is not the same as checking a live session: nothing here re-reads `user_sessions` per request, so a revoked access token stays valid until it expires (15m by default). That applies equally to HTTP and to sockets, and is the accepted trade-off.

## Acceptance Criteria (write tests for these)
- Each strategy validates correctly in isolation with valid and invalid credentials.
- `RolesGuard` blocks/allows correctly for every role in the hierarchy against a sample protected route.
- Refresh token rotation correctly invalidates the previous token.
- Reuse of a rotated refresh token is detected and the session is revoked.
- Login is tenant-scoped: same email in two different tenants are distinct accounts (matches `UNIQUE (tenant_id, email)` in the schema).
