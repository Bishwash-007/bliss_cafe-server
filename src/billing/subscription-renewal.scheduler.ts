import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionService } from './subscription.service';

/**
 * # SubscriptionRenewalScheduler
 *
 * The cron trigger for the renewal sweep. It contains no billing logic: the
 * sweep lives in `SubscriptionService` so an operator (or a test) can run it on
 * demand through exactly the same path.
 *
 * ## Why daily, at 02:00
 *
 * The schema stores `ends_at` as an instant, not a due date. Running once a day
 * keeps a subscription whose period ended at 14:07 from waiting until 14:07 the
 * next day to be retried; 02:00 is a quiet hour for the platform. A deployment
 * with tenants across many time zones can justify hourly sweeps, but that is a
 * scheduling decision rather than a lifecycle rule.
 *
 * ## Failure isolation
 *
 * `renewDueSubscriptions` already catches per tenant and commits `past_due`
 * before moving on. This wrapper only prevents an unexpected top-level failure
 * (for example, the tenant list query failing) from bubbling into the
 * scheduler's unhandled-rejection path.
 */
@Injectable()
export class SubscriptionRenewalScheduler {
  private readonly logger = new Logger(SubscriptionRenewalScheduler.name);

  constructor(private readonly subscriptions: SubscriptionService) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM, {
    name: 'billing-subscription-renewal',
  })
  async runDailyRenewal(): Promise<void> {
    try {
      const summary = await this.subscriptions.renewDueSubscriptions();
      this.logger.log(
        `Billing renewal sweep: checked=${summary.checked} ` +
          `renewed=${summary.renewed} failed=${summary.failed} ` +
          `skipped=${summary.skipped}`,
      );
    } catch (error) {
      this.logger.error(
        `Billing renewal sweep could not run: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
