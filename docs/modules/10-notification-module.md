# Agent Prompt: NotificationModule

## Context
NestJS + Redis (BullMQ) multi-tenant cafe SaaS. **Depends on `OrderModule`'s event bus and, later, `InventoryModule`/`CrmModule`'s published events** — subscribe to these; do not create a second event system.

## Scope
SMS, email, and push notifications — queued and retried reliably, never blocking the request that triggered them.

## Design Patterns

**Factory** — `NotificationFactory.create(channel: 'sms' | 'email' | 'push')` picks the right concrete sender behind one call.

**Observer** — this module subscribes to domain events from other modules (`order.status_changed`, `inventory.low_stock`, CRM-emitted promo/birthday events) rather than being called directly and synchronously from business logic elsewhere.

## Task

1. Define a `NotificationChannel` interface: `send(recipient, message): Promise<void>`.
2. Implement `SmsChannel`, `EmailChannel`, `PushChannel` against that interface (stub the actual provider integration — e.g. Twilio/SendGrid/FCM — behind a clearly marked TODO if credentials aren't available yet; the interface and queueing logic should be fully real regardless).
3. Build `NotificationFactory.create(channel)` returning the right concrete implementation.
4. Register event listeners:
   - `order.status_changed` → when new status is `ready`, notify the customer via push (if they have a loyalty/customer account) or SMS (if only a phone number is on file).
   - `inventory.low_stock` (published by `InventoryModule`) → notify the branch manager via email.
   - Any CRM-published promo/birthday event → notify the customer via their preferred channel.
5. Use BullMQ + Redis: every send is enqueued, not sent inline in the event listener. Configure retry with exponential backoff for transient failures (e.g. 3 attempts). Failed-after-retries jobs should land in a dead-letter queue you can inspect, not silently disappear.
6. Respect a basic notification preference/opt-out per customer if one exists in the `customers` table (add a column via a new migration if not — `notification_opt_out boolean default false`).

## Acceptance Criteria (write tests for these)
- Each channel implementation conforms to the shared `NotificationChannel` interface (same method signature, same return type).
- A listener correctly maps each event type to the right channel and message content.
- A forced send failure is retried per the configured backoff, and lands in the dead-letter queue after exhausting retries.
- An opted-out customer does not receive a notification, even when a triggering event fires for them.
