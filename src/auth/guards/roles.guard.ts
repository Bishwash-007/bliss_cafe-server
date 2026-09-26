import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth.constants';
import type { AuthenticatedUser } from '../interfaces/auth.interface';

/**
 * Enforces `@Roles(...)` metadata on a route: when the authenticated user's
 * role is not in the allowed list (or the request carries no authenticated
 * user at all), the request is rejected with 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>();

    const user = request.user;
    if (!user) {
      throw new ForbiddenException('Authentication required to check roles');
    }
    if (!requiredRoles.includes(user.role)) {
      throw new ForbiddenException(
        `Role '${user.role}' is not allowed to access this resource`,
      );
    }
    return true;
  }
}
