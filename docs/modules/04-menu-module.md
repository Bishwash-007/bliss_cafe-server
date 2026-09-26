# Agent Prompt: MenuModule

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Read `db/migrations/005_menu.sql` before writing code — note that `branch_id` is nullable on both `menu_categories` and `menu_items`: `NULL` means org-wide, a value means branch-specific.

## Scope
Menu categories, items, and modifiers (size, sugar level, add-ons). Must support both org-wide menus and per-branch overrides without a schema change — that decision is still open on the business side, so the code needs to work either way.

## Design Patterns

**Composite** — a category "contains" items; callers (admin UI, customer app, KDS) should be able to treat a whole menu tree (categories → items → modifiers) uniformly when rendering, exporting, or searching.

**Decorator** — a modifier decorates a base menu item's price and description without the base item needing to know about every possible modifier combination up front. This is what lets "Large, oat milk, extra shot" stack cleanly instead of requiring a combinatorial explosion of pre-defined variants.

## Task

1. Define a `MenuNode` interface with a `render()` method (or equivalent), implemented by both `MenuCategory` (holds child `MenuItem[]`) and `MenuItem` (leaf node).
2. `MenuService.getFullMenu(branchId)`:
   - Fetch org-wide categories/items (`branch_id IS NULL`).
   - Fetch branch-specific overrides (`branch_id = :branchId`).
   - Merge: a branch-specific item with the same name/category as an org-wide item replaces it in the final tree. **Document this merge rule explicitly in code comments** — it's a business decision as much as a technical one, and whoever resolves the open per-branch-vs-org-wide question needs to see it spelled out.
3. Define `PricedMenuItem` (base item, `getPrice()` returns `menu_items.price`) and a `ModifierDecorator` that wraps it, reading `extra_price` from `menu_item_modifiers`. Multiple modifiers stack by wrapping the same base item repeatedly.
4. CRUD endpoints: `org_owner`/`branch_manager` can create/update/delete; all authenticated staff can read. Customers read via a separate public-facing endpoint (no auth, but still tenant + branch scoped).
5. Soft-delete items (`is_available = false`) rather than hard delete, since historical orders reference `menu_item_id`.

## Acceptance Criteria (write tests for these)
- An org-wide item with a branch-specific override resolves to the override when fetching that branch's menu, and to the org-wide version everywhere else.
- Stacking three modifiers on one base item produces the mathematically correct total price.
- The Composite tree renders correctly for zero categories, one category with no items, and a nested multi-category menu.
- Deleting (soft-deleting) a menu item does not break historical `order_items` that reference it.
