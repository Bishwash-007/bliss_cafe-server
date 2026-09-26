import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { OrgController } from './org.controller';
import {
  TenantOnboardingBuilder,
  type TenantOnboardingResult,
} from './tenant-onboarding.builder';

describe('OrgController', () => {
  const connection = {} as unknown as TenantScopedConnection;
  const result: TenantOnboardingResult = {
    tenantId: 't1',
    slug: 'beanhouse',
    branchId: 'b1',
    tableIds: [],
    ownerUserId: 'u1',
  };

  let controller: OrgController;

  beforeEach(() => {
    controller = new OrgController({
      getConnection: () => connection,
      tenantId: null,
    } as unknown as TenantRequestContext);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('runs the builder on the request connection and returns its result', async () => {
    const buildSpy = jest
      .spyOn(TenantOnboardingBuilder.prototype, 'build')
      .mockResolvedValue(result);
    const ownerSpy = jest.spyOn(
      TenantOnboardingBuilder.prototype,
      'withOwnerAccount',
    );

    const dto = {
      orgName: 'Bean House',
      slug: 'beanhouse',
      planId: 'plan-1',
      firstBranch: { name: 'Brunch St', address: '123 Main' },
      defaultTables: 4,
      owner: { email: 'owner@cafe.test', password: 'Password123!' },
    };

    const outcome = await controller.onboard(dto);

    expect(outcome).toEqual(result);
    expect(buildSpy).toHaveBeenCalledTimes(1);
    const [ownerEmail, passwordHash] = ownerSpy.mock.calls[0] ?? [];
    expect(ownerEmail).toBe('owner@cafe.test');
    expect(typeof passwordHash).toBe('string');
    expect(passwordHash).toMatch(/^\$2[aby]\$/);
  });
});
