import { Module } from '@nestjs/common';
import { CRM_CLOCK, SystemClock } from './clock';
import { CrmRepository } from './crm.repository';
import { CrmService } from './crm.service';
import { CustomerController } from './customer.controller';
import { CrmEventPublisher } from './events/crm-event.publisher';
import { OrderPaidLoyaltyListener } from './listeners/order-paid.listener';
import { LOYALTY_ACCRUAL_STRATEGY } from './loyalty/loyalty-accrual.strategy';
import { PointsPerCurrencyStrategy } from './loyalty/points-per-currency.strategy';
import { PromotionController } from './promotion.controller';
import { PromotionService } from './promotions/promotion.service';

/**
 * # CrmModule
 *
 * Customers, loyalty points and promotions.
 *
 * ## The seams
 *
 *  - `LOYALTY_ACCRUAL_STRATEGY` — how points are earned. Bound to
 *    `PointsPerCurrencyStrategy`, the default rule. A tenant that wants a point
 *    per visit gets a class and a different binding; `CrmService` never
 *    branches on the rule.
 *  - `CRM_CLOCK` — the source of "now" for promotion validity, so a request
 *    has one notion of it and a test can stand before, inside and after a
 *    promotion window.
 *  - `PromotionService.getStrategyFor` — how a discount is calculated, chosen
 *    from `discount_type` alone.
 *
 * None of them is a `switch` in the caller.
 *
 * ## The Observer dependency
 *
 * `OrderPaidLoyaltyListener` subscribes to `order.paid`, and
 * `CrmEventPublisher` publishes `crm.promotion`/`crm.birthday` for Notification
 * to consume. `EventEmitterModule` is global (registered in `AppModule`), so
 * this module imports neither `OrderModule` nor `NotificationModule` — only the
 * order event contract, and that import is types and one string constant. A
 * CRM unit test therefore needs no Nest testing module and no order repository.
 *
 * ## What this module does not import
 *
 * Not `OrderModule`, not `StaffModule`, not the tenant module (which is
 * `@Global`). The tenant-scoped connection comes from `TenantRequestContext`,
 * and the listener uses `TenantConnectionService`, both from the global tenant
 * foundation.
 */
@Module({
  controllers: [CustomerController, PromotionController],
  providers: [
    CrmService,
    PromotionService,
    CrmRepository,
    CrmEventPublisher,
    OrderPaidLoyaltyListener,

    // One source of "now" for all promotion checks.
    SystemClock,
    { provide: CRM_CLOCK, useExisting: SystemClock },

    // The default accrual rule. A factory, not `useClass`: the strategy's
    // constructor takes numbers with defaults, and Nest would otherwise try to
    // resolve `Number` as a provider.
    {
      provide: LOYALTY_ACCRUAL_STRATEGY,
      useFactory: () => new PointsPerCurrencyStrategy(),
    },
  ],
  // `CrmRepository` is deliberately NOT exported: data access stays internal
  // so a schema change cannot ripple out through the module boundary. Same rule
  // as inventory and staff.
  exports: [CrmService, PromotionService],
})
export class CrmModule {}
