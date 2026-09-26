import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantResolver } from '../interfaces/tenant-resolver.interface';

interface JwtPayload {
  tenantId?: unknown;
}

/**
 * Resolves the tenant from the `tenantId` claim embedded in the Bearer access
 * token — used for already-authenticated requests.
 *
 * NOTE: This resolver only DECODES the payload claim of the JWT, it does not
 * verify the signature — signature/expiry verification is the responsibility
 * of AuthModule's `JwtStrategy`. Tenant resolution is only used to pick the RLS
 * context; the user's identity is still independently authenticated.
 */
@Injectable()
export class JwtClaimTenantResolver implements TenantResolver {
  resolve(req: Request): string | null {
    const authorization = req.headers.authorization;
    if (!authorization) {
      return null;
    }

    const [scheme, token] = authorization.split(' ');
    if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) {
      return null;
    }

    const payload = this.decodePayload(token);
    if (!payload) {
      return null;
    }

    const tenantId = payload.tenantId;
    if (typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      return null;
    }

    return tenantId.trim();
  }

  private decodePayload(token: string): JwtPayload | null {
    const segments = token.split('.');
    // JWT is `header.payload.signature`; some tokens may carry no signature.
    if (segments.length < 2) {
      return null;
    }

    try {
      const decoded = Buffer.from(segments[1] ?? '', 'base64url').toString(
        'utf8',
      );

      return JSON.parse(decoded) as JwtPayload;
    } catch {
      return null;
    }
  }
}
