-- Birthday greetings need a birthday.
--
-- WHY HERE
--
-- `date_of_birth` belongs to the customer, exactly like phone and email, and
-- `customers` is already tenant-scoped and RLS-covered (migration 010). A
-- separate birthday table would be a second place to keep a customer's identity
-- and would let a customer exist without one.
--
-- WHY DATE, NOT TIMESTAMP
--
-- A birthday is a calendar day, not an instant. Storing it as `DATE` means
-- `2026-04-12` cannot drift to `2026-04-11T18:00:00Z` when a server in another
-- zone reads it, and no timezone conversion is applied on the way in or out.
--
-- WHICH CALENDAR
--
-- Matching is exact month/day in UTC today. A tenant-local calendar needs a
-- timezone on the tenant, which the schema does not have yet; until it does,
-- the campaign endpoint accepts an explicit `date` so an operator (or a later
-- scheduler) can choose the correct local day.
--
-- NULL means "not known", not "January 1". The index is partial so rows without
-- a birthday are not carried in it.

ALTER TABLE customers
    ADD COLUMN date_of_birth DATE;

COMMENT ON COLUMN customers.date_of_birth IS
    'Calendar date of birth; NULL when unknown. Used for birthday greetings only.';

CREATE INDEX customers_birthday_month_day_idx
    ON customers (
        tenant_id,
        (EXTRACT(MONTH FROM date_of_birth)),
        (EXTRACT(DAY FROM date_of_birth))
    )
    WHERE date_of_birth IS NOT NULL;
