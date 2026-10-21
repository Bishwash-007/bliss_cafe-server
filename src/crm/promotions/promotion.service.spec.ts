import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import type { CrmClock } from '../clock';
import { CrmRepository } from '../crm.repository';
import type { PromotionRow } from '../crm.types';
import {
  DuplicatePromotionCodeException,
  InvalidInstantException,
  InvalidPromotionException,
  InvalidSubtotalException,
  PromotionExpiredException,
  PromotionInactiveException,
  PromotionNotFoundException,
  PromotionNotStartedException,
  UnsupportedDiscountTypeException,
} from '../exceptions/crm.exceptions';
import { FlatDiscountStrategy } from './flat-discount.strategy';
import { PercentageDiscountStrategy } from './percentage-discount.strategy';
import { PromotionService } from './promotion.service';

const NOW = new Date('2026-10-21T12:00:00Z');

class FixedClock implements CrmClock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return this.instant;
  }
}

function connection(): TenantScopedConnection {
  return { tenantId: 'tenant-1' } as unknown as TenantScopedConnection;
}

function promotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: 'promo-1',
    tenant_id: 'tenant-1',
    code: 'SPRING10',
    description: 'Ten percent off',
    discount_type: 'percentage',
    discount_value: '10.00',
    starts_at: null,
    ends_at: null,
    is_active: true,
    ...overrides,
  };
}

function makeService(now = NOW) {
  const repository = {
    insertPromotion: jest.fn(),
    listPromotions: jest.fn(),
    findPromotionById: jest.fn(),
    findPromotionByCode: jest.fn(),
    updatePromotion: jest.fn(),
  };
  const service = new PromotionService(
    repository as unknown as CrmRepository,
    new FixedClock(now),
  );
  return { service, repository };
}

describe('PromotionService.getStrategyFor', () => {
  it('selects the percentage strategy from discount_type alone', () => {
    const { service } = makeService();
    const strategy = service.getStrategyFor(
      promotion({ discount_type: 'percentage', discount_value: '12.50' }),
    );

    expect(strategy).toBeInstanceOf(PercentageDiscountStrategy);
    expect(strategy.apply(200)).toBe(25);
  });

  it('selects the flat strategy from discount_type alone', () => {
    const { service } = makeService();
    const strategy = service.getStrategyFor(
      promotion({ discount_type: 'flat', discount_value: '7.50' }),
    );

    expect(strategy).toBeInstanceOf(FlatDiscountStrategy);
    expect(strategy.apply(200)).toBe(7.5);
  });

  it('the same value means different money for the two types', () => {
    const { service } = makeService();

    expect(
      service
        .getStrategyFor(
          promotion({ discount_type: 'percentage', discount_value: '10' }),
        )
        .apply(50),
    ).toBe(5);
    expect(
      service
        .getStrategyFor(
          promotion({ discount_type: 'flat', discount_value: '10' }),
        )
        .apply(50),
    ).toBe(10);
  });

  it('refuses an unknown discount type instead of falling back', () => {
    const { service } = makeService();

    expect(() =>
      service.getStrategyFor(promotion({ discount_type: 'bogo' })),
    ).toThrow(UnsupportedDiscountTypeException);
  });
});

describe('PromotionService.apply', () => {
  it('prices a percentage promotion', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ discount_type: 'percentage', discount_value: '12.50' }),
    );

    const applied = await service.apply(connection(), {
      code: 'SPRING10',
      subtotal: 99.99,
    });

    expect(applied).toEqual({
      promotionId: 'promo-1',
      code: 'SPRING10',
      discountType: 'percentage',
      subtotal: 99.99,
      discountAmount: 12.5,
      total: 87.49,
    });
  });

  it('prices a flat promotion', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ discount_type: 'flat', discount_value: '15.00' }),
    );

    const applied = await service.apply(connection(), {
      code: 'SPRING10',
      subtotal: 40,
    });

    expect(applied.discountAmount).toBe(15);
    expect(applied.total).toBe(25);
  });

  it('normalises the code to uppercase before lookup', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(promotion());

    await service.apply(connection(), { code: '  spring10 ', subtotal: 10 });

    expect(repository.findPromotionByCode).toHaveBeenCalledWith(
      expect.anything(),
      'SPRING10',
    );
  });

  it('rejects an inactive promotion', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ is_active: false }),
    );

    await expect(
      service.apply(connection(), { code: 'SPRING10', subtotal: 10 }),
    ).rejects.toThrow(PromotionInactiveException);
  });

  it('rejects an expired promotion', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ ends_at: new Date('2026-10-20T00:00:00Z') }),
    );

    await expect(
      service.apply(connection(), { code: 'SPRING10', subtotal: 10 }),
    ).rejects.toThrow(PromotionExpiredException);
  });

  it('treats ends_at as exclusive — the promotion is over at that instant', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ ends_at: NOW }),
    );

    await expect(
      service.apply(connection(), { code: 'SPRING10', subtotal: 10 }),
    ).rejects.toThrow(PromotionExpiredException);
  });

  it('rejects a promotion that has not started', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({ starts_at: new Date('2026-10-22T00:00:00Z') }),
    );

    await expect(
      service.apply(connection(), { code: 'SPRING10', subtotal: 10 }),
    ).rejects.toThrow(PromotionNotStartedException);
  });

  it('accepts a promotion whose window contains now', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(
      promotion({
        starts_at: new Date('2026-10-21T00:00:00Z'),
        ends_at: new Date('2026-10-22T00:00:00Z'),
      }),
    );

    const applied = await service.apply(connection(), {
      code: 'SPRING10',
      subtotal: 10,
    });

    expect(applied.total).toBe(9);
  });

  it('reports an unknown code as not found', async () => {
    const { service, repository } = makeService();
    repository.findPromotionByCode.mockResolvedValue(null);

    await expect(
      service.apply(connection(), { code: 'NOPE', subtotal: 10 }),
    ).rejects.toThrow(PromotionNotFoundException);
  });

  it('refuses a negative or non-finite subtotal', async () => {
    const { service } = makeService();

    await expect(
      service.apply(connection(), { code: 'SPRING10', subtotal: -1 }),
    ).rejects.toThrow(InvalidSubtotalException);
    await expect(
      service.apply(connection(), {
        code: 'SPRING10',
        subtotal: Number.NaN,
      }),
    ).rejects.toThrow(InvalidSubtotalException);
  });
});

describe('PromotionService.create', () => {
  it('normalises the code and defaults isActive to true', async () => {
    const { service, repository } = makeService();
    repository.insertPromotion.mockImplementation(
      (_connection: TenantScopedConnection, input: unknown) =>
        Promise.resolve({
          ...promotion(),
          ...(input as Record<string, unknown>),
        }),
    );

    await service.create(connection(), {
      code: ' spring10 ',
      discountType: 'percentage',
      discountValue: 10,
    });

    expect(repository.insertPromotion).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        code: 'SPRING10',
        discountType: 'percentage',
        discountValue: 10,
        isActive: true,
      }),
    );
  });

  it('refuses an unsupported discount type at write time', async () => {
    const { service } = makeService();

    await expect(
      service.create(connection(), {
        code: 'BOGO',
        discountType: 'bogo',
        discountValue: 1,
      }),
    ).rejects.toThrow(UnsupportedDiscountTypeException);
  });

  it('refuses a percentage above 100', async () => {
    const { service } = makeService();

    await expect(
      service.create(connection(), {
        code: 'TOOMUCH',
        discountType: 'percentage',
        discountValue: 101,
      }),
    ).rejects.toThrow(InvalidPromotionException);
  });

  it('refuses a window that ends before it starts', async () => {
    const { service } = makeService();

    await expect(
      service.create(connection(), {
        code: 'BACKWARDS',
        discountType: 'flat',
        discountValue: 5,
        startsAt: '2026-10-22T00:00:00Z',
        endsAt: '2026-10-21T00:00:00Z',
      }),
    ).rejects.toThrow(InvalidPromotionException);
  });

  it('refuses an ISO timestamp with no explicit offset', async () => {
    const { service } = makeService();

    await expect(
      service.create(connection(), {
        code: 'LOCAL',
        discountType: 'flat',
        discountValue: 5,
        startsAt: '2026-10-22T00:00:00',
      }),
    ).rejects.toThrow(InvalidInstantException);
  });

  it('reports a duplicate code as a conflict, not a 500', async () => {
    const { service, repository } = makeService();
    repository.insertPromotion.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );

    await expect(
      service.create(connection(), {
        code: 'SPRING10',
        discountType: 'flat',
        discountValue: 5,
      }),
    ).rejects.toThrow(DuplicatePromotionCodeException);
  });
});
