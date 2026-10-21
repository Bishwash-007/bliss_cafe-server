import { PointsPerCurrencyStrategy } from './points-per-currency.strategy';

describe('PointsPerCurrencyStrategy', () => {
  it('awards one point per 100 spent', () => {
    const strategy = new PointsPerCurrencyStrategy();

    expect(strategy.name).toBe('points_per_currency');
    expect(strategy.calculatePoints(100)).toBe(1);
    expect(strategy.calculatePoints(250.5)).toBe(2);
    expect(strategy.calculatePoints(1000)).toBe(10);
  });

  it('drops the fraction rather than rounding it up', () => {
    const strategy = new PointsPerCurrencyStrategy();
    // 99.99 has not reached the threshold; 199.99 has reached one, not two.
    expect(strategy.calculatePoints(99.99)).toBe(0);
    expect(strategy.calculatePoints(199.99)).toBe(1);
  });

  it('awards nothing for a zero or negative total', () => {
    const strategy = new PointsPerCurrencyStrategy();
    expect(strategy.calculatePoints(0)).toBe(0);
    expect(strategy.calculatePoints(-50)).toBe(0);
    expect(strategy.calculatePoints(Number.NaN)).toBe(0);
  });

  it('multiplies BEFORE flooring, so a bonus rule is not silently halved', () => {
    // 2 points per 100: 150 spent is 3 points. `floor(1.5) * 2` would be 2.
    const bonus = new PointsPerCurrencyStrategy(2, 100);

    expect(bonus.calculatePoints(150)).toBe(3);
    expect(bonus.calculatePoints(99.99)).toBe(1);
  });

  it('supports a different currency threshold', () => {
    const strategy = new PointsPerCurrencyStrategy(1, 10);

    expect(strategy.calculatePoints(10)).toBe(1);
    expect(strategy.calculatePoints(25)).toBe(2);
  });

  it('refuses a nonsensical configuration at construction time', () => {
    expect(() => new PointsPerCurrencyStrategy(-1)).toThrow(RangeError);
    expect(() => new PointsPerCurrencyStrategy(1, 0)).toThrow(RangeError);
    expect(() => new PointsPerCurrencyStrategy(Number.NaN)).toThrow(RangeError);
  });
});
