# Cafe Management System — Functional Requirements & System Design

**Type:** Multi-tenant SaaS
**Stack:** NestJS (API) · Next.js (Admin/Web) · React Native (Staff/Customer mobile) · PostgreSQL · Redis · Payment Gateway (Stripe/Razorpay/eSewa)

---

## 1. Functional Requirements

### 1.1 Platform / Tenant Management (SaaS layer)
- Cafe owners can sign up and create a new "Organization" (tenant), each with its own subdomain/slug (e.g. `beanhouse.yourapp.com`).
- Org onboarding wizard: cafe profile, branches/locations, menu import, staff invite.
- Subscription plans (Free/Starter/Pro) with feature gating (e.g. number of branches, staff seats, reporting depth).
- Platform super-admin dashboard: manage tenants, view usage, suspend/activate accounts, billing overview.
- Each tenant can have **multiple branches/locations** with shared or branch-specific menus, inventory, and staff.

### 1.2 Authentication & Authorization
- Email/password + OTP login for staff; social login optional for customers.
- Role-based access control (RBAC) with per-branch permission scoping (a manager at Branch A shouldn't edit Branch B's data unless given org-wide access).
- JWT access + refresh tokens; device-based session management for mobile.

**Role hierarchy:**
`SuperAdmin` (platform) → `OrgOwner` → `BranchManager` → `Receptionist` / `Cashier` → `Waiter` → `KitchenStaff` → `Customer`

| Role | Key permissions |
|---|---|
| OrgOwner/Manager | Manage branches, tables, menu & pricing, staff accounts, view sales dashboards, payment config |
| Receptionist | Checkout bills, generate payment QR, clear/free tables — no menu/staff edit rights |
| Waiter | Take & edit orders, mark table status, take payment at table (if enabled) |
| Kitchen Staff | View/update order prep status (KDS) only |
| Customer | Browse menu, place order, view own history/loyalty |

### 1.3 POS & Order Management
- Create orders: dine-in (table-based), takeaway, delivery.
- Menu with categories, modifiers/add-ons, variants (size, sugar level), combos.
- Order lifecycle: `Placed → Confirmed → Preparing → Ready → Served/Dispatched → Completed/Cancelled`.
- Kitchen Display System (KDS) view — real-time order queue for kitchen staff.
- Split bill, merge orders, apply discounts/coupons, tax calculation (VAT/service charge).
- Table management: table map, reservation, occupied/free status, clear/reset table after checkout.
- Checkout flow (Receptionist): finalize bill → generate a **dynamic payment QR** scoped to that order (amount pre-filled, short expiry) → poll/webhook confirms payment → auto-mark order paid and table free.
- Waiter can take payment directly at the table (optional, if enabled per tenant) in addition to counter checkout.

### 1.4 Inventory Management
- Ingredient/stock-item catalog with units (kg, litre, piece).
- Recipe mapping: menu item → ingredients consumed (for auto stock deduction).
- Low-stock alerts, reorder thresholds, purchase orders to suppliers.
- Stock-in (purchase/receiving), stock-out (wastage, usage), stock adjustment/audit.
- Supplier management (contacts, price history).

### 1.5 Staff Management
- Staff profiles, roles, branch assignment.
- Shift scheduling & rostering, attendance/clock-in-out (mobile geofenced or QR-based).
- Payroll basics: hours worked → wage calculation (optional export to payroll systems).
- Performance metrics: orders handled, average service time.

### 1.6 CRM & Loyalty
- Customer profiles (phone/email), order history.
- Loyalty points, punch cards, tiered memberships.
- Promotions/coupons, birthday offers, push notifications/SMS campaigns.
- Feedback/ratings post-order.

### 1.7 Payments
- Integration with payment gateway(s) — Stripe (global), eSewa/Khalti (Nepal), Razorpay (India) — pluggable per-tenant based on region.
- Support cash, card, wallet, QR payments.
- Split payment across methods; refunds; payment reconciliation report.
- Webhook handling for async payment confirmation.

### 1.8 Reporting & Analytics
- Sales reports (daily/weekly/monthly, per branch, per item).
- Inventory consumption & wastage reports.
- Staff performance & attendance reports.
- Tenant-level dashboard (for OrgOwner) and platform-level dashboard (for SuperAdmin).
- Export to CSV/PDF.

### 1.9 Customer-Facing (Mobile/Web)
- Browse menu, place order (pickup/delivery), track order status in real time.
- Loyalty balance, order history, reorder.
- Table QR-code self-ordering (scan → menu → order → pay).

---

## 2. System Design

### 2.1 High-Level Architecture

```
┌──────────────┐   ┌──────────────┐    ┌─────────────────┐
│  Next.js     │   │ React Native │    │ React Native    │
│  Admin/Web   │   │ Staff App    │    │ Customer App    │
└──────┬───────┘   └──────┬───────┘    └────────┬────────┘
       │                  │                     │
       └────────────┬─────┴──────────────┬──────┘
                    │   REST/GraphQL API │  WebSocket (orders/KDS)
                    ▼                    ▼
              ┌───────────────────────────────────┐
              │        NestJS API Gateway         │
              │  (Auth, Tenant Resolver, RBAC)    │
              └───────┬───────────┬────────────┬──┘
                      │           │            │
        ┌─────────────▼───┐  ┌────▼───────┐ ┌──▼──────────┐
        │ Order Module    │  │ Inventory  │ │ Staff/HR    │
        │ Menu Module     │  │ Module     │ │ Module      │
        └────────┬────────┘  └─────┬──────┘ └───────┬─────┘
                 │                 │                │
        ┌────────▼─────────────────▼────────────────▼─────┐
        │           PostgreSQL (multi-tenant DB)          │
        │        Redis (cache, queues, session)           │
        └─────────────────────────────────────────────────┘
                 │
        ┌────────▼─────────┐   ┌──────────────────┐
        │ Payment Gateway  │   │ Notification     │
        │ (Stripe/eSewa)   │   │ (SMS/Email/Push) │
        └──────────────────┘   └──────────────────┘
```

### 2.2 Multi-Tenancy Strategy

Since this is a SaaS serving many independent cafe businesses, pick one of:

| Approach | Description | Recommendation |
|---|---|---|
| **Shared DB, shared schema + `tenant_id`** | One Postgres DB, every table has `tenant_id` column, enforced via row-level security or query middleware | ✅ Best starting point — simplest ops, scales to hundreds of tenants, cheaper |
| **Schema-per-tenant** | One DB, separate Postgres schema per tenant | Good middle ground if tenants need stronger isolation later |
| **DB-per-tenant** | Fully isolated database per tenant | Only needed for large enterprise clients w/ compliance needs |

**Recommended for you:** Start with **shared schema + `tenant_id`**, using NestJS middleware/interceptor to auto-inject `tenant_id` on every query (via `nestjs-cls` or a custom `TenantContext` provider), and Postgres Row-Level Security (RLS) as a safety net against cross-tenant leaks.

### 2.3 Core Data Model (simplified)

```
Tenant (Org) ─┬─< Branch ─┬─< Table
              │           ├─< StaffAssignment
              │           ├─< InventoryStock
              │           └─< Order ─┬─< OrderItem ─< Modifier
              │                      └─< Payment
              ├─< User (Staff/OrgOwner) ─< Role
              ├─< MenuItem ─< Category
              ├─< Customer ─< LoyaltyAccount
              └─< Subscription ─< Plan
```

Every table (except platform-level `Tenant`, `Plan`) carries `tenant_id` as a foreign key + index.

### 2.4 NestJS Module Breakdown

- `AuthModule` — login, JWT, refresh, RBAC guards
- `TenantModule` — tenant resolution (via subdomain/header), tenant context
- `OrgModule` / `BranchModule` — org & branch CRUD
- `MenuModule` — categories, items, modifiers
- `OrderModule` — order lifecycle, KDS events (via WebSocket Gateway)
- `InventoryModule` — stock, recipes, purchase orders
- `StaffModule` — roster, attendance, payroll export
- `CrmModule` — customers, loyalty, promotions
- `PaymentModule` — gateway abstraction layer (strategy pattern per provider)
- `NotificationModule` — SMS/email/push (queued via BullMQ + Redis)
- `ReportingModule` — aggregated queries / materialized views for dashboards
- `BillingModule` — SaaS subscription & invoicing for tenants themselves

### 2.5 Real-Time Requirements
- **WebSocket Gateway (NestJS `@WebSocketGateway`)** for:
  - Kitchen Display System order push
  - Order status updates to customer app
  - Table status changes to POS/waiter app
- Use Redis adapter for WebSocket scaling across multiple NestJS instances.

### 2.6 Payment Integration Design
- Abstract `PaymentProvider` interface with implementations: `StripeProvider`, `EsewaProvider`, `RazorpayProvider`.
- Tenant configures which provider(s) are active (stored encrypted per-tenant in `TenantPaymentConfig`).
- Webhook endpoints per provider (`/webhooks/stripe`, `/webhooks/esewa`) verify signatures and update `Payment` + `Order` status asynchronously.
- **Dynamic QR checkout:** `PaymentProvider.generateQr(orderId, amount)` returns a short-lived QR payload (native support in eSewa/Khalti; for Stripe, generate a Payment Intent + render as QR pointing to a hosted checkout link). Order status moves to `AwaitingPayment` until the webhook confirms, then to `Paid`.

### 2.7 Offline Tolerance (Basic)
Local-first was scoped down to **basic offline tolerance** rather than a full offline-first architecture — simpler to build, no embedded local DB or conflict resolution needed:
- Staff/Waiter mobile app keeps a lightweight **local action queue** (e.g. AsyncStorage/MMKV) for actions taken while offline: place order, edit order, mark table status.
- On reconnect, queued actions are flushed to the API in order; each action carries a client-generated idempotency key so retries don't double-submit.
- UI shows a "pending sync" indicator on queued actions until server ack.
- Server treats these as normal API calls — no special sync endpoint or event log needed at this scope.
- **Not covered at this tier:** working through an extended outage, multi-device conflict resolution, or full menu/inventory browsing while offline (menu should be cached read-only, but stock levels won't reflect real-time changes until reconnect).

### 2.8 Infrastructure & Deployment
- **API:** NestJS on containers (Docker) behind a load balancer; horizontally scalable.
- **DB:** Managed PostgreSQL (e.g. RDS/Aiven) with read replica for reporting queries.
- **Cache/Queue:** Redis for sessions, BullMQ job queues (notifications, report generation).
- **Web:** Next.js deployed on Vercel or containerized; SSR for admin dashboard, static for marketing pages.
- **Mobile:** React Native (Expo or bare) — separate builds for Staff App and Customer App, or single app with role-based navigation.
- **File storage:** S3-compatible bucket for menu images, receipts.
- **Observability:** structured logging (Pino), centralized error tracking (Sentry), metrics (Prometheus/Grafana).

### 2.9 Security Considerations
- Tenant isolation enforced at both application (middleware) and DB (RLS) level — defense in depth.
- Rate limiting per tenant/API key.
- PCI-DSS scope minimized by never storing raw card data — delegate to gateway-hosted fields/tokens.
- Audit log for sensitive actions (discounts, refunds, stock adjustments).

---

## 3. Non-Functional Requirements

| NFR | How it's addressed |
|---|---|
| **High Availability** | Stateless NestJS instances behind a load balancer, horizontal auto-scaling; managed Postgres with read replica; Redis for shared session/queue state so any instance can serve any request |
| **Scalability** | Shared-schema multi-tenancy scales to hundreds of tenants on one DB; horizontal API scaling; move to schema-per-tenant or DB-per-tenant only if a large tenant needs stronger isolation |
| **Versatile** | Config-driven per-tenant: tax rules, currency, payment providers, and (pending your decision) per-branch vs org-wide menu/pricing — all modeled as tenant/branch-level settings, not hardcoded |
| **Responsive** | Next.js (web) + React Native (mobile) sharing a design-token/UI-kit layer; layouts adapt to tablet POS terminals, phones, and desktop admin dashboards |
| **Local First (basic offline tolerance)** | Client-side action queue with idempotency keys + retry-on-reconnect (see §2.7) — not full offline-first, scoped down per your call above |

## 4. Suggested Build Order (MVP → Full Suite)
1. Tenant/Auth/RBAC foundation
2. Menu + Branch + Table setup
3. POS/Order flow + KDS (core value prop)
4. Payment integration
5. Inventory + recipe deduction
6. Staff scheduling/attendance
7. CRM/Loyalty
8. Reporting/Analytics dashboards
9. SaaS billing/subscription layer for tenants