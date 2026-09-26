import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as LocalStrategyBase } from 'passport-local';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import { AuthService } from '../auth.service';
import type { AuthenticatedUser } from '../interfaces/auth.interface';

/**
 * First authentication method behind `AuthService`:
 * validates `email` + `password` against `users.password_hash` (bcrypt),
 * scoped to the tenant resolved upstream by the TenantContextMiddleware.
 */
@Injectable()
export class LocalStrategy extends PassportStrategy(
  LocalStrategyBase,
  'local',
) {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'email',
      passwordField: 'password',
      passReqToCallback: true,
    });
  }

  async validate(
    req: RequestWithTenant,
    email: string,
    password: string,
  ): Promise<AuthenticatedUser> {
    const tenantId = req.tenantId;
    const connection = req.tenantConnection;

    if (!tenantId || !connection) {
      throw new UnauthorizedException('Tenant context is missing');
    }

    return this.authService.validateLocal(
      connection,
      tenantId,
      email,
      password,
    );
  }
}
