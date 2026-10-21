import { Inject, Injectable, Logger } from '@nestjs/common';
import { UnsupportedPayTypeException } from '../exceptions/staff.exceptions';
import type { WageCalculationStrategy } from './wage-calculation.strategy';

/**
 * Multi-provider token: every registered strategy, in registration order.
 *
 * An array token rather than a single provider, because that is what makes "add
 * a new way of paying people" a data change instead of a code change: adding a
 * class to `providers` makes it resolvable by name immediately, with no edit to
 * the registry, the service, or any call site.
 */
export const WAGE_CALCULATION_STRATEGIES = 'WAGE_CALCULATION_STRATEGIES';

/**
 * Strategy used when a staff member's rate has no explicit pay type.
 *
 * Also the strategy a tenant gets if `staff_wage_rates.pay_type` is empty,
 * which cannot happen through the API — `pay_type` is NOT NULL with a default —
 * but which CAN happen for a row inserted by hand.
 */
export const DEFAULT_WAGE_STRATEGY = 'hourly';

/**
 * Resolves the strategy in force for a staff member's pay type.
 *
 * Every call site asks the registry, never a strategy directly. That is what
 * keeps the "add a strategy without touching the service" promise honest:
 * exactly one place decides which implementation runs, so a new strategy
 * cannot be added in a way that only some call sites honour.
 */
@Injectable()
export class WageStrategyRegistry {
  private readonly logger = new Logger(WageStrategyRegistry.name);
  private readonly byName: Map<string, WageCalculationStrategy>;

  constructor(
    @Inject(WAGE_CALCULATION_STRATEGIES)
    strategies: readonly WageCalculationStrategy[],
  ) {
    this.byName = new Map();
    for (const strategy of strategies) {
      // Two strategies claiming one name would make a stored `pay_type` resolve
      // to whichever the DI container happened to build last. That is a boot-time
      // bug, not a runtime one, so it is caught here rather than by a payroll
      // that quietly pays the wrong way.
      if (this.byName.has(strategy.name)) {
        throw new Error(
          `Two wage strategies are both named '${strategy.name}'. Strategy ` +
            `names must be unique, because 'staff_wage_rates.pay_type' stores ` +
            `the name.`,
        );
      }
      this.byName.set(strategy.name, strategy);
    }

    if (!this.byName.has(DEFAULT_WAGE_STRATEGY)) {
      // Deliberately fatal. The alternative is a running system where nobody is
      // ever paid, because a token was refactored away and the failure only
      // shows up on a pay run.
      throw new Error(
        `No wage strategy is named '${DEFAULT_WAGE_STRATEGY}'. It is the ` +
          `default and must be registered, or payroll cannot calculate ` +
          `anything.`,
      );
    }
  }

  /**
   * The names of every registered strategy, in registration order.
   *
   * Used to validate a `pay_type` when a rate is written, so an unsupported one
   * is refused at the point it is entered rather than at pay-run time.
   */
  get names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * The strategy for a pay type.
   *
   * Throws `UnsupportedPayTypeException` for a pay type with no strategy,
   * rather than falling back to the default. The fallback is the dangerous
   * choice: an unknown pay type would silently be paid at the hourly rate,
   * which is a WRONG number on a payslip. A refused payroll is a much better
   * outcome than a quietly incorrect one.
   */
  strategyFor(payType: string): WageCalculationStrategy {
    const strategy = this.byName.get(payType);
    if (!strategy) {
      throw new UnsupportedPayTypeException(payType, this.names);
    }
    return strategy;
  }

  /**
   * The strategy for a pay type, or the default when the pay type is empty.
   *
   * Only for a row that has no pay type at all. A pay type that is present but
   * unrecognised still throws — "unknown" and "absent" are different things,
   * and only one of them may be papered over with a default.
   */
  strategyForOrDefault(
    payType: string | null | undefined,
  ): WageCalculationStrategy {
    if (payType === null || payType === undefined || payType === '') {
      this.logger.warn(
        'A wage rate has no pay type; falling back to the default strategy.',
      );
      return this.byName.get(DEFAULT_WAGE_STRATEGY) as WageCalculationStrategy;
    }
    return this.strategyFor(payType);
  }
}
