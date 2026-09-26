import {
  DefaultReorderStrategyConfig,
  ReorderStrategyRegistry,
  type ReorderStrategyConfig,
} from './reorder-strategy.registry';
import type { ReorderAlertStrategy } from './reorder-alert.strategy';
import type { InventoryItem } from '../inventory.types';

const item = { quantityOnHand: 1, reorderThreshold: 0 } as InventoryItem;

/** A strategy that alerts on everything, to prove WHICH one is being asked. */
function always(name: string): ReorderAlertStrategy {
  return { name, shouldAlert: () => true };
}

function never(name: string): ReorderAlertStrategy {
  return { name, shouldAlert: () => false };
}

const threshold = never('threshold');

describe('ReorderStrategyRegistry', () => {
  it('resolves the default when a tenant has configured nothing', () => {
    const registry = new ReorderStrategyRegistry(
      [threshold],
      new DefaultReorderStrategyConfig(),
    );
    expect(registry.forTenant('tenant-1')).toBe(threshold);
  });

  it('honours a tenant-specific choice over the default', () => {
    const config: ReorderStrategyConfig = { strategyFor: () => 'predictive' };
    const registry = new ReorderStrategyRegistry(
      [threshold, always('predictive')],
      config,
    );
    expect(registry.forTenant('tenant-1')).not.toBe(threshold);
    expect(registry.forTenant('tenant-1').shouldAlert(item)).toBe(true);
  });

  it('asks the config for the tenant, so per-tenant switching is data', () => {
    const strategyFor = jest.fn((tenantId: string) =>
      tenantId === 'tenant-2' ? 'predictive' : null,
    );
    const registry = new ReorderStrategyRegistry(
      [threshold, always('predictive')],
      { strategyFor },
    );
    expect(registry.forTenant('tenant-1')).toBe(threshold);
    expect(registry.forTenant('tenant-2').name).toBe('predictive');
    expect(strategyFor).toHaveBeenCalledWith('tenant-1');
    expect(strategyFor).toHaveBeenCalledWith('tenant-2');
  });

  it('falls back to the default when a tenant names a strategy that does not exist', () => {
    // A typo in tenant config must degrade to the default, not take reordering
    // offline by resolving to nothing.
    const registry = new ReorderStrategyRegistry([threshold], {
      strategyFor: () => 'typo',
    });
    expect(registry.forTenant('tenant-1')).toBe(threshold);
  });

  it('refuses to boot when two strategies claim the same name', () => {
    // Otherwise a tenant's saved choice resolves to whichever the container
    // happened to build last, which is not a bug anyone can reproduce.
    expect(
      () =>
        new ReorderStrategyRegistry([never('threshold'), always('threshold')], {
          strategyFor: () => null,
        }),
    ).toThrow(/Duplicate ReorderAlertStrategy name 'threshold'/);
  });

  it('refuses to boot when no strategy is named as the default', () => {
    // The failure mode this prevents is the dangerous one: a running system where
    // low-stock alerts silently never fire.
    expect(
      () =>
        new ReorderStrategyRegistry([always('predictive')], {
          strategyFor: () => null,
        }),
    ).toThrow(/No ReorderAlertStrategy named 'threshold' is registered/);
  });

  it('refuses to boot with no strategies at all', () => {
    expect(
      () => new ReorderStrategyRegistry([], new DefaultReorderStrategyConfig()),
    ).toThrow(/No ReorderAlertStrategy named 'threshold' is registered/);
  });

  it('lists the available names for a settings surface', () => {
    const registry = new ReorderStrategyRegistry(
      [threshold, always('predictive')],
      new DefaultReorderStrategyConfig(),
    );
    expect(registry.availableStrategies().sort()).toEqual([
      'predictive',
      'threshold',
    ]);
  });

  it('keeps every strategy resolvable once one is added alongside the default', () => {
    // The property that makes the array token worth the indirection: a new
    // strategy is registered, not substituted, so no tenant's behaviour changes
    // by another tenant's config.
    const registry = new ReorderStrategyRegistry(
      [threshold, always('predictive'), never('par')],
      { strategyFor: () => 'par' },
    );
    expect(registry.availableStrategies()).toHaveLength(3);
    expect(registry.forTenant('tenant-1').shouldAlert(item)).toBe(false);
    expect(registry.forTenant('other').shouldAlert(item)).toBe(false);
  });
});
