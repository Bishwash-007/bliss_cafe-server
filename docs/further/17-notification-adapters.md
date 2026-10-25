# Agent Prompt: Notification Adapters (Email/SMS/Push)

## Context
NestJS + PostgreSQL multi-tenant cafe SaaS. Notification module exists with BullMQ/in-memory queue, DLQ, retries, processors. Add concrete delivery adapters.

Read `src/notification/*` and `db/migrations/*notification*` if present.

## Scope
Email, SMS, Push adapters, templates, per-tenant config, bounces/webhooks, observability.

## Design Patterns
- **Strategy + Adapter**: `NotificationAdapter` interface with concrete implementations
- **Factory**: resolve adapter by channel/provider per tenant
- **Queue**: reuse existing BullMQ processor/retry/DLQ

## Task
1. **Interface**: `send(notification): Promise<DeliveryResult>` with normalized statuses
2. **Adapters**: Email (SES/SendGrid), SMS (Twilio/MSG91), Push (FCM/APNs)
3. **Templates**: template storage/rendering, variables
4. **Config**: per-tenant notification settings, provider credentials (encrypted)
5. **Webhooks**: bounce/complaint/delivery webhooks update status
6. **DLQ/metrics**: surface delivery status, retries, failures

## Acceptance Criteria
- [ ] Adapters behind interface, factory-based
- [ ] Reuse BullMQ queue/retries/DLQ
- [ ] Secrets encrypted, no PII in logs
- [ ] Bounce/complaint handling
- [ ] Tests for success/retry/failure
- [ ] `curl.md` updated

## Notes
- Fallback gracefully if provider not configured
