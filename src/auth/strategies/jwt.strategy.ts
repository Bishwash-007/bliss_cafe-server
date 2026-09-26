import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy as JwtStrategyBase } from 'passport-jwt';
import { AUTH_CONFIG } from '../auth.constants';
import type {
  AuthenticatedUser,
  JwtAccessPayload,
} from '../interfaces/auth.interface';

/**
 * Validates the Bearer access token's signature/expiry and maps the payload
 * back onto the authenticated user. Used by every protected route.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(JwtStrategyBase, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: AUTH_CONFIG.jwtSecret,
    });
  }

  validate(payload: JwtAccessPayload): AuthenticatedUser {
    if (payload.type !== 'access') {
      throw new UnauthorizedException('Not an access token');
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      role: payload.role,
      email: payload.email,
      fullName: payload.fullName,
    };
  }
}
