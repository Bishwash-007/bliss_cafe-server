# Agent Prompt: OrderModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/006_orders.sql` before writing code — pay particular attention to the `client_action_id` column and its partial unique index, which is the idempotency mechanism for the mobile offline action queue.

## Scope
Order lifecycle (dine-in, takeaway, delivery), real-time Kitchen Display System (KDS) updates, table status changes. This module is the hub other modules react to — build it early, since Inventory, CRM, and Notification all depend on the event bus defined here.

## Design Patterns

**State** — an order's valid next steps genuinely differ by current status. `served → placed` should be structurally impossible, not just caught by an `if` check that someone might forget to add to a new endpoint later.

**Observer** — placing or updating an order needs to notify multiple independent subscribers (KDS display, customer app, inventory deduction, notifications) without `OrderService` importing or knowing about any of them directly. This is the shared event bus other modules plug into — **build this first and document the event names clearly**, since Inventory/CRM/Notification modules are written assuming it already exists.

## Task

1. **State pattern**: define an `OrderState` interface with one concrete class per status: `PlacedState`, `ConfirmedState`, `PreparingState`, `ReadyState`, `ServedState`, `AwaitingPaymentState`, `PaidState`, `CompletedState`, `CancelledState`. Each defines `allowedTransitions(): string[]`.
   - `OrderService.transition(orderId, newStatus)` looks up the current state's allowed transitions and throws `InvalidOrderTransitionException` if the target status isn't allowed.
   - Persist status as the existing plain string column — the State pattern lives entirely in application code, not the database schema.
2. **Observer pattern**: set up a domain event emitter (NestJS `EventEmitter2` is fine) and publish these events from `OrderService`:
   - `order.placed` — new order created
   - `order.status_changed` — any transition, with `{ orderId, previousStatus, newStatus, branchId }`
   - `order.paid` — status reaches `paid`
   Document these three event names and payloads clearly — other modules subscribe to them and should not need to read `OrderModule`'s internals to know the contract.
3. Build a WebSocket Gateway for KDS: pushes `order.status_changed` events to a room scoped by `branch_id`. Use the Redis adapter so this works correctly across multiple NestJS instances (per the system design doc).
4. Idempotent order creation: if `client_action_id` is provided and a matching row already exists for this tenant (the unique index already enforces this at the DB level), return the existing order instead of erroring. This is what makes offline-queue retries from the mobile app safe.
5. Table status side-effects: placing a dine-in order marks the table `occupied`; completing/cancelling frees it back to `free` (coordinate with whoever builds table-clearing in the Receptionist-facing endpoints).

## Acceptance Criteria (write tests for these)
- An illegal state transition is rejected with a clear error, for every status pair that should be illegal.
- A legal transition fires the correct event(s) with the correct payload.
- Duplicate `client_action_id` for the same tenant returns the original order, not a new one, and does not double-fire `order.placed`.
- WebSocket clients subscribed to a branch's KDS room receive `order.status_changed` events in real time; clients in a different branch's room do not.
- Table status updates correctly on order completion/cancellation.

## KDS socket authentication (implemented)

The KDS namespace is authenticated at the **handshake**, not per message. `KdsGateway.afterInit()` installs Socket.IO middleware that verifies the access token from `handshake.auth.token` (browsers) or the `Authorization: Bearer` header (kiosks/native), and stores the verified claims on `socket.data.identity`. An unverifiable token never becomes a connected socket — the client receives `connect_error`.

Consequences worth knowing before changing this code:

- **`tenantId` and `branchId` for a join always come from the token.** A `kds:join` body may *ask* for a branch; it can never *assert* one. A body `tenantId` that disagrees with the token is rejected rather than coerced, so a client pointed at the wrong deployment fails loudly.
- **Authorization is two checks on signed claims**: the role must be in `KDS_ROLES` (a `customer` token is excluded — the stream carries every open ticket in the branch), and a branch-scoped user (`branchId` set) may only watch their own branch. Tenant-wide staff (`branchId: null`) may watch any branch in their own tenant, and still no other tenant's.
- **The same secret verifies HTTP and sockets.** `AuthModule` exports its own `JwtModule` registration so the gateway reuses it; a second `JwtModule.register` would be a second copy of the secret to keep in sync, and the day they drift, sockets reject tokens the API accepts.
- **Known limit:** an access token is not re-checked against `user_sessions`, so deactivating staff does not eject an already-connected display until the token expires (15m by default). Closing that fully needs a per-message session check, which is a deliberate non-goal for a display that reconnects on its own.

## Commit-before-response (implemented, cross-cutting)

`TenantCommitInterceptor` (registered globally in `TenantModule`) ends the tenant transaction **before** Nest writes the response. This is not a micro-optimisation — it fixes a real read-after-write hole:

`TenantContextMiddleware` can only release the connection from the response's `finish`/`close` events, and both fire *after* the bytes are on the wire. That made the `COMMIT` fire-and-forget relative to the client, so a `200` could arrive while the commit was still in flight and the client's very next request — on a different pooled connection — could read pre-commit state. It showed up as an intermittent `400 cannot move from 'served' to 'paid'` in roughly one e2e run in three: the write was never lost, the acknowledgement simply outran it.

Two related invariants, both covered by tests in `tenant-scoped-connection.spec.ts`:

- **One statement at a time per connection.** A `TenantScopedConnection` wraps exactly one `pg` client, and a client cannot multiplex. `Promise.all` over one connection only "works" because `pg` queues internally — deprecated now, removed in pg@9 — and it decouples result delivery from the caller's ordering assumptions. The connection now serialises statements, and queues `COMMIT`/`ROLLBACK` last so it can never overtake an in-flight query.

