import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard';

const ROLE_HIERARCHY = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
  'kitchen_staff',
  'customer',
];

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  let context: ExecutionContext;

  const protectedRouteRoles = ['branch_manager', 'receptionist'];

  beforeEach(() => {
    reflector = new Reflector();
    guard = new RolesGuard(reflector);

    context = {
      getHandler: () => ({ name: 'initiate' }),
      getClass: () => CheckoutStub,
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  });

  class CheckoutStub {}
  const request = { user: undefined as { role: string } | undefined };

  function enableRoles(roles: string[]): void {
    jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(roles);
  }

  describe('route without @Roles', () => {
    it('lets every request through', () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue([]);
      expect(guard.canActivate(context)).toBe(true);
    });
  });

  describe('protected route (@Roles branch_manager, receptionist)', () => {
    for (const role of ROLE_HIERARCHY) {
      it(`${role} is ${protectedRouteRoles.includes(role) ? 'allowed' : 'blocked'}`, () => {
        enableRoles(protectedRouteRoles);
        request.user = { role };

        if (protectedRouteRoles.includes(role)) {
          expect(guard.canActivate(context)).toBe(true);
        } else {
          expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
        }
      });
    }

    it('blocks when no authenticated user is attached', () => {
      enableRoles(protectedRouteRoles);
      request.user = undefined;
      expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
    });

    it('reads role from the authenticated user (JWT payload), not the request', () => {
      enableRoles(['customer']);
      request.user = { role: 'customer' };
      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
