import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantResolver } from '../interfaces/tenant-resolver.interface';

/**
 * Resolves the tenant from the `X-Tenant-Id` request header.
 *
 * Built for API clients / mobile apps that cannot rely on a subdomain. The
 * header may carry either a tenant id or a slug — the middleware looks either
 * up against the `tenants` table.
 */
@Injectable()
export class HeaderTenantResolver implements TenantResolver {
  /** Header name (case-insensitive in Express). */
  static readonly HEADER = 'x-tenant-id';

  resolve(req: Request): string | null {
    const raw = req.headers[HeaderTenantResolver.HEADER];
    if (raw === undefined || raw === null) {
      return null;
    }

    const value = Array.isArray(raw) ? raw[0] : raw;
    const trimmed = (value ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}
