import { ExecutionContext } from '@nestjs/common';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import { BillingRepository } from '../billing.repository';
import {
  SubscriptionCancelledException,
  SubscriptionPastDueException,
} from '../exceptions/billing.exceptions';
import { SubscriptionAccessGuard } from './subscription-access.guard';

/**
 * Builds an execution context around a request.
 *
 * Only three things of the request matter to the guard: the `Authorization`
 * header (is this an authenticated request?), the path (is this route
 * exempt?), and the method (is this a read?).
 */
function contextFor(
  request: Partial<RequestWithTenant> & { headers?: Record<string, string> },
): ExecutionContext {
  const full = {
    path: '/orders',
    method: 'GET',
    headers: {},
    ...request,
  } as RequestWithTenant;

  return {
    switchToHttp: () => ({
      getRequest: () => full,
    }),
  } as unknown as ExecutionContext;
}

describe('SubscriptionAccessGuard', () => {
  let repository: { findCurrentStatus: jest.Mock };
  let guard: SubscriptionAccessGuard;

  beforeEach(() => {
    repository = { findCurrentStatus: jest.fn().mockResolvedValue('active') };
    guard = new SubscriptionAccessGuard(
      repository as unknown as BillingRepository,
    );
  });

  it('lets an anonymous request through to the route’s own guard', async () => {
    await expect(guard.canActivate(contextFor({ headers: {} }))).resolves.toBe(
      true,
    );
    expect(repository.findCurrentStatus).not.toHaveBeenCalled();
  });

  it('lets an active tenant through', async () => {
    await expect(
      guard.canActivate(
        contextFor({
          headers: { authorization: 'Bearer token' },
          tenantId: 'tenant-1',
          tenantConnection: {} as never,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('lets a tenant with no subscription through', async () => {
    repository.findCurrentStatus.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        contextFor({
          headers: { authorization: 'Bearer token' },
          tenantId: 'tenant-1',
          tenantConnection: {} as never,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('lets a past_due tenant read', async () => {
    repository.findCurrentStatus.mockResolvedValue('past_due');

    await expect(
      guard.canActivate(
        contextFor({
          method: 'GET',
          headers: { authorization: 'Bearer token' },
          tenantId: 'tenant-1',
          tenantConnection: {} as never,
        }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses a past_due tenant a write', async () => {
    repository.findCurrentStatus.mockResolvedValue('past_due');

    await expect(
      guard.canActivate(
        contextFor({
          method: 'POST',
          headers: { authorization: 'Bearer token' },
          tenantId: 'tenant-1',
          tenantConnection: {} as never,
        }),
      ),
    ).rejects.toThrow(SubscriptionPastDueException);
  });

  it('refuses a cancelled tenant everything, reads included', async () => {
    repository.findCurrentStatus.mockResolvedValue('cancelled');

    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      await expect(
        guard.canActivate(
          contextFor({
            method,
            headers: { authorization: 'Bearer token' },
            tenantId: 'tenant-1',
            tenantConnection: {} as never,
          }),
        ),
      ).rejects.toThrow(SubscriptionCancelledException);
    }
  });

  it.each([
    '/auth',
    '/auth/login',
    '/billing',
    '/billing/subscription',
    '/onboarding',
    '/platform',
    '/platform/tenants',
    '/webhooks/razorpay',
  ])('leaves %s open whatever the state is', async (path) => {
    repository.findCurrentStatus.mockResolvedValue('cancelled');

    await expect(
      guard.canActivate(
        contextFor({
          path,
          method: 'POST',
          headers: { authorization: 'Bearer token' },
          tenantId: 'tenant-1',
          tenantConnection: {} as never,
        }),
      ),
    ).resolves.toBe(true);
    expect(repository.findCurrentStatus).not.toHaveBeenCalled();
  });

  it('does not gate a request that resolved no tenant', async () => {
    await expect(
      guard.canActivate(
        contextFor({ headers: { authorization: 'Bearer token' } }),
      ),
    ).resolves.toBe(true);
    expect(repository.findCurrentStatus).not.toHaveBeenCalled();
  });
});
