import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import type { CrmClock } from '../clock';
import type { CrmRepository } from '../crm.repository';
import type { PromotionRow } from '../crm.types';
import type { PromotionService } from '../promotions/promotion.service';
import { InvalidCampaignException } from '../exceptions/crm.exceptions';
import { CRM_EVENTS } from './crm-events';
import { CrmEventPublisher } from './crm-event.publisher';

const NOW = new Date('2026-10-21T12:00:00Z');
const TENANT = 'tenant-1';
const CUSTOMER_A = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_B = '22222222-2222-4222-8222-222222222222';
const CUSTOMER_C = '33333333-3333-4333-8333-333333333333';

class FixedClock implements CrmClock {
  now(): Date {
    return NOW;
  }
}

function connection(): TenantScopedConnection {
  return { tenantId: TENANT } as unknown as TenantScopedConnection;
}

function promotion(overrides: Partial<PromotionRow> = {}): PromotionRow {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    tenant_id: TENANT,
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

function makePublisher() {
  const repository = {
    listAnnouncementTargets: jest.fn(),
    listBirthdayTargets: jest.fn(),
  };
  const promotions = {
    get: jest.fn(),
    assertUsable: jest.fn(),
  };
  const events = { emitAsync: jest.fn().mockResolvedValue([]) };
  const publisher = new CrmEventPublisher(
    repository as unknown as CrmRepository,
    promotions as unknown as PromotionService,
    new FixedClock(),
    events as unknown as EventEmitter2,
  );
  return { publisher, repository, promotions, events };
}

describe('CrmEventPublisher.announcePromotion', () => {
  it('publishes one event per customer, stamped once', async () => {
    const { publisher, repository, promotions, events } = makePublisher();
    const row = promotion();
    promotions.get.mockResolvedValue(row);
    repository.listAnnouncementTargets.mockResolvedValue([
      { id: CUSTOMER_A, full_name: 'Asha' },
      { id: CUSTOMER_B, full_name: null },
    ]);

    const result = await publisher.announcePromotion(connection(), row.id, {});

    expect(result).toEqual({
      promotionId: row.id,
      code: 'SPRING10',
      published: 2,
    });
    expect(promotions.assertUsable).toHaveBeenCalledWith(row, NOW);
    expect(repository.listAnnouncementTargets).toHaveBeenCalledWith(
      expect.anything(),
      undefined,
    );
    expect(events.emitAsync).toHaveBeenCalledTimes(2);
    expect(events.emitAsync).toHaveBeenNthCalledWith(1, CRM_EVENTS.promotion, {
      event: CRM_EVENTS.promotion,
      tenantId: TENANT,
      customerId: CUSTOMER_A,
      promotionId: row.id,
      code: 'SPRING10',
      description: 'Ten percent off',
      occurredAt: NOW.toISOString(),
    });
    expect(events.emitAsync).toHaveBeenNthCalledWith(
      2,
      CRM_EVENTS.promotion,
      expect.objectContaining({ customerId: CUSTOMER_B }),
    );
  });

  it('uses the supplied audience and deduplicates it', async () => {
    const { publisher, repository, promotions, events } = makePublisher();
    promotions.get.mockResolvedValue(promotion());
    repository.listAnnouncementTargets.mockResolvedValue([
      { id: CUSTOMER_A, full_name: null },
    ]);

    const result = await publisher.announcePromotion(connection(), 'promo', {
      customerIds: [CUSTOMER_A, CUSTOMER_A],
    });

    expect(result.published).toBe(1);
    expect(repository.listAnnouncementTargets).toHaveBeenCalledWith(
      expect.anything(),
      [CUSTOMER_A],
    );
    expect(events.emitAsync).toHaveBeenCalledTimes(1);
  });

  it('refuses a promotion that is not currently usable', async () => {
    const { publisher, repository, promotions, events } = makePublisher();
    promotions.get.mockResolvedValue(promotion());
    promotions.assertUsable.mockImplementation(() => {
      throw new Error('inactive');
    });

    await expect(
      publisher.announcePromotion(connection(), 'promo', {}),
    ).rejects.toThrow('inactive');
    expect(repository.listAnnouncementTargets).not.toHaveBeenCalled();
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it('publishes nothing when part of the audience is unknown', async () => {
    const { publisher, repository, promotions, events } = makePublisher();
    promotions.get.mockResolvedValue(promotion());
    repository.listAnnouncementTargets.mockResolvedValue([
      { id: CUSTOMER_A, full_name: null },
    ]);

    await expect(
      publisher.announcePromotion(connection(), 'promo', {
        customerIds: [CUSTOMER_A, CUSTOMER_B],
      }),
    ).rejects.toThrow(InvalidCampaignException);
    expect(events.emitAsync).not.toHaveBeenCalled();
  });

  it.each([
    [[], 'was empty'],
    [['not-a-uuid'], 'is not a customer id'],
    ['not-an-array', 'must be an array'],
  ])('rejects an invalid audience: %s', async (customerIds, message) => {
    const { publisher, promotions, events } = makePublisher();
    promotions.get.mockResolvedValue(promotion());

    await expect(
      publisher.announcePromotion(connection(), 'promo', {
        customerIds: customerIds as string[],
      }),
    ).rejects.toThrow(message);
    expect(events.emitAsync).not.toHaveBeenCalled();
  });
});

describe('CrmEventPublisher.announceBirthdays', () => {
  it('publishes one birthday per matching customer on today in UTC', async () => {
    const { publisher, repository, events } = makePublisher();
    repository.listBirthdayTargets.mockResolvedValue([
      { id: CUSTOMER_A, full_name: 'Asha Rai' },
    ]);

    const result = await publisher.announceBirthdays(connection(), {});

    expect(result).toEqual({ date: '2026-10-21', published: 1 });
    expect(repository.listBirthdayTargets).toHaveBeenCalledWith(
      expect.anything(),
      '2026-10-21',
    );
    expect(events.emitAsync).toHaveBeenCalledWith(CRM_EVENTS.birthday, {
      event: CRM_EVENTS.birthday,
      tenantId: TENANT,
      customerId: CUSTOMER_A,
      customerName: 'Asha Rai',
      occurredAt: NOW.toISOString(),
    });
  });

  it('honours an explicit local calendar day', async () => {
    const { publisher, repository } = makePublisher();
    repository.listBirthdayTargets.mockResolvedValue([]);

    const result = await publisher.announceBirthdays(connection(), {
      date: '2026-04-12',
    });

    expect(result).toEqual({ date: '2026-04-12', published: 0 });
    expect(repository.listBirthdayTargets).toHaveBeenCalledWith(
      expect.anything(),
      '2026-04-12',
    );
  });

  it.each(['2026-02-31', '12/04/2026', 'tomorrow'])(
    'rejects an impossible day: %s',
    async (date) => {
      const { publisher, repository } = makePublisher();

      await expect(
        publisher.announceBirthdays(connection(), { date }),
      ).rejects.toThrow(InvalidCampaignException);
      expect(repository.listBirthdayTargets).not.toHaveBeenCalled();
    },
  );

  it('never publishes for a different tenant', async () => {
    const { publisher, repository, events } = makePublisher();
    repository.listBirthdayTargets.mockResolvedValue([
      { id: CUSTOMER_C, full_name: null },
    ]);

    await publisher.announceBirthdays(connection(), { date: '2026-04-12' });

    expect(repository.listBirthdayTargets).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT }),
      '2026-04-12',
    );
    expect(events.emitAsync).toHaveBeenCalledWith(
      CRM_EVENTS.birthday,
      expect.objectContaining({ tenantId: TENANT, customerId: CUSTOMER_C }),
    );
  });
});
