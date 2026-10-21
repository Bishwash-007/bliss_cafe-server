import { Module } from '@nestjs/common';
import { PaymentModule } from '../payment';
import { BillingController } from './billing.controller';
import { BillingRepository } from './billing.repository';
import { BILLING_CLOCK, SystemBillingClock } from './clock';
import { DaysRemainingProrationStrategy } from './proration/days-remaining-proration.strategy';
import { PRORATION_STRATEGY } from './proration/proration.strategy';
import { SubscriptionRenewalScheduler } from './subscription-renewal.scheduler';
import { SubscriptionService } from './subscription.service';

/**
 * # BillingModule
 *
 * The SaaS platform charging the tenant for its subscription, as distinct from
 * `PaymentModule` charging the cafe's guests.
 *
 * ## Dependency direction
 *
 * `billing → payment`. The factory is imported through Payment's public barrel;
 * no gateway adapter, config cipher or `payments` table access is visible here.
 * Payment does not import billing, so there is no cycle.
 *
 * ## The seams
 *
 *  - `PRORATION_STRATEGY` — the plan-change arithmetic;
 *  - `BILLING_CLOCK` — the source of "now", so proration and due checks are
 *    testable without waiting for a day boundary;
 *  - `ScheduleModule` (registered at the app root) — the trigger for the daily
 *    sweep, not the sweep itself.
 *
 * ## Deliberate gap: no invoice ledger
 *
 * The schema has `tenant_subscriptions` but no `billing_invoices`/charge table,
 * so the gateway reference returned by a charge is reported to the caller but
 * not persisted. A production billing system that needs reconciliation should
 * add an invoice row (amount, period, provider reference, status) rather than
 * overloading `payments`, whose `order_id` is a hard FK to a cafe order. This is
 * flagged rather than pre-built because it is a schema decision with tax and
 * accounting consequences.
 */
@Module({
  imports: [PaymentModule],
  controllers: [BillingController],
  providers: [
    BillingRepository,
    SubscriptionService,
    SubscriptionRenewalScheduler,
    DaysRemainingProrationStrategy,
    SystemBillingClock,
    {
      provide: PRORATION_STRATEGY,
      useExisting: DaysRemainingProrationStrategy,
    },
    { provide: BILLING_CLOCK, useExisting: SystemBillingClock },
  ],
  exports: [SubscriptionService],
})
export class BillingModule {}
