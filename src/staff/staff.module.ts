import { Module } from '@nestjs/common';
import { CLOCK, SystemClock } from './clock';
import {
  CLOCK_IN_WINDOW_MINUTES,
  ClockInPolicy,
  clockInWindowFromEnv,
} from './clock-in-policy';
import { HourlyWageStrategy } from './payroll/hourly-wage.strategy';
import type { WageCalculationStrategy } from './payroll/wage-calculation.strategy';
import {
  WAGE_CALCULATION_STRATEGIES,
  WageStrategyRegistry,
} from './payroll/wage-strategy.registry';
import { StaffController } from './staff.controller';
import { StaffRepository } from './staff.repository';
import { StaffService } from './staff.service';

/**
 * Every registered wage strategy, in registration order.
 *
 * The SINGLE list of strategies, spread into both `providers` and the
 * multi-provider factory's `inject`. Adding a strategy is one line in that
 * array — deliberately not "add it here and remember to add it there", which is
 * how a strategy ends up registered but never resolvable, or injectable but
 * absent from the registry.
 *
 * The same list lives in the inventory module for its reorder strategies, and
 * the reason is the same in both places: the registry resolves strategies by
 * name, so adding a class makes a new `pay_type` work without touching
 * `StaffService`, the controller, or any call site.
 */
const WAGE_STRATEGY_CLASSES = [HourlyWageStrategy] as const;

/**
 * # StaffModule
 *
 * Scheduling, attendance and payroll for a branch's staff.
 *
 * ## The seams
 *
 * Three of them, and each is data rather than code:
 *
 *  - `CLOCK` — the source of "now", so a request has one notion of it and a
 *    test can place events at chosen instants;
 *  - `CLOCK_IN_WINDOW_MINUTES` — how forgiving the clock-in check is, tuned
 *    per deployment from the environment;
 *  - `WAGE_CALCULATION_STRATEGIES` — the wage arithmetic, one class per way of
 *    paying people.
 *
 * None of them is a `switch` statement in the service, so none of them needs
 * the service to be edited to change.
 *
 * ## What this module does not import
 *
 * No other feature module. The auth module's roles are read through the
 * database, and the tenant scoping comes from `TenantRequestContext`. So a
 * unit test of the payroll arithmetic needs no Nest testing module at all —
 * which is the point of keeping the arithmetic behind an interface.
 */
@Module({
  controllers: [StaffController],
  providers: [
    StaffService,
    StaffRepository,
    WageStrategyRegistry,

    // The clock. One source of "now" for the whole module, so a single
    // request cannot see two different instants.
    SystemClock,
    { provide: CLOCK, useExisting: SystemClock },

    // The clock-in window is a policy value, not a constant, so it can be
    // tuned per deployment without a code change.
    { provide: CLOCK_IN_WINDOW_MINUTES, useFactory: clockInWindowFromEnv },
    ClockInPolicy,

    ...WAGE_STRATEGY_CLASSES,
    {
      provide: WAGE_CALCULATION_STRATEGIES,
      useFactory: (...strategies: WageCalculationStrategy[]) => strategies,
      inject: [...WAGE_STRATEGY_CLASSES],
    },
  ],
  // `StaffRepository` is deliberately NOT exported: data access stays internal
  // so a schema change cannot ripple out through the module boundary. Mirrors
  // the inventory module's rule.
  exports: [StaffService, WageStrategyRegistry],
})
export class StaffModule {}
