import { Module } from '@nestjs/common';
import {
  DefaultReorderStrategyConfig,
  REORDER_ALERT_STRATEGIES,
  REORDER_STRATEGY_CONFIG,
  ReorderStrategyRegistry,
} from './alerting/reorder-strategy.registry';
import { ThresholdAlertStrategy } from './alerting/threshold-alert.strategy';
import type { ReorderAlertStrategy } from './alerting/reorder-alert.strategy';
import { InventoryController } from './inventory.controller';
import { InventoryRepository } from './inventory.repository';
import { InventoryService } from './inventory.service';
import { OrderDeductionListener } from './listeners/order-deduction.listener';

/**
 * Every registered reorder strategy, in registration order. The one place a
 * strategy is added — see the note on `InventoryModule` below.
 */
const REORDER_STRATEGY_CLASSES = [ThresholdAlertStrategy] as const;

/**
 * # InventoryModule
 *
 * Reorder alerting is a Strategy here, and that is the only reason this module
 * needs a multi-provider array token instead of one strategy class.
 *
 * `REORDER_ALERT_STRATEGIES` collects every implementation, and
 * `ReorderStrategyRegistry` picks the one in force for a tenant. Adding a
 * `ConsumptionRateAlertStrategy` later means adding a class to `strategies` and
 * to `providers` — no edit to the service, the listener, or the controller, and
 * no `if` anywhere that has to remember to check for it.
 *
 * `DEFAULT_REORDER_STRATEGY` names the fallback, and the registry THROWS at boot
 * if no strategy claims that name. That is deliberate: the alternative is a
 * running system where low-stock alerts silently never fire because a token was
 * refactored away.
 *
 * `EventEmitterModule` is global (registered in `AppModule`) because Inventory,
 * Order, CRM and Notification all publish onto the same bus — a per-module
 * emitter would give each a private one, and the order events inventory
 * subscribes to would never arrive.
 *
 * `OrderModule` is deliberately NOT imported. The only coupling is the event
 * contract in `src/order/events/order-events.ts`, read through the public barrel
 * by `OrderDeductionListener`. Nothing in this module injects anything from the
 * order module, so an inventory unit test needs no Nest testing module at all.
 * `InventoryService` takes the tenant id from the event payload rather than from
 * the request context, because by the time a subscriber runs there is no request
 * left to read it from.
 *
 * `REORDER_STRATEGY_CLASSES` below is the SINGLE list of strategies, spread into
 * both `providers` and the multi-provider factory's `inject`. Adding a strategy
 * is one line in that array — deliberately not "add it here and remember to add
 * it there", which is how a strategy ends up registered but never resolvable, or
 * injectable but absent from the registry.
 */
@Module({
  controllers: [InventoryController],
  providers: [
    InventoryService,
    InventoryRepository,
    OrderDeductionListener,
    ...REORDER_STRATEGY_CLASSES,
    ReorderStrategyRegistry,
    // The `useClass` binding is what a future settings module replaces with a real
    // implementation; nothing else in the module has to change.
    {
      provide: REORDER_STRATEGY_CONFIG,
      useClass: DefaultReorderStrategyConfig,
    },
    {
      provide: REORDER_ALERT_STRATEGIES,
      useFactory: (...strategies: ReorderAlertStrategy[]) => strategies,
      inject: [...REORDER_STRATEGY_CLASSES],
    },
  ],
  // `InventoryRepository` is deliberately NOT exported: data access stays internal
  // so a schema change cannot ripple out through the module boundary. The barrel's
  // header says the same thing, and nothing outside `src/inventory` injects it.
  exports: [InventoryService, ReorderStrategyRegistry],
})
export class InventoryModule {}
