import { BILLING_CYCLE_DAYS, type BillingPlan } from '../billing.types';
import { DaysRemainingProrationStrategy } from './days-remaining-proration.strategy';

function plan(id: string, priceMonthly: number): BillingPlan {
  return {
    id,
    name: id,
    priceMonthly,
    maxBranches: 1,
    maxStaff: 5,
  };
}

describe('DaysRemainingProrationStrategy', () => {
  const strategy = new DaysRemainingProrationStrategy();

  it('charges the price difference for the remaining days on an upgrade', () => {
    // Hand calculation: (50 - 20) * 15 / 30 = 15.
    expect(strategy.calculate(plan('starter', 20), plan('pro', 50), 15)).toBe(
      15,
    );
  });

  it('charges the full difference on the first day of a cycle', () => {
    // (50 - 20) * 30 / 30 = 30.
    expect(
      strategy.calculate(
        plan('starter', 20),
        plan('pro', 50),
        BILLING_CYCLE_DAYS,
      ),
    ).toBe(30);
  });

  it('returns a negative amount (a credit) on a mid-cycle downgrade', () => {
    // (20 - 50) * 10 / 30 = -10.
    expect(strategy.calculate(plan('pro', 50), plan('starter', 20), 10)).toBe(
      -10,
    );
  });

  it('charges nothing when no days remain', () => {
    expect(strategy.calculate(plan('starter', 20), plan('pro', 50), 0)).toBe(0);
  });

  it('clamps a malformed day count to one cycle', () => {
    expect(strategy.calculate(plan('starter', 20), plan('pro', 50), 99)).toBe(
      30,
    );
    expect(strategy.calculate(plan('starter', 20), plan('pro', 50), -5)).toBe(
      0,
    );
  });

  it('rounds to whole cents', () => {
    // (30.05 - 20.01) * 7 / 30 = 2.34266..., which must become 2.34.
    expect(strategy.calculate(plan('a', 20.01), plan('b', 30.05), 7)).toBe(
      2.34,
    );
  });
});
