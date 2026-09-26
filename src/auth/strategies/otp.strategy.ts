import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy as LocalStrategyBase } from 'passport-local';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import { AuthService } from '../auth.service';
import type { AuthenticatedUser } from '../interfaces/auth.interface';

/**
 * Stub OTP strategy. Kept interchangeable with the other strategies: it calls
 * the same `AuthService` entry point and would return the exact
 * `AuthenticatedUser` shape once a real OTP provider is implemented.
 */
@Injectable()
export class OtpStrategy extends PassportStrategy(LocalStrategyBase, 'otp') {
  constructor(private readonly authService: AuthService) {
    super({
      usernameField: 'identifier',
      passwordField: 'code',
      passReqToCallback: true,
    });
  }

  async validate(
    req: RequestWithTenant,
    identifier: string,
    code: string,
  ): Promise<AuthenticatedUser> {
    const tenantId = req.tenantId;
    const connection = req.tenantConnection;

    if (!tenantId || !connection) {
      throw new UnauthorizedException('Tenant context is missing');
    }

    const user = await this.authService.validateOtp(
      connection,
      tenantId,
      identifier,
      code,
    );
    if (!user) {
      throw new UnauthorizedException('Invalid or expired one-time code');
    }
    return user;
  }
}
