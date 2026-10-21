import { UnsupportedPayTypeException } from '../exceptions/staff.exceptions';
import type { WageCalculationStrategy } from './wage-calculation.strategy';
import {
  DEFAULT_WAGE_STRATEGY,
  WAGE_CALCULATION_STRATEGIES,
  WageStrategyRegistry,
} from './wage-strategy.registry';

/** A strategy that does nothing but answer to a name. */
function fakeStrategy(name: string): WageCalculationStrategy {
  return {
    name,
    calculate: () => 0,
  };
}

describe('WageStrategyRegistry', () => {
  describe('resolution', () => {
    it('returns the strategy registered under a pay type', () => {
      const hourly = fakeStrategy('hourly');
      const registry = new WageStrategyRegistry([hourly]);

      expect(registry.strategyFor('hourly')).toBe(hourly);
    });

    it('lists every registered name, in registration order', () => {
      const registry = new WageStrategyRegistry([
        fakeStrategy('hourly'),
        fakeStrategy('salaried'),
      ]);

      expect(registry.names).toEqual(['hourly', 'salaried']);
    });

    it('refuses a pay type with no strategy rather than guessing', () => {
      const registry = new WageStrategyRegistry([fakeStrategy('hourly')]);

      // A fallback here would pay a salaried manager an HOURLY rate, which is
      // a wrong number on a payslip. A refusal is much better than that.
      expect(() => registry.strategyFor('salaried')).toThrow(
        UnsupportedPayTypeException,
      );
    });

    it('names the supported pay types when it refuses one', () => {
      const registry = new WageStrategyRegistry([fakeStrategy('hourly')]);

      expect(() => registry.strategyFor('tip_pooled')).toThrow(/hourly/);
    });
  });

  describe('the default strategy', () => {
    it('falls back to the default when the pay type is absent', () => {
      const hourly = fakeStrategy(DEFAULT_WAGE_STRATEGY);
      const registry = new WageStrategyRegistry([hourly]);

      expect(registry.strategyForOrDefault(null)).toBe(hourly);
      expect(registry.strategyForOrDefault(undefined)).toBe(hourly);
      expect(registry.strategyForOrDefault('')).toBe(hourly);
    });

    it('still refuses an unknown pay type', () => {
      const registry = new WageStrategyRegistry([fakeStrategy('hourly')]);

      // "Unknown" and "absent" are different things, and only one of them may
      // be papered over with a default.
      expect(() => registry.strategyForOrDefault('salaried')).toThrow(
        UnsupportedPayTypeException,
      );
    });
  });

  describe('construction', () => {
    it('refuses to start when two strategies claim one name', () => {
      expect(
        () =>
          new WageStrategyRegistry([
            fakeStrategy('hourly'),
            fakeStrategy('hourly'),
          ]),
      ).toThrow(/must be unique/);
    });

    it('refuses to start when no strategy claims the default name', () => {
      // The alternative is a running system where nobody is ever paid, because
      // a token was refactored away and the failure only shows up on a pay run.
      expect(
        () => new WageStrategyRegistry([fakeStrategy('salaried')]),
      ).toThrow(/must be registered/);
    });

    it('refuses to start with no strategies at all', () => {
      expect(() => new WageStrategyRegistry([])).toThrow(/must be registered/);
    });
  });

  describe('the injection token', () => {
    it('is a stable string every provider can agree on', () => {
      expect(typeof WAGE_CALCULATION_STRATEGIES).toBe('string');
    });
  });
});
