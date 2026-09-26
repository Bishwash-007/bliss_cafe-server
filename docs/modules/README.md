# Agent Prompts — Cafe SaaS Modules

One self-contained prompt per module, meant to be handed individually to a coding agent (Claude Code or similar) with repo access. Each file assumes the agent will read the relevant migration file(s) in `db/migrations/` before writing code.

## Build order (matters more than alphabetical/numeric file order)

1. `01-tenant-module.md` — foundation; everything else depends on tenant-scoped connections
2. `02-auth-module.md` — needed before any protected route exists
3. `03-org-branch-module.md` — needed before there's a tenant/branch to attach anything to
4. `04-menu-module.md`
5. `05-order-module.md` — **build before 06, 08, 10** — it defines the shared event bus they subscribe to
6. `06-inventory-module.md` — depends on Order's events
7. `07-staff-module.md`
8. `08-crm-module.md` — depends on Order's events
9. `09-payment-module.md`
10. `10-notification-module.md` — depends on Order's (and later Inventory's/CRM's) events
11. `11-reporting-module.md` — depends on data existing in the tables it reports on
12. `12-billing-module.md` — depends on Payment's provider abstraction

## Shared dependency warning

Modules 5, 6, 8, and 10 all plug into **one** event bus (`EventEmitter2`, published from `OrderModule`). If you run these as separate, isolated agent sessions, make sure whichever one runs first for real establishes that event bus, and paste its exact event names/payloads into the context for the others — otherwise each agent may invent its own.

Module 12 depends on Module 9's `PaymentProviderFactory` — don't let an agent working on Billing build a second Stripe/eSewa integration from scratch.
