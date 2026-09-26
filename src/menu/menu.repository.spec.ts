import type { QueryResult, QueryResultRow } from 'pg';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { MenuRepository } from './menu.repository';

/**
 * The `pg` driver hands back `NUMERIC` columns as STRINGS ("3.50"), which is
 * invisible to every other test because mocks use real JS numbers. These specs
 * pin the DAL's promise that monetary columns arrive as `number`, so the pricing
 * decorator can never silently concatenate them.
 */

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

/** A `MenuItemRow` exactly as Postgres would hand it over. */
function rawItem(overrides: Record<string, unknown> = {}): QueryResultRow {
  return {
    id: ITEM_ID,
    tenant_id: T1,
    branch_id: null,
    category_id: null,
    name: 'Flat White',
    description: null,
    price: '3.50',
    is_available: true,
    image_url: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function connectionReturning(rows: QueryResultRow[]): TenantScopedConnection {
  return {
    query: jest.fn().mockResolvedValue({ rows } as QueryResult),
  } as unknown as TenantScopedConnection;
}

describe('MenuRepository numeric coercion', () => {
  let repo: MenuRepository;

  beforeEach(() => {
    repo = new MenuRepository();
  });

  it('returns item prices as numbers from findItems', async () => {
    const rows = await repo.findItems(
      connectionReturning([rawItem()]),
      T1,
      null,
    );

    expect(rows[0].price).toBe(3.5);
    expect(typeof rows[0].price).toBe('number');
  });

  it('returns item prices as numbers from findItemById', async () => {
    const row = await repo.findItemById(
      connectionReturning([rawItem()]),
      T1,
      ITEM_ID,
    );

    expect(row?.price).toBe(3.5);
  });

  it('returns item prices as numbers from createItem', async () => {
    const row = await repo.createItem(
      connectionReturning([rawItem()]),
      T1,
      null,
      null,
      { name: 'Flat White', price: 3.5 },
    );

    expect(row.price).toBe(3.5);
  });

  it('returns item prices as numbers from setAvailable', async () => {
    const row = await repo.setAvailable(
      connectionReturning([rawItem({ is_available: false })]),
      T1,
      ITEM_ID,
      false,
    );

    expect(row?.price).toBe(3.5);
    expect(row?.is_available).toBe(false);
  });

  it('returns item prices as numbers from updateItem', async () => {
    const row = await repo.updateItem(
      connectionReturning([rawItem({ price: '4.25' })]),
      T1,
      ITEM_ID,
      { price: 4.25 },
    );

    expect(row?.price).toBe(4.25);
  });

  it('returns modifier extra_price as numbers from findModifiersForItems', async () => {
    const grouped = await repo.findModifiersForItems(
      connectionReturning([
        {
          id: 'm1',
          tenant_id: T1,
          menu_item_id: ITEM_ID,
          name: 'Size',
          option_name: 'Large',
          extra_price: '0.75',
        },
      ]),
      T1,
      [ITEM_ID],
    );

    const modifiers = grouped.get(ITEM_ID) ?? [];
    expect(modifiers[0].extra_price).toBe(0.75);
    expect(typeof modifiers[0].extra_price).toBe('number');
  });

  it('returns modifier extra_price as numbers from addModifier', async () => {
    const row = await repo.addModifier(
      connectionReturning([
        {
          id: 'm1',
          tenant_id: T1,
          menu_item_id: ITEM_ID,
          name: 'Size',
          option_name: 'Large',
          extra_price: '0.75',
        },
      ]),
      T1,
      ITEM_ID,
      { name: 'Size', optionName: 'Large', extraPrice: 0.75 },
    );

    expect(row.extra_price).toBe(0.75);
  });

  it('sums stacked modifiers numerically rather than concatenating', () => {
    // the exact failure mode the coercion prevents: left-to-right `+` on the
    // raw driver strings yields one long non-numeric mess, not a total
    const asStrings = ['3.50', '0.75', '0.60', '0.40'];
    const concatenated = asStrings.reduce((a, b) => a + b);

    expect(typeof concatenated).toBe('string');
    expect(Number.isNaN(Number(concatenated))).toBe(true);
    expect(concatenated).not.toBe('5.25');

    const asNumbers = asStrings.map(Number);
    expect(asNumbers.reduce((a, b) => a + b)).toBeCloseTo(5.25, 2);
  });

  it('leaves null out of reach: a numeric column never yields NaN', async () => {
    const row = (
      await repo.findItems(
        connectionReturning([rawItem({ price: '0.00' })]),
        T1,
        null,
      )
    )[0];

    expect(row.price).toBe(0);
    expect(Number.isNaN(row.price)).toBe(false);
  });
});
