import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from './interfaces/auth.interface';

/**
 * Roles that are NOT confined to a single branch.
 *
 * A `super_admin` supports every tenant and an `org_owner` owns every branch
 * of their café, so a branch mismatch is not a violation for them.
 */
export const ORG_WIDE_ROLES: readonly string[] = ['super_admin', 'org_owner'];

/** True when the user may act on any branch of the tenant. */
export function isOrgWide(user: AuthenticatedUser): boolean {
  return ORG_WIDE_ROLES.includes(user.role);
}

/**
 * Confines a request to the caller's own branch.
 *
 * RLS confines a *tenant*. It cannot confine a *branch*: two branch managers
 * of the same café share one tenant id, so without this check either of them
 * could read the other's stock, roster, menu overrides and tickets.
 *
 * The rule is deliberately narrow:
 *
 *  - an org-wide role is never refused;
 *  - a user whose token carries a branch may only touch THAT branch;
 *  - a user whose token carries no branch is not branch-confined at all
 *    (platform staff and owner accounts), so the check does not apply.
 *
 * A 403 rather than a 404: the resource is inside the caller's own tenant, so
 * there is nothing here that must stay hidden — what is refused is the action.
 */
export function assertBranchAccess(
  user: AuthenticatedUser | undefined,
  branchId: string,
  subject = 'This resource',
): void {
  if (!user) {
    throw new ForbiddenException('Authentication required');
  }
  if (isOrgWide(user)) {
    return;
  }
  if (!user.branchId) {
    return;
  }
  if (user.branchId !== branchId) {
    throw new ForbiddenException(
      `${subject} belongs to branch ${branchId}, and this request is scoped to ` +
        `branch ${user.branchId}.`,
    );
  }
}

/**
 * Requires an org-wide role.
 *
 * Used for the resources that belong to the café as a whole — an org-wide menu
 * item, for instance — which no single branch may change.
 */
export function assertOrgWide(
  user: AuthenticatedUser | undefined,
  subject = 'This resource',
): void {
  if (!user) {
    throw new ForbiddenException('Authentication required');
  }
  if (!isOrgWide(user)) {
    throw new ForbiddenException(
      `${subject} belongs to the whole organisation and may only be changed by ` +
        `an owner.`,
    );
  }
}
