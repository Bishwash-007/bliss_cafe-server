# Agent Prompt: ReportingModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. This module is read-only against existing tables — no new schema should be needed beyond what's already in `db/migrations/`. If a report genuinely can't be built from existing tables, flag that explicitly rather than silently adding new columns/tables.

## Scope
Sales, inventory consumption, and staff performance reports; tenant-level and platform-level dashboards.

## Design Patterns

**Facade** — hide the complexity of multi-table aggregation queries (joining `orders`, `order_items`, `stock_movements`, `shifts`, etc.) behind simple calls like `ReportingFacade.getSalesReport(branchId, dateRange)`. Controllers should never construct raw aggregation SQL themselves.

**Template Method** — every report follows the same skeleton: fetch data → aggregate → format → export. Only the specifics of *what* to fetch and *how* to aggregate differ per report type; the skeleton itself should be un-overridable so a new report type can't accidentally skip a step.

## Task

1. Build `ReportingFacade` exposing: `getSalesReport(branchId, dateRange)`, `getInventoryConsumptionReport(branchId, dateRange)`, `getStaffPerformanceReport(branchId, dateRange)`. Each internally runs the necessary joins; none of the complexity leaks to controllers.
2. Build an abstract `ReportGenerator` base class with a `final generate(): Report` method calling, strictly in order: `fetchData()` → `aggregate()` → `format()` → `export(type: 'csv' | 'pdf')`. Concrete subclasses (`SalesReportGenerator`, `InventoryReportGenerator`, `StaffPerformanceReportGenerator`) override only `fetchData()` and `aggregate()` — the orchestration itself lives once, in the base class.
3. For the PDF export step, reuse whatever PDF generation approach the rest of the system already uses if one exists; otherwise keep it simple (a basic templated PDF is fine — this isn't the module to over-invest in polish).
4. Add a platform-level report (`super_admin` only) aggregating across tenants: active tenant count, total order volume, revenue by plan tier — this one intentionally does *not* go through tenant-scoped RLS, since it's a platform view.
5. If query performance becomes a real concern at scale (flag this rather than solving it speculatively), note where a materialized view or scheduled aggregation job would help — don't build one preemptively without a demonstrated need.

## Acceptance Criteria (write tests for these)
- `ReportingFacade` methods return correctly shaped, correctly aggregated data against a seeded order/inventory/shift history.
- The `ReportGenerator` template method cannot be broken by a subclass — verify a subclass can't skip or reorder the fetch/aggregate/format/export sequence.
- Sales figures in the report match a manually computed sum for the same seeded date range (a straightforward reconciliation test).
- The platform-level report correctly aggregates across multiple tenants and is inaccessible to non-`super_admin` roles.
