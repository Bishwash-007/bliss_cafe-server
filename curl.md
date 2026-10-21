# Bliss Cafe API — curl cookbook

Every route below was read from the controllers on **2026-10-22**. Examples use
`http://localhost:3000`; change `BASE_URL` for another environment.

> This file is the API reference because the project does not currently expose
> Swagger/OpenAPI. It is intentionally a `curl` cookbook rather than a generated
> schema.

## Contents

1. [Conventions](#conventions)
2. [Shell setup](#shell-setup)
3. [Authentication](#authentication)
4. [Onboarding](#onboarding)
5. [Branches and tables](#branches-and-tables)
6. [Menu](#menu)
7. [Orders and KDS](#orders-and-kds)
8. [Checkout, payments and webhooks](#checkout-payments-and-webhooks)
9. [Inventory](#inventory)
10. [Staff](#staff)
11. [CRM: customers and promotions](#crm-customers-and-promotions)
12. [Notifications](#notifications)
13. [Reporting](#reporting)
14. [Billing](#billing)
15. [Platform](#platform)
16. [Errors and known API limitations](#errors-and-known-api-limitations)

---

## Conventions

### Base URL

```bash
export BASE_URL='http://localhost:3000'
```

### Tenant routing

Every route except `/onboarding`, `/platform/*`, and the public reads/webhooks
needs a tenant. Prove it with either:

- `X-Tenant-Id: <tenant UUID or slug>` — required for localhost and native clients.
- A subdomain, e.g. `beanhouse.api.example.com` → slug `beanhouse`.

The examples use `X-Tenant-Id` because it works everywhere.

```bash
export TENANT='beanhouse'   # slug or UUID
```

The tenant must exist and have `tenants.status = 'active'`; otherwise:

- `404` — tenant not found.
- `403` — tenant suspended/cancelled.

`/platform/*` skips tenant resolution. Onboarding also skips it because the
tenant does not exist yet.

### System route

```bash
curl -sS "$BASE_URL/" \
  -H "X-Tenant-Id: $TENANT"
```

Returns the plain-text string `Hello World!`. This is not a liveness probe: it
still passes through tenant resolution, so it returns `404` without a valid
tenant.

### Authentication

Most routes use a bearer access token:

```http
Authorization: Bearer <accessToken>
```

Tokens come from `POST /auth/login` or `POST /auth/refresh`. Access tokens are
short-lived (`JWT_ACCESS_TTL`, default `15m`); refresh tokens rotate.

### Roles

The database vocabulary is:

`super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter`,
`kitchen_staff`, `customer`.

Not every route has a role restriction. In particular, some authenticated reads
only require a valid JWT; those are called out below.

### Request and response formats

- JSON requests use `Content-Type: application/json`.
- Webhooks use the provider's raw body and signature headers.
- Many resources return **raw database rows** in `snake_case`. Money fields from
  PostgreSQL `NUMERIC` columns commonly arrive as **strings** (`"29.00"`), while
  computed objects (auth, billing, reports) use `camelCase` numbers.
- There is no pagination on most list endpoints. `/customers` is capped at 200
  rows; `/notifications/dead-letter` defaults to 50 and is capped at 200.

### Error shape

Nest's default exception body is used:

```json
{
  "statusCode": 400,
  "message": "Human-readable message or array of messages",
  "error": "Bad Request"
}
```

---

## Shell setup

```bash
export BASE_URL='http://localhost:3000'
export TENANT='beanhouse'
export EMAIL='owner@example.com'
export PASSWORD='change-me'

# Log in (tenant required)
curl -sS -X POST "$BASE_URL/auth/login" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}"
```

The response looks like:

```json
{
  "accessToken": "eyJ...",
  "refreshToken": "opaque-token",
  "user": {
    "userId": "uuid",
    "tenantId": "uuid",
    "branchId": "uuid-or-null",
    "role": "org_owner",
    "email": "owner@example.com",
    "fullName": "Owner"
  }
}
```

Copy the tokens into shell variables:

```bash
export TOKEN='<accessToken>'
export REFRESH='<refreshToken>'
```

---

## Authentication

| Method | Path | Auth | Roles |
|---|---|---|---|
| `POST` | `/auth/login` | none (tenant required) | any active user |
| `POST` | `/auth/refresh` | refresh token (tenant required) | any |
| `POST` | `/auth/logout` | bearer + refresh token | any |
| `GET` | `/auth/me` | bearer | any |

### Log in

```bash
curl -sS -X POST "$BASE_URL/auth/login" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -d '{"email":"owner@example.com","password":"change-me"}'
```

### Refresh a token

```bash
curl -sS -X POST "$BASE_URL/auth/refresh" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

### Log out

Revokes the supplied refresh token. The access token is not blocklisted; it
expires naturally.

```bash
curl -sS -X POST "$BASE_URL/auth/logout" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"refreshToken\":\"$REFRESH\"}"
```

Response: `{"success":true}`

### Current user

```bash
curl -sS "$BASE_URL/auth/me" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Onboarding

| Method | Path | Auth | Roles |
|---|---|---|---|
| `POST` | `/onboarding` | none — public/pre-tenant | none |

Creates a tenant, first branch, optional default tables, owner account, and — if
`planId` is supplied — the initial subscription.

```bash
curl -sS -X POST "$BASE_URL/onboarding" \
  -H 'Content-Type: application/json' \
  -d '{
    "orgName": "Acme Cafe",
    "slug": "acme-cafe",
    "planId": "00000000-0000-4000-8000-000000000000",
    "firstBranch": {
      "name": "Acme Main",
      "address": "Kathmandu"
    },
    "defaultTables": 5,
    "owner": {
      "email": "owner@acme.test",
      "password": "a-strong-password"
    }
  }'
```

Required: `orgName`, `slug`, `firstBranch.name`, `owner.email`,
`owner.password`. `planId` is optional but a tenant onboarded without it has no
subscription and is unbilled.

Response (`201`):

```json
{
  "tenantId": "uuid",
  "slug": "acme-cafe",
  "branchId": "uuid",
  "tableIds": ["uuid"],
  "ownerUserId": "uuid"
}
```

Then log in with `X-Tenant-Id: acme-cafe`.

> **Current validation caveat:** onboarding is not guarded by a validation pipe.
> A body missing `firstBranch` currently produces `500`, and an empty/missing
> owner password is hashed as an empty password rather than rejected. Validate
> the payload before relying on this endpoint in production.

---

## Branches and tables

| Method | Path | Auth | Roles |
|---|---|---|---|
| `GET` | `/branches` | bearer | any authenticated role |
| `POST` | `/branches` | bearer | `super_admin`, `org_owner`, `branch_manager` |
| `PATCH` | `/branches/:id` | bearer | `super_admin`, `org_owner`, `branch_manager` |
| `DELETE` | `/branches/:id` | bearer | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/branches/:id/tables` | bearer | any authenticated role |
| `POST` | `/branches/:id/tables` | bearer | `super_admin`, `org_owner`, `branch_manager` |

`DELETE` deactivates the branch; it does not hard-delete it.

### List branches

```bash
curl -sS "$BASE_URL/branches" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a branch

```bash
curl -sS -X POST "$BASE_URL/branches" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Acme Lakeside",
    "address": "Lakeside, Pokhara",
    "phone": "+977-9800000000"
  }'
```

### Update a branch

All fields are optional; omitted fields are unchanged.

```bash
curl -sS -X PATCH "$BASE_URL/branches/<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Acme Lakeside (renamed)",
    "timezone": "Asia/Kathmandu"
  }'
```

### Deactivate a branch

```bash
curl -sS -X DELETE "$BASE_URL/branches/<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### List tables

```bash
curl -sS "$BASE_URL/branches/<branchId>/tables" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Create a table

```bash
curl -sS -X POST "$BASE_URL/branches/<branchId>/tables" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"label":"T4","seats":4}'
```

---

## Menu

| Method | Path | Auth | Roles |
|---|---|---|---|
| `GET` | `/menu/public/:branchId` | none (tenant required) | public |
| `GET` | `/menu/branches/:branchId` | bearer | all staff roles |
| `GET` | `/menu/org-wide` | bearer | `super_admin`, `org_owner` |
| `POST` | `/menu/categories` | bearer | `super_admin`, `org_owner`, `branch_manager` |
| `POST` | `/menu/branches/:branchId/categories` | bearer | same |
| `POST` | `/menu/items` | bearer | same |
| `POST` | `/menu/branches/:branchId/items` | bearer | same |
| `POST` | `/menu/items/:itemId/modifiers` | bearer | same |
| `PATCH` | `/menu/items/:itemId` | bearer | same |
| `PATCH` | `/menu/items/:itemId/availability` | bearer | same |

A category/item created without `branchId` is org-wide; one created under
`/branches/:branchId` overrides just that branch. Prices are computed by the
server at order time.

### Public menu

```bash
curl -sS "$BASE_URL/menu/public/<branchId>" \
  -H "X-Tenant-Id: $TENANT"
```

### Staff branch menu

```bash
curl -sS "$BASE_URL/menu/branches/<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Org-wide template menu

```bash
curl -sS "$BASE_URL/menu/org-wide" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Create an org-wide category

```bash
curl -sS -X POST "$BASE_URL/menu/categories" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Coffee","sortOrder":1}'
```

### Create a branch category

```bash
curl -sS -X POST "$BASE_URL/menu/branches/<branchId>/categories" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Seasonal","sortOrder":2}'
```

### Create an org-wide item

```bash
curl -sS -X POST "$BASE_URL/menu/items" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Flat White",
    "price": 4.5,
    "description": "Double shot, steamed milk",
    "isAvailable": true,
    "categoryId": "<categoryId>"
  }'
```

### Create a branch item

```bash
curl -sS -X POST "$BASE_URL/menu/branches/<branchId>/items" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Lakeside Special",
    "price": 5.25,
    "isAvailable": true,
    "categoryId": "<categoryId>"
  }'
```

### Add a modifier variant

```bash
curl -sS -X POST "$BASE_URL/menu/items/<itemId>/modifiers" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Size","optionName":"Large","extraPrice":0.75}'
```

### Update an item

Accepts a partial item body (`name`, `price`, `description`, `isAvailable`,
`imageUrl`, `categoryId`).

```bash
curl -sS -X PATCH "$BASE_URL/menu/items/<itemId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"price":4.75,"description":"Updated description"}'
```

### Hide/show an item

This is the soft-delete path; the row survives for historic orders.

```bash
curl -sS -X PATCH "$BASE_URL/menu/items/<itemId>/availability" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"isAvailable":false}'
```

---

## Orders and KDS

| Method | Path | Auth | Roles |
|---|---|---|---|
| `POST` | `/orders` | bearer | `super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter` |
| `POST` | `/orders/:id/transition` | bearer | above + `kitchen_staff` |
| `GET` | `/orders/branches/:branchId/active` | bearer | any authenticated role |
| `GET` | `/orders/branches/:branchId` | bearer | any authenticated role |
| `GET` | `/orders/:id` | bearer | any authenticated role |

Order money is computed server-side from the menu. Do **not** send
`unitPrice`, `subtotal`, or `totalAmount`.

### Create an order

`clientActionId` is an idempotency key for offline/mobile retries.

```bash
curl -sS -X POST "$BASE_URL/orders" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "branchId": "<branchId>",
    "tableId": "<tableId>",
    "customerId": null,
    "orderType": "dine_in",
    "clientActionId": "mobile-queue-0001",
    "items": [
      {
        "menuItemId": "<menuItemId>",
        "quantity": 2,
        "notes": "no sugar",
        "modifiers": [
          {"name":"Size","optionName":"Large"}
        ]
      }
    ],
    "taxAmount": 0,
    "discountAmount": 0
  }'
```

`orderType` is one of `dine_in`, `takeaway`, `delivery`.
`tableId` is required for `dine_in`; menu items/modifiers are validated against
the tenant's current menu.

### Transition an order

```bash
curl -sS -X POST "$BASE_URL/orders/<orderId>/transition" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"status":"confirmed"}'
```

Allowed transition graph:

```text
placed           -> confirmed, cancelled
confirmed        -> preparing, cancelled
preparing        -> ready, cancelled
ready            -> served, cancelled
served           -> awaiting_payment, cancelled
awaiting_payment -> paid, cancelled
paid             -> completed
completed        -> (terminal)
cancelled        -> (terminal)
```

`paid` should normally be reached by payment settlement, not by a client
transition. `POST /orders/:id/checkout` moves the order to `awaiting_payment`.

### Active orders for a branch

This is the KDS snapshot: everything not `completed` or `cancelled`.

```bash
curl -sS "$BASE_URL/orders/branches/<branchId>/active" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### All orders for a branch

```bash
curl -sS "$BASE_URL/orders/branches/<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Get one order

```bash
curl -sS "$BASE_URL/orders/<orderId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### KDS WebSocket (not HTTP)

Namespace: `/kds` (Socket.IO). The access token goes in the handshake, never in
a query string.

```js
const socket = io(`${BASE_URL}/kds`, {
  auth: { token: accessToken, branchId }
});

socket.emit('kds:join', { branchId });
socket.on('kds:joined', (payload) => console.log(payload));
socket.on('order.status_changed', (event) => console.log(event));
socket.emit('kds:leave', { branchId });
```

Allowed roles: `super_admin`, `org_owner`, `branch_manager`, `receptionist`,
`waiter`, `kitchen_staff`. A branch-scoped user may only join their own branch;
tenant-wide users may join any branch in their tenant.

---

## Checkout, payments and webhooks

| Method | Path | Auth | Roles |
|---|---|---|---|
| `POST` | `/checkout` | bearer | `branch_manager`, `receptionist` |
| `POST` | `/orders/:id/checkout` | bearer | `super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter` |
| `GET` | `/payments/order/:orderId` | bearer | `super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter` |
| `POST` | `/payments/:id/refund` | bearer | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/payments/config` | bearer | `super_admin`, `org_owner` |
| `PUT` | `/payments/config/:provider` | bearer | `super_admin`, `org_owner` |
| `POST` | `/webhooks/stripe` | provider signature | public |
| `POST` | `/webhooks/esewa` | provider signature | public |
| `POST` | `/webhooks/razorpay` | provider signature | public |

### Legacy checkout demonstration

`POST /checkout` is an RBAC demonstration endpoint, not the real payment flow.
It returns `202 Accepted` and echoes the authenticated staff member; use
`POST /orders/:id/checkout` to create a payment.

```bash
curl -sS -X POST "$BASE_URL/checkout" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Start checkout

Generates the tenant's active provider's QR/hosted-checkout payload and creates a
pending payment. The order is moved to `awaiting_payment` if it is not already.

```bash
curl -sS -X POST "$BASE_URL/orders/<orderId>/checkout" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
{
  "payment": { "id": "uuid", "status": "pending", "amount": "4.50" },
  "qr": {
    "provider": "stripe",
    "orderId": "uuid",
    "amount": 4.5,
    "format": "url",
    "data": "https://checkout.stripe.com/...",
    "expiresAt": null
  }
}
```

### List payments for an order

```bash
curl -sS "$BASE_URL/payments/order/<orderId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Refund a succeeded payment

```bash
curl -sS -X POST "$BASE_URL/payments/<paymentId>/refund" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Only a `succeeded` payment is refundable. A `pending`/`failed` provider refund
leaves the local payment as `succeeded` until the money is known to have moved.

### List payment provider configuration

Secrets are never returned; only provider and active flag.

```bash
curl -sS "$BASE_URL/payments/config" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Save and activate provider configuration

`provider` is `stripe`, `esewa`, or `razorpay`. Activating one deactivates the
others. Required config keys:

- **stripe**: `secretKey`, `webhookSecret`; optional `baseUrl`,
  `checkoutBaseUrl`, `currency`, `paymentMethod`. `paymentMethod` is optional for
  QR checkout but **required for direct server-side charges** (including billing
  plan changes).
- **esewa**: `merchantCode`, `secretKey`, `webhookSecret`; optional `baseUrl`,
  `currency`.
- **razorpay**: `keyId`, `keySecret`, `webhookSecret`; optional `baseUrl`,
  `currency`.

```bash
curl -sS -X PUT "$BASE_URL/payments/config/stripe" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "config": {
      "secretKey": "sk_test_...",
      "webhookSecret": "whsec_...",
      "currency": "usd",
      "paymentMethod": "pm_card_visa"
    },
    "isActive": true
  }'
```

`PAYMENT_CONFIG_ENCRYPTION_KEY` must be a 32-byte key, or this route fails safely.

### Webhooks

All three are public but tenant-scoped: set `X-Tenant-Id` (or use the tenant's
subdomain) so the signature is checked against that tenant's configured secret.
The raw body is preserved; do not let a proxy rewrite it.

Stripe:

```bash
curl -sS -X POST "$BASE_URL/webhooks/stripe" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -H 'stripe-signature: t=<timestamp>,v1=<hmac>' \
  --data-binary @stripe-event.json
```

eSewa:

```bash
curl -sS -X POST "$BASE_URL/webhooks/esewa" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -H 'x-esewa-signature: <hmac-hex>' \
  --data-binary @esewa-event.json
```

Razorpay:

```bash
curl -sS -X POST "$BASE_URL/webhooks/razorpay" \
  -H "X-Tenant-Id: $TENANT" \
  -H 'Content-Type: application/json' \
  -H 'x-razorpay-signature: <hmac-hex>' \
  --data-binary @razorpay-event.json
```

Webhook handling is idempotent. A replay of an already-settled payment returns
success with `duplicate: true` and does not publish a second `order.paid`.

---

## Inventory

All inventory routes require a bearer token.

Write roles: `super_admin`, `org_owner`, `branch_manager`.
Read roles: above + `receptionist`, `kitchen_staff`.

| Method | Path | Roles |
|---|---|---|
| `POST` | `/inventory/suppliers` | write |
| `GET` | `/inventory/suppliers` | read |
| `GET` | `/inventory/suppliers/:id` | read |
| `PATCH` | `/inventory/suppliers/:id` | write |
| `DELETE` | `/inventory/suppliers/:id` | write |
| `POST` | `/inventory/items` | write |
| `GET` | `/inventory/items?branchId=` | read |
| `GET` | `/inventory/items/:id` | read |
| `POST` | `/inventory/items/:id/stock-in` | write |
| `POST` | `/inventory/items/:id/adjust` | write |
| `GET` | `/inventory/items/:id/movements` | read |
| `PATCH` | `/inventory/items/:id/reorder-threshold` | write |
| `POST` | `/inventory/recipes/ingredients` | write |
| `DELETE` | `/inventory/recipes/ingredients/:id` | write |
| `GET` | `/inventory/discrepancies?status=` | read |

Branch managers are confined to their token's branch. Tenant-wide users naming a
branch must use a real branch in their tenant.

### Create a supplier

```bash
curl -sS -X POST "$BASE_URL/inventory/suppliers" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Kathmandu Dairy",
    "contactPhone": "+977-9800000000",
    "contactEmail": "orders@dairy.test"
  }'
```

### List suppliers

```bash
curl -sS "$BASE_URL/inventory/suppliers" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Get one supplier

```bash
curl -sS "$BASE_URL/inventory/suppliers/<supplierId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Update a supplier

Only supplied keys change; `null` clears a contact field.

```bash
curl -sS -X PATCH "$BASE_URL/inventory/suppliers/<supplierId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"contactPhone":null}'
```

### Delete a supplier

```bash
curl -sS -X DELETE "$BASE_URL/inventory/suppliers/<supplierId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Create an inventory item

```bash
curl -sS -X POST "$BASE_URL/inventory/items" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "branchId": "<branchId>",
    "name": "Whole milk",
    "unit": "l",
    "quantityOnHand": 12.5,
    "reorderThreshold": 5,
    "supplierId": "<supplierId>"
  }'
```

### List items

```bash
curl -sS "$BASE_URL/inventory/items?branchId=<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Get one item

```bash
curl -sS "$BASE_URL/inventory/items/<itemId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Receive stock

`quantity` is the counted amount received, not a delta.

```bash
curl -sS -X POST "$BASE_URL/inventory/items/<itemId>/stock-in" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"quantity":24,"note":"Delivery from Kathmandu Dairy"}'
```

### Adjust stock (stocktake)

`quantity` is a signed delta and `note` is mandatory.

```bash
curl -sS -X POST "$BASE_URL/inventory/items/<itemId>/adjust" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"quantity":-1.5,"note":"Spillage during prep"}'
```

### List stock movements

```bash
curl -sS "$BASE_URL/inventory/items/<itemId>/movements" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Set reorder threshold

```bash
curl -sS -X PATCH "$BASE_URL/inventory/items/<itemId>/reorder-threshold" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"reorderThreshold":8}'
```

### Attach a recipe ingredient

For a tenant-wide caller, supply `?branchId=`; a branch manager's own branch is
taken from their token.

```bash
curl -sS -X POST "$BASE_URL/inventory/recipes/ingredients?branchId=<branchId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "menuItemId": "<menuItemId>",
    "inventoryItemId": "<inventoryItemId>",
    "quantityUsed": 0.2
  }'
```

Response: `204 No Content`.

### Remove a recipe ingredient

```bash
curl -sS -X DELETE "$BASE_URL/inventory/recipes/ingredients/<recipeIngredientId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### List deductions with discrepancies

Defaults to `failed` + `partial`; pass an explicit status to include settled
rows.

```bash
curl -sS "$BASE_URL/inventory/discrepancies?status=failed" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Valid statuses: `pending`, `completed`, `partial`, `failed`.

---

## Staff

All routes are under a branch and require a bearer token.

| Method | Path | Roles |
|---|---|---|
| `POST` | `/branches/:branchId/shifts` | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/branches/:branchId/shifts` | above + `receptionist` |
| `GET` | `/branches/:branchId/shifts/:id` | same read |
| `PATCH` | `/branches/:branchId/shifts/:id` | write |
| `DELETE` | `/branches/:branchId/shifts/:id` | write |
| `POST` | `/branches/:branchId/attendance/clock-in` | all staff roles |
| `POST` | `/branches/:branchId/attendance/clock-out` | all staff roles |
| `GET` | `/branches/:branchId/roster?week=` | same read |
| `GET` | `/branches/:branchId/payroll?from=&to=` | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/branches/:branchId/payroll/export?from=&to=` | same |
| `PUT` | `/branches/:branchId/wage-rates/:userId` | same |
| `GET` | `/branches/:branchId/wage-rates/:userId` | same |

### Create a shift

```bash
curl -sS -X POST "$BASE_URL/branches/<branchId>/shifts" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "userId": "<staffUserId>",
    "startTime": "2026-10-23T08:00:00+05:45",
    "endTime": "2026-10-23T16:00:00+05:45"
  }'
```

### List shifts

```bash
curl -sS "$BASE_URL/branches/<branchId>/shifts" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Get one shift

```bash
curl -sS "$BASE_URL/branches/<branchId>/shifts/<shiftId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Update a shift

```bash
curl -sS -X PATCH "$BASE_URL/branches/<branchId>/shifts/<shiftId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"endTime":"2026-10-23T17:00:00+05:45"}'
```

### Delete a shift

```bash
curl -sS -X DELETE "$BASE_URL/branches/<branchId>/shifts/<shiftId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Response: `204 No Content`.

### Clock in / clock out

The staff member comes from the token, never the body.

```bash
curl -sS -X POST "$BASE_URL/branches/<branchId>/attendance/clock-in" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"shiftId":"<shiftId>"}'

curl -sS -X POST "$BASE_URL/branches/<branchId>/attendance/clock-out" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"shiftId":"<shiftId>"}'
```

Clock-in is accepted only inside `STAFF_CLOCK_IN_WINDOW_MINUTES` of the shift
start (default 30 minutes, symmetric).

### Roster

`week` is any date in the week; weeks run Monday–Sunday. Omit for the current
week.

```bash
curl -sS "$BASE_URL/branches/<branchId>/roster?week=2026-10-22" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Payroll

Supply both `from` and `to`, or neither. Dates are inclusive `YYYY-MM-DD`.

```bash
curl -sS "$BASE_URL/branches/<branchId>/payroll?from=2026-10-01&to=2026-10-15" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Payroll CSV export

```bash
curl -sS -OJ "$BASE_URL/branches/<branchId>/payroll/export?from=2026-10-01&to=2026-10-15" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Set a wage rate

Only the `hourly` strategy is currently registered.

```bash
curl -sS -X PUT "$BASE_URL/branches/<branchId>/wage-rates/<userId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"payType":"hourly","rate":350}'
```

### Get a wage rate

```bash
curl -sS "$BASE_URL/branches/<branchId>/wage-rates/<userId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

---

## CRM: customers and promotions

### Customers

| Method | Path | Roles |
|---|---|---|
| `POST` | `/customers` | `super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter` |
| `GET` | `/customers?phone=` | same |
| `PATCH` | `/customers/:id` | same |
| `GET` | `/customers/:id` | same |
| `GET` | `/customers/:id/loyalty` | same |
| `POST` | `/customers/birthdays/announce` | `super_admin`, `org_owner` |

Customer lookups are tenant-wide, not branch-scoped.

#### Find or create a customer by phone

Returns `200` in both cases; `created` says which happened.

```bash
curl -sS -X POST "$BASE_URL/customers" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "phone": "+9779800000000",
    "fullName": "Sita Sharma",
    "email": "sita@example.com",
    "dateOfBirth": "1994-08-17"
  }'
```

#### List or look up customers

```bash
# First 200 customers in the tenant
curl -sS "$BASE_URL/customers" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"

# Exact phone lookup
curl -sS "$BASE_URL/customers?phone=%2B9779800000000" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

#### Update a customer birthday

Only `dateOfBirth` is editable; `null` clears it.

```bash
curl -sS -X PATCH "$BASE_URL/customers/<customerId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"dateOfBirth":"1994-08-17"}'
```

#### Get a customer

```bash
curl -sS "$BASE_URL/customers/<customerId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

#### Get loyalty account

Creates the loyalty account lazily if the customer predates the module.

```bash
curl -sS "$BASE_URL/customers/<customerId>/loyalty" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

#### Announce birthdays

Omit `date` for today in UTC. This is a manual/cron entry point; it publishes
events to the notification queue.

```bash
curl -sS -X POST "$BASE_URL/customers/birthdays/announce" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"date":"2026-10-22"}'
```

Response: `{"date":"2026-10-22","published":3}`

### Promotions

| Method | Path | Roles |
|---|---|---|
| `POST` | `/promotions` | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/promotions?activeOnly=` | `super_admin`, `org_owner`, `branch_manager`, `receptionist`, `waiter` |
| `POST` | `/promotions/apply` | same read set |
| `GET` | `/promotions/:id` | same read set |
| `PATCH` | `/promotions/:id` | `super_admin`, `org_owner`, `branch_manager` |
| `POST` | `/promotions/:id/announce` | `super_admin`, `org_owner` |

#### Create a promotion

`discountType` is `percentage` or `flat`. `startsAt`/`endsAt` are ISO-8601
instants with an offset.

```bash
curl -sS -X POST "$BASE_URL/promotions" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "code": "DASHAIN10",
    "description": "10% off this week",
    "discountType": "percentage",
    "discountValue": 10,
    "startsAt": "2026-10-20T00:00:00+05:45",
    "endsAt": "2026-10-31T23:59:59+05:45",
    "isActive": true
  }'
```

#### List promotions

```bash
curl -sS "$BASE_URL/promotions?activeOnly=true" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

#### Apply a promotion at the till

```bash
curl -sS -X POST "$BASE_URL/promotions/apply" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"code":"DASHAIN10","subtotal":25.00}'
```

Response:

```json
{
  "promotionId": "uuid",
  "code": "DASHAIN10",
  "discountType": "percentage",
  "subtotal": 25,
  "discountAmount": 2.5,
  "total": 22.5
}
```

#### Get a promotion

```bash
curl -sS "$BASE_URL/promotions/<promotionId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

#### Update a promotion

Partial update; `null` removes `description` or a date bound.

```bash
curl -sS -X PATCH "$BASE_URL/promotions/<promotionId>" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"description":"Updated offer","isActive":false}'
```

#### Announce a promotion

Omit `customerIds` to target every customer.

```bash
curl -sS -X POST "$BASE_URL/promotions/<promotionId>/announce" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"customerIds":["<customerId>"]}'
```

Response: `{"promotionId":"uuid","code":"DASHAIN10","published":1}`

---

## Notifications

| Method | Path | Roles |
|---|---|---|
| `GET` | `/notifications/dead-letter?limit=` | `super_admin`, `org_owner`, `branch_manager` |

Failed notification jobs are visible here. There is deliberately no retry/delete
endpoint yet.

```bash
curl -sS "$BASE_URL/notifications/dead-letter?limit=50" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Response shape:

```json
{
  "driver": "bullmq",
  "count": 0,
  "dead_letters": []
}
```

With no `REDIS_URL` the driver falls back to an in-memory queue (development
only). Provider delivery is currently a logging stub.

---

## Reporting

| Method | Path | Roles |
|---|---|---|
| `GET` | `/branches/:branchId/reports/sales` | `super_admin`, `org_owner`, `branch_manager` |
| `GET` | `/branches/:branchId/reports/inventory-consumption` | same |
| `GET` | `/branches/:branchId/reports/staff-performance` | same |

Query parameters:

- `from` and `to` — required together, inclusive `YYYY-MM-DD`.
- `format` — `json` (default), `csv`, or `pdf`.

Branch managers may only request their own branch. `super_admin` and `org_owner`
may request any branch in the tenant.

### Sales report

```bash
curl -sS "$BASE_URL/branches/<branchId>/reports/sales?from=2026-10-01&to=2026-10-31" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

JSON response shape:

```json
{
  "type": "sales",
  "title": "Sales report",
  "branchId": "uuid",
  "range": {"from":"2026-10-01","to":"2026-10-31"},
  "summary": {
    "orderCount": 10,
    "itemCount": 22,
    "subtotal": 100,
    "discounts": 5,
    "tax": 13,
    "revenue": 108,
    "averageOrderValue": 10.8
  },
  "tables": [
    {
      "key": "daily",
      "title": "Revenue by day",
      "columns": [{"key":"date","label":"Date"}],
      "rows": []
    }
  ],
  "generatedAt": "2026-10-22T00:00:00.000Z"
}
```

Revenue counts orders in `paid` or `completed`; it is scoped by `created_at`.

### Inventory consumption report

```bash
curl -sS "$BASE_URL/branches/<branchId>/reports/inventory-consumption?from=2026-10-01&to=2026-10-31" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### Staff performance report

```bash
curl -sS "$BASE_URL/branches/<branchId>/reports/staff-performance?from=2026-10-01&to=2026-10-31" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### CSV and PDF

```bash
# CSV
curl -sS -OJ "$BASE_URL/branches/<branchId>/reports/sales?from=2026-10-01&to=2026-10-31&format=csv" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"

# PDF
curl -sS -OJ "$BASE_URL/branches/<branchId>/reports/sales?from=2026-10-01&to=2026-10-31&format=pdf" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

---

## Billing

Billing is the **tenant's SaaS subscription**, not guest payment. Every charge is
delegated to the tenant's configured `PaymentProviderFactory`.

| Method | Path | Roles |
|---|---|---|
| `GET` | `/billing/subscription` | `super_admin`, `org_owner` |
| `GET` | `/billing/plans` | same |
| `POST` | `/billing/subscription/actions` | same |
| `POST` | `/billing/subscription/change-plan` | same |

### Current subscription

```bash
curl -sS "$BASE_URL/billing/subscription" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

Response:

```json
{
  "id": "uuid",
  "tenantId": "uuid",
  "status": "active",
  "startedAt": "2026-10-01T00:00:00.000Z",
  "endsAt": "2026-10-31T00:00:00.000Z",
  "plan": {
    "id": "uuid",
    "name": "starter",
    "priceMonthly": 29,
    "maxBranches": 3,
    "maxStaff": 15
  }
}
```

### Available plans

Cheapest first.

```bash
curl -sS "$BASE_URL/billing/plans" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN"
```

### State-guarded actions

`POST /billing/subscription/actions` body:

```json
{"action":"upgrade","planId":"uuid"}
```

Allowed actions by status:

| Status | Actions |
|---|---|
| `trialing` | `upgrade`, `downgrade`, `renew`, `cancel` |
| `active` | `upgrade`, `downgrade`, `renew`, `cancel` |
| `past_due` | `retry_payment`, `cancel` |
| `cancelled` | none — terminal |

`upgrade`/`downgrade` require `planId`. `renew` and `retry_payment` take no
`planId`. Illegal actions are rejected before any provider call.

```bash
# Upgrade
curl -sS -X POST "$BASE_URL/billing/subscription/actions" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"upgrade","planId":"<planId>"}'

# Retry a failed payment
curl -sS -X POST "$BASE_URL/billing/subscription/actions" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"retry_payment"}'

# Cancel
curl -sS -X POST "$BASE_URL/billing/subscription/actions" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"action":"cancel"}'
```

Response:

```json
{
  "action": "upgrade",
  "subscription": { "...": "SubscriptionView" },
  "chargedAmount": 12.5,
  "creditedAmount": 0,
  "providerReference": "pi_..."
}
```

Proration uses a fixed 30-day cycle:
`(newPrice - oldPrice) * daysRemaining / 30`. Positive means charge; negative is
reported as a credit; zero makes no provider call. Downgrade credits are not
persisted or automatically applied to a future invoice.

### Change plan by price direction

Convenience route: derives `upgrade` or `downgrade` from the target price.

```bash
curl -sS -X POST "$BASE_URL/billing/subscription/change-plan" \
  -H "X-Tenant-Id: $TENANT" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"planId":"<planId>"}'
```

Renewal failures move the subscription to `past_due`; successful renewal extends
`ends_at` by 30 days. The daily sweep runs at 02:00 and uses row locks to prevent
double charging. It does not currently gate the tenant's other API access.

---

## Platform

> **Security warning:** `GET /platform/tenants` currently has **no authentication
> guard**. It returned tenant rows unauthenticated during local verification.
> Treat this as a bug and do not expose `/platform/*` publicly until it is fixed.
> The intended role is `super_admin`.

| Method | Path | Auth | Roles |
|---|---|---|---|
| `GET` | `/platform/tenants` | **none today** | intended `super_admin` |
| `GET` | `/platform/reports/overview` | bearer | `super_admin` |

### List all tenants (currently unprotected)

```bash
curl -sS "$BASE_URL/platform/tenants"
```

Response: `[{"id":"uuid","slug":"beanhouse","status":"active"}]`

### Platform overview report

`from`/`to` are optional, but must be supplied together. `format` is
`json|csv|pdf`.

```bash
curl -sS "$BASE_URL/platform/reports/overview?from=2026-10-01&to=2026-10-31" \
  -H "Authorization: Bearer $SUPER_ADMIN_TOKEN"
```

Platform reporting reads through `PLATFORM_POOL` to bypass RLS. In production,
configure `PLATFORM_DATABASE_*` with a role that has `BYPASSRLS` (or owns the
tables). Without that, the report fails safe with no cross-tenant orders.

---

## Errors and known API limitations

### Status codes used

| Code | Meaning |
|---|---|
| `200` | Successful read/action |
| `201` | Created (onboarding, branches, menu, orders) |
| `202` | Legacy `POST /checkout` acknowledgement |
| `204` | Successful delete or recipe write with no body |
| `400` | Invalid input, illegal state transition/action, bad report range |
| `401` | Missing/invalid access token |
| `403` | Role or branch-scope denial; inactive tenant |
| `404` | Missing tenant/resource; unknown route under a tenant |
| `409` | Conflict (e.g. duplicate provider reference/order already paid) |
| `500` | Unexpected server error; currently reachable via unvalidated onboarding bodies |

### Important limitations

- **No global `ValidationPipe`.** DTOs are mostly interfaces/plain classes; some
  routes validate manually, others can throw `500` on malformed JSON shapes.
- **No CORS setup on the HTTP app.** A browser frontend on another origin cannot
  call this API unless a proxy or reverse proxy adds CORS headers.
- **No Swagger/OpenAPI and no `/health` endpoint.** The container health check is
  a TCP connect; `GET /` itself passes through tenant resolution.
- **Raw rows.** Many responses expose database `snake_case` fields and numeric
  strings. Do not assume camelCase everywhere.
- **No pagination** on most list routes.
- **No rate limiting** on login, refresh, onboarding, or webhook endpoints.
- **`JWT_SECRET` has a development fallback.** Never run without setting it.
- **Migrations are init-only** in Docker (`/docker-entrypoint-initdb.d`). New
  migration files are not applied to an existing database volume automatically;
  a migration runner/version table is not present.
- **Billing has no invoice/charge ledger, no persisted credit balance, no
  card-on-file token, and no charge idempotency key.** Renewal is only truly
  unattended for providers/configurations that can charge server-side. Razorpay
  `charge` creates a gateway order (`pending`), so billing treats it as unpaid and
  moves the subscription to `past_due`.
- **A cancelled or past-due subscription does not block other tenant APIs.**
  Billing state is not consulted by orders, staff, inventory, reporting, etc.
- **Downgrades do not enforce the target plan's branch/staff limits.**
- **Customer/OTP flows are not implemented.** `validateOtp` returns `null`; the
  OTP strategy is a stub.
- **Notification delivery is a logging stub.** The queue, retry, and dead-letter
  mechanics exist; provider adapters do not.
- **Platform reporting requires a `BYPASSRLS`/owner role.** Otherwise it is empty
  rather than leaking data.
- **Legacy `POST /checkout` returns `202` but only points to the real checkout
  route.** Use `POST /orders/:id/checkout` for actual payments.
