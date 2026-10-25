# Agent Prompt: Broad Pagination

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Many list endpoints return unpaginated results (noted in `curl.md`). Add consistent pagination.

## Scope
Standardize pagination across high-volume lists (orders, inventory, staff, CRM, notifications, etc.), metadata, indexes.

## Design Patterns
- **DTO + Interceptor/Decorator**: shared pagination DTO and response wrapper
- **Strategy**: support page/limit and cursor-based where appropriate

## Task
1. **DTOs**: `PaginationQueryDto` (page/limit with defaults/caps), `PaginatedResponse<T>` with `data`, `total`, `page`, `limit`, `hasNext`
2. **Service layer**: add paginated methods, count queries optimized
3. **Apply incrementally**: start with orders/inventory/staff/crm/notifications/dead-letter; preserve existing behavior where specified
4. **Indexes**: add indexes for common sort/filter fields
5. **Docs**: update `curl.md` for paginated endpoints

## Acceptance Criteria
- [ ] Consistent response shape
- [ ] Limits enforced (max page size)
- [ ] Total counts correct
- [ ] Backward compatible where possible or clearly documented
- [ ] Performance acceptable with indexes
- [ ] Tests cover pagination
- [ ] `curl.md` updated

## Notes
- Cursor-based preferred for large real-time lists
