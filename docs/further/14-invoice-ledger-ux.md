# Agent Prompt: Invoice Ledger UX

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Separate from customer payments (`PaymentModule`); this is for SaaS billing of the tenant (`BillingModule`). Read `db/migrations/002_tenants_and_plans.sql` and existing billing code.

## Scope
Invoice generation, numbering, line items, tax, PDF, email, history, reconciliation, and tenant-visible invoice ledger.

## Design Patterns
- **State**: invoice statuses (draft/issued/paid/void/refunded) with valid transitions
- **Factory/Service**: invoice generation on subscription events (create/renew/change/upgrade)

## Task
1. **Schema**: Add `invoices` (`id`, `tenant_id`, `subscription_id`, `invoice_no` unique per tenant/org, `currency`, `subtotal`, `tax_amount`, `total`, `status`, `issued_at`, `due_at`, `paid_at`, `voided_at`, `pdf_url`, `metadata`, timestamps) and `invoice_items` (`invoice_id`, `description`, `quantity`, `unit_amount`, `amount`, `type`).
2. **Numbering**: Implement invoice numbering (e.g. INV-YYYY-000123) per tenant/platform.
3. **Generation**: Auto-generate invoices on subscription lifecycle events; support manual generation.
4. **API**: `GET /billing/invoices`, `GET /billing/invoices/:id`, `GET /billing/invoices/:id/pdf`, `POST /billing/invoices/:id/email` (admin/owner only). Enforce subscription gating where appropriate but keep billing routes exempt per existing rules.
5. **PDF/Email**: Add PDF renderer (or provider) and email delivery (integrate with notification adapters when available).
6. **Reconciliation**: Link invoices to payments/charges; support void/refund with audit trail.

## Acceptance Criteria
- [ ] Invoice numbers unique and sequential per rules
- [ ] Totals = sum(line items) + tax correctly calculated
- [ ] Invoices generated on renewals/upgrades/changes
- [ ] PDF accessible with proper authz (tenant owner/admin)
- [ ] Paid invoices cannot be edited/voided improperly
- [ ] Tests cover generation, numbering, totals, status transitions
- [ ] `curl.md` updated

## Notes
- Keep charges through `PaymentProviderFactory` via BillingModule
- Tax rules may vary by region; make fields flexible
