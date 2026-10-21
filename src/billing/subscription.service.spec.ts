import type { PaymentProviderFactory } from '../payment';
import type { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { PlanRow, SubscriptionWithPlanRow } from './billing.types';
import type { BillingClock } from './clock';
import {
  InvalidPlanChangeException,
  InvalidSubscriptionActionException,
  SubscriptionChargeFailedException,
} from './exceptions/billing.exceptions';
import { DaysRemainingProrationStrategy } from './proration/days-remaining-proration.strategy';
import { SubscriptionService } from './subscription.service';

const TENANT = 'tenant-1';
const SUBSCRIPTION = 'sub-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');

const STARTER = 'plan-starter';
const PRO = 'plan-pro';

function planRow(id: string, price: string, name = id): PlanRow {
  return {
    id,
    name,
    max_branches: id === PRO ? 10 : 1,
    max_staff: id === PRO ? 100 : 5,
    price_monthly: price,
    created_at: new Date('2025-01-01T00:00:00.000Z'),
  };
}

function subscriptionRow(
  overrides: Partial<SubscriptionWithPlanRow> = {},
): SubscriptionWithPlanRow {
  return {
    id: SUBSCRIPTION,
    tenant_id: TENANT,
    plan_id: STARTER,
    started_at: new Date('2025-12-02T00:00:00.000Z'),
    ends_at: new Date('2026-01-16T00:00:00.000Z'),
    status: 'active',
    plan_name: 'starter',
    price_monthly: '20.00',
    max_branches: 1,
    max_staff: 5,
    ...overrides,
  };
}

interface FakeConnection {
  isReleased: boolean;
  commit: jest.Mock;
  rollback: jest.Mock;
}

function fakeConnection(): FakeConnection {
  const connection: FakeConnection = {
    isReleased: false,
    commit: jest.fn(),
    rollback: jest.fn(),
  };
  connection.commit.mockImplementation(() => {
    connection.isReleased = true;
    return Promise.resolve();
  });
  connection.rollback.mockImplementation(() => {
    connection.isReleased = true;
    return Promise.resolve();
  });
  return connection;
}

describe('SubscriptionService', () => {
  let repository: {
    findCurrentWithPlan: jest.Mock;
    findDueForUpdate: jest.Mock;
    findPlanById: jest.Mock;
    listPlans: jest.Mock;
    changePlan: jest.Mock;
    setStatus: jest.Mock;
    markPastDue: jest.Mock;
  };
  let connections: {
    acquireScoped: jest.Mock;
    listActiveTenants: jest.Mock;
  };
  let provider: {
    name: 'stripe';
    charge: jest.Mock;
  };
  let factory: { getProvider: jest.Mock };
  let clock: BillingClock;
  let connection: FakeConnection;
  let service: SubscriptionService;

  beforeEach(() => {
    repository = {
      findCurrentWithPlan: jest.fn(),
      findDueForUpdate: jest.fn(),
      findPlanById: jest.fn(),
      listPlans: jest.fn(),
      changePlan: jest.fn(),
      setStatus: jest.fn(),
      markPastDue: jest.fn(),
    };
    provider = {
      name: 'stripe',
      charge: jest.fn().mockResolvedValue({
        provider: 'stripe',
        providerReference: 'pi_billing_1',
        status: 'succeeded',
        amount: 20,
      }),
    };
    factory = { getProvider: jest.fn().mockResolvedValue(provider) };
    connection = fakeConnection();
    connections = {
      acquireScoped: jest.fn().mockResolvedValue(connection),
      listActiveTenants: jest.fn().mockResolvedValue([]),
    };
    clock = { now: () => NOW };

    service = new SubscriptionService(
      repository,
      connections as unknown as TenantConnectionService,
      factory as unknown as PaymentProviderFactory,
      new DaysRemainingProrationStrategy(),
      clock,
    );
  });

  describe('state guard', () => {
    it('refuses an upgrade while past_due without charging', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(
        subscriptionRow({ status: 'past_due' }),
      );

      await expect(
        service.performAction(TENANT, 'upgrade', { planId: PRO }),
      ).rejects.toBeInstanceOf(InvalidSubscriptionActionException);

      expect(factory.getProvider).not.toHaveBeenCalled();
      expect(repository.changePlan).not.toHaveBeenCalled();
      expect(connection.commit).not.toHaveBeenCalled();
      expect(connection.rollback).toHaveBeenCalled();
    });

    it('refuses an unknown action', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(subscriptionRow());

      await expect(
        service.performAction(TENANT, 'teleport'),
      ).rejects.toBeInstanceOf(InvalidSubscriptionActionException);
      expect(provider.charge).not.toHaveBeenCalled();
    });
  });

  describe('plan changes', () => {
    it('charges the prorated upgrade through PaymentModule and updates both plan columns', async () => {
      repository.findCurrentWithPlan
        .mockResolvedValueOnce(subscriptionRow())
        .mockResolvedValueOnce(
          subscriptionRow({
            plan_id: PRO,
            plan_name: 'pro',
            price_monthly: '50.00',
          }),
        );
      repository.findPlanById.mockResolvedValue(planRow(PRO, '50.00'));

      const result = await service.performAction(TENANT, 'upgrade', {
        planId: PRO,
      });

      // (50 - 20) * 15 / 30 = 15.
      expect(factory.getProvider).toHaveBeenCalledWith(TENANT);
      expect(provider.charge).toHaveBeenCalledWith(
        15,
        expect.stringContaining('sub_'),
      );
      expect(repository.changePlan).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
        PRO,
      );
      expect(connection.commit).toHaveBeenCalled();
      expect(result.chargedAmount).toBe(15);
      expect(result.creditedAmount).toBe(0);
      expect(result.subscription.plan.id).toBe(PRO);
    });

    it('credits a downgrade without sending a negative charge to the gateway', async () => {
      repository.findCurrentWithPlan
        .mockResolvedValueOnce(
          subscriptionRow({
            plan_id: PRO,
            plan_name: 'pro',
            price_monthly: '50.00',
          }),
        )
        .mockResolvedValueOnce(subscriptionRow());
      repository.findPlanById.mockResolvedValue(planRow(STARTER, '20.00'));

      const result = await service.performAction(TENANT, 'downgrade', {
        planId: STARTER,
      });

      expect(provider.charge).not.toHaveBeenCalled();
      expect(result.chargedAmount).toBe(0);
      expect(result.creditedAmount).toBe(15);
    });

    it('rejects an action labelled in the wrong direction', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(subscriptionRow());
      repository.findPlanById.mockResolvedValue(planRow(PRO, '50.00'));

      await expect(
        service.performAction(TENANT, 'downgrade', { planId: PRO }),
      ).rejects.toBeInstanceOf(InvalidPlanChangeException);
      expect(provider.charge).not.toHaveBeenCalled();
    });
  });

  describe('renewal action', () => {
    it('extends ends_at and stays active after a successful charge', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(
        subscriptionRow({
          ends_at: new Date('2025-12-31T23:59:59.000Z'),
        }),
      );
      repository.setStatus.mockImplementation(
        (
          _connection: TenantScopedConnection,
          _tenantId: string,
          _id: string,
          status: string,
          endsAt: Date,
        ) => Promise.resolve(subscriptionRow({ status, ends_at: endsAt })),
      );

      const result = await service.performAction(TENANT, 'renew');

      expect(provider.charge).toHaveBeenCalledWith(
        20,
        expect.stringContaining('renew'),
      );
      expect(repository.setStatus).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
        'active',
        new Date('2026-01-31T00:00:00.000Z'),
      );
      expect(connection.commit).toHaveBeenCalled();
      expect(result.subscription.status).toBe('active');
    });

    it('moves an active subscription to past_due when the charge fails', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(subscriptionRow());
      provider.charge.mockRejectedValue(new Error('card declined'));
      repository.markPastDue.mockResolvedValue(
        subscriptionRow({ status: 'past_due' }),
      );

      await expect(
        service.performAction(TENANT, 'renew'),
      ).rejects.toBeInstanceOf(SubscriptionChargeFailedException);

      expect(repository.markPastDue).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
      );
      expect(repository.setStatus).not.toHaveBeenCalled();
      // The past_due write is committed before the exception leaves the service.
      expect(connection.commit).toHaveBeenCalled();
      expect(connection.rollback).not.toHaveBeenCalled();
    });

    it('lets a past_due subscription retry the charge', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(
        subscriptionRow({
          status: 'past_due',
          ends_at: new Date('2025-12-20T00:00:00.000Z'),
        }),
      );
      repository.setStatus.mockResolvedValue(
        subscriptionRow({
          status: 'active',
          ends_at: new Date('2026-01-31T00:00:00.000Z'),
        }),
      );

      const result = await service.performAction(TENANT, 'retry_payment');

      expect(provider.charge).toHaveBeenCalledTimes(1);
      expect(repository.setStatus).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
        'active',
        new Date('2026-01-31T00:00:00.000Z'),
      );
      expect(result.subscription.status).toBe('active');
    });
  });

  describe('cancel', () => {
    it('moves the subscription to cancelled and records the instant', async () => {
      repository.findCurrentWithPlan.mockResolvedValue(subscriptionRow());
      repository.setStatus.mockResolvedValue(
        subscriptionRow({ status: 'cancelled', ends_at: NOW }),
      );

      const result = await service.performAction(TENANT, 'cancel');

      expect(repository.setStatus).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
        'cancelled',
        NOW,
      );
      expect(provider.charge).not.toHaveBeenCalled();
      expect(result.subscription.status).toBe('cancelled');
    });
  });

  describe('scheduled renewal sweep', () => {
    it('renews a due subscription and extends its period', async () => {
      connections.listActiveTenants.mockResolvedValue([
        { id: TENANT, slug: 'bean', status: 'active' },
      ]);
      repository.findDueForUpdate.mockResolvedValue(
        subscriptionRow({ ends_at: new Date('2025-12-31T00:00:00.000Z') }),
      );
      repository.setStatus.mockResolvedValue(
        subscriptionRow({
          ends_at: new Date('2026-01-31T00:00:00.000Z'),
        }),
      );

      const summary = await service.renewDueSubscriptions(NOW);

      expect(summary).toMatchObject({
        checked: 1,
        renewed: 1,
        failed: 0,
        skipped: 0,
      });
      expect(repository.setStatus).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
        'active',
        new Date('2026-01-31T00:00:00.000Z'),
      );
      expect(connection.commit).toHaveBeenCalled();
    });

    it('commits past_due when the daily charge fails, never silently active', async () => {
      connections.listActiveTenants.mockResolvedValue([
        { id: TENANT, slug: 'bean', status: 'active' },
      ]);
      repository.findDueForUpdate.mockResolvedValue(
        subscriptionRow({ ends_at: new Date('2025-12-31T00:00:00.000Z') }),
      );
      provider.charge.mockRejectedValue(new Error('insufficient funds'));
      repository.markPastDue.mockResolvedValue(
        subscriptionRow({ status: 'past_due' }),
      );

      const summary = await service.renewDueSubscriptions(NOW);

      expect(summary).toMatchObject({
        checked: 1,
        renewed: 0,
        failed: 1,
        skipped: 0,
      });
      expect(repository.markPastDue).toHaveBeenCalledWith(
        connection,
        TENANT,
        SUBSCRIPTION,
      );
      expect(repository.setStatus).not.toHaveBeenCalled();
      expect(connection.commit).toHaveBeenCalled();
    });

    it('treats a provider pending outcome as a failed renewal', async () => {
      connections.listActiveTenants.mockResolvedValue([
        { id: TENANT, slug: 'bean', status: 'active' },
      ]);
      repository.findDueForUpdate.mockResolvedValue(
        subscriptionRow({ ends_at: new Date('2025-12-31T00:00:00.000Z') }),
      );
      provider.charge.mockResolvedValue({
        provider: 'stripe',
        providerReference: 'pi_pending',
        status: 'pending',
        amount: 20,
      });
      repository.markPastDue.mockResolvedValue(
        subscriptionRow({ status: 'past_due' }),
      );

      const summary = await service.renewDueSubscriptions(NOW);

      expect(summary.failed).toBe(1);
      expect(repository.markPastDue).toHaveBeenCalled();
      expect(repository.setStatus).not.toHaveBeenCalled();
    });

    it('skips a tenant whose subscription is not due', async () => {
      connections.listActiveTenants.mockResolvedValue([
        { id: TENANT, slug: 'bean', status: 'active' },
      ]);
      repository.findDueForUpdate.mockResolvedValue(null);

      const summary = await service.renewDueSubscriptions(NOW);

      expect(summary).toMatchObject({
        checked: 1,
        renewed: 0,
        failed: 0,
        skipped: 1,
      });
      expect(connection.commit).toHaveBeenCalled();
    });

    it('renews a free plan without calling a gateway', async () => {
      connections.listActiveTenants.mockResolvedValue([
        { id: TENANT, slug: 'bean', status: 'active' },
      ]);
      repository.findDueForUpdate.mockResolvedValue(
        subscriptionRow({
          plan_id: 'plan-free',
          plan_name: 'free',
          price_monthly: '0.00',
          ends_at: new Date('2025-12-31T00:00:00.000Z'),
        }),
      );
      repository.setStatus.mockResolvedValue(
        subscriptionRow({
          status: 'active',
          ends_at: new Date('2026-01-31T00:00:00.000Z'),
        }),
      );

      const summary = await service.renewDueSubscriptions(NOW);

      expect(summary.renewed).toBe(1);
      expect(factory.getProvider).not.toHaveBeenCalled();
      expect(repository.setStatus).toHaveBeenCalled();
    });
  });
});
