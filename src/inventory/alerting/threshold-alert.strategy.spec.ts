import { ThresholdAlertStrategy } from './threshold-alert.strategy';
import type { InventoryItem } from '../inventory.types';

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: 'item-1',
    tenantId: 'tenant-1',
    branchId: 'branch-1',
    name: 'Whole milk',
    unit: 'l',
    quantityOnHand: 10,
    reorderThreshold: 5,
    supplierId: null,
    ...overrides,
  };
}

describe('ThresholdAlertStrategy', () => {
  const strategy = new ThresholdAlertStrategy();

  it('is named for the tenant-config key, not the class name', () => {
    // The name is what a tenant's saved choice is matched against, so it is part
    // of the persisted contract: renaming the class must not change it.
    expect(strategy.name).toBe('threshold');
  });

  it('does not alert above the threshold', () => {
    expect(strategy.shouldAlert(item({ quantityOnHand: 5.001 }))).toBe(false);
    expect(strategy.shouldAlert(item({ quantityOnHand: 6 }))).toBe(false);
  });

  it('alerts exactly AT the threshold', () => {
    // The regression this guards: `<` instead of `<=` leaves the item sitting at
    // its reorder point with no alert, so the reorder only fires if some unrelated
    // movement nudges the number down.
    expect(strategy.shouldAlert(item({ quantityOnHand: 5 }))).toBe(true);
  });

  it('alerts below the threshold', () => {
    expect(strategy.shouldAlert(item({ quantityOnHand: 4.999 }))).toBe(true);
    expect(strategy.shouldAlert(item({ quantityOnHand: 0 }))).toBe(true);
  });

  it('alerts on negative stock, which means the books are already wrong', () => {
    expect(strategy.shouldAlert(item({ quantityOnHand: -1 }))).toBe(true);
  });

  it('alerts on an item with no reorder point when stock is exhausted', () => {
    const neverReordered = item({ quantityOnHand: 0, reorderThreshold: 0 });
    expect(strategy.shouldAlert(neverReordered)).toBe(true);
  });

  it('does not alert on an item with no reorder point that still has stock', () => {
    // Threshold 0 means "do not reorder", which is a legitimate setting for
    // non-reorderable goods — so a positive level must stay silent.
    const neverReordered = item({ quantityOnHand: 1, reorderThreshold: 0 });
    expect(strategy.shouldAlert(neverReordered)).toBe(false);
  });

  it('is pure, so repeated calls cannot drift', () => {
    const subject = item({ quantityOnHand: 5 });
    expect(strategy.shouldAlert(subject)).toBe(true);
    expect(strategy.shouldAlert(subject)).toBe(true);
    expect(strategy.shouldAlert(subject)).toBe(true);
  });
});
