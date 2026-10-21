-- Notification preferences on the customer record.
--
-- WHY HERE
--
-- SMS/email/push are all addressed to a CUSTOMER, and `customers` (006) is the
-- only tenant-scoped place that already holds the phone and email. A separate
-- `notification_preferences` table would let one exist without the other (and
-- would need its own RLS policy); a column cannot. `notification_opt_out` is
-- the one flag the notification module must read before enqueuing anything
-- customer-facing.
--
-- `notification_channel` is a PREFERENCE, not a guarantee: a customer may pick
-- push before installing the app, or choose email before giving an address.
-- NotificationService treats it as "try this first, then the other channels
-- that have a contact". NULL means no preference, which falls back to push if
-- a device token exists, then SMS, then email.
--
-- `push_token` is the latest device registration from the (future) customer
-- app. One token per customer is deliberately simple: multi-device delivery
-- needs a token table with per-device lifecycle, and nothing in the product
-- registers a device yet. Storing it here lets the `ready` listener route to
-- push as soon as the app starts writing it.
--
-- RLS: `customers` already has the tenant-isolation policy from migration 010,
-- so adding columns does not change what any policy sees. No new table, no new
-- policy.

ALTER TABLE customers
    ADD COLUMN notification_opt_out BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN notification_channel VARCHAR(20),
    ADD COLUMN push_token TEXT;

-- A typo'd preference must not silently become "no preference": reject
-- anything that is not one of the three channels the factory knows. NULL is
-- allowed and means "no preference".
ALTER TABLE customers
    ADD CONSTRAINT customers_notification_channel_check
    CHECK (notification_channel IS NULL
           OR notification_channel IN ('sms', 'email', 'push'));

COMMENT ON COLUMN customers.notification_opt_out IS
    'When true, no customer-facing notification is queued, regardless of channel.';
COMMENT ON COLUMN customers.notification_channel IS
    'Preferred channel (sms/email/push); NULL means choose from available contacts.';
COMMENT ON COLUMN customers.push_token IS
    'Latest push registration token; NULL when the customer has no app device.';
