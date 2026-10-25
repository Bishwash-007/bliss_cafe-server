import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from './interfaces/auth.interface';
import {
  assertBranchAccess,
  assertOrgWide,
  isOrgWide,
  ORG_WIDE_ROLES,
} from './branch-scope';

const BRANCH_A = '11111111-1111-4111-8111-111111111111';
const BRANCH_B = '22222222-2222-4222-8222-222222222222';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'user-1',
    tenantId: 'tenant-1',
    branchId: BRANCH_A,
    role: 'branch_manager',
    email: 'manager@cafe.test',
    fullName: 'Manager',
    ...overrides,
  };
}

describe('isOrgWide', () => {
  it('is true for the two organisation-wide roles', () => {
    expect(isOrgWide(user({ role: 'super_admin' }))).toBe(true);
    expect(isOrgWide(user({ role: 'org_owner' }))).toBe(true);
  });

  it('is false for every other role', () => {
    for (const role of [
      'branch_manager',
      'receptionist',
      'waiter',
      'kitchen_staff',
      'customer',
    ]) {
      expect(isOrgWide(user({ role }))).toBe(false);
    }
  });

  it('lists exactly the two roles that are organisation-wide', () => {
    expect([...ORG_WIDE_ROLES]).toEqual(['super_admin', 'org_owner']);
  });
});

describe('assertBranchAccess', () => {
  it('lets a branch-confined user into its own branch', () => {
    expect(() =>
      assertBranchAccess(user({ branchId: BRANCH_A }), BRANCH_A),
    ).not.toThrow();
  });

  it('refuses a branch-confined user another branch', () => {
    expect(() =>
      assertBranchAccess(user({ branchId: BRANCH_A }), BRANCH_B),
    ).toThrow(ForbiddenException);
  });

  it('lets an organisation-wide role into every branch', () => {
    for (const role of ORG_WIDE_ROLES) {
      expect(() =>
        assertBranchAccess(user({ role, branchId: BRANCH_A }), BRANCH_B),
      ).not.toThrow();
    }
  });

  it('does not confine a user whose token carries no branch', () => {
    expect(() =>
      assertBranchAccess(user({ branchId: null }), BRANCH_B),
    ).not.toThrow();
  });

  it('refuses an unauthenticated request', () => {
    expect(() => assertBranchAccess(undefined, BRANCH_A)).toThrow(
      ForbiddenException,
    );
  });

  it('names both branches in the refusal message', () => {
    expect(() =>
      assertBranchAccess(user({ branchId: BRANCH_A }), BRANCH_B, 'The branch'),
    ).toThrow(/belongs to branch .* scoped to branch/);
  });
});

describe('assertOrgWide', () => {
  it('lets an organisation-wide role through', () => {
    expect(() => assertOrgWide(user({ role: 'org_owner' }))).not.toThrow();
  });

  it('refuses a branch-confined role', () => {
    expect(() => assertOrgWide(user({ role: 'branch_manager' }))).toThrow(
      ForbiddenException,
    );
  });

  it('refuses an unauthenticated request', () => {
    expect(() => assertOrgWide(undefined)).toThrow(ForbiddenException);
  });
});
