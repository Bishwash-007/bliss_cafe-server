import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';
import { TenantConnectionService } from '../connection/tenant-connection.service';
import type { TenantScopedConnection } from '../connection/tenant-scoped-connection';
import { TenantChainResolver } from '../resolvers/tenant-chain.resolver';
import { TenantInactiveException } from '../exceptions/tenant-inactive.exception';
import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';
import {
  ACTIVE_TENANT_STATUS,
  isPlatformPath,
  isPublicRoutePath,
} from '../tenant.constants';

/**
 * Runs tenant resolution for every request, then hands the request a
 * tenant-scoped database connection:
 *
 *  1. `/platform/*` and public (e.g. `/onboarding`) routes bypass tenant
 *     resolution entirely — no valid tenant is required, and queries run on an
 *     *unscoped* connection.
 *  2. Other routes run the resolver chain (subdomain -> header -> JWT claim),
 *     validate the tenant exists and is `active`, then acquire a connection
 *     pinned to that tenant via `SET LOCAL app.tenant_id`.
 *
 * The connection is committed and released back to the pool when the response
 * finishes, so the RLS session variable can never leak into a later request.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    private readonly chainResolver: TenantChainResolver,
    private readonly connections: TenantConnectionService,
  ) {}

  async use(
    req: RequestWithTenant,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    let connection: TenantScopedConnection | null = null;

    try {
      if (isPlatformPath(req.path) || isPublicRoutePath(req.path)) {
        req.platformRoute = true;
        connection = await this.connections.acquireUnscoped();
      } else {
        const reference = this.chainResolver.resolve(req);
        if (reference === null) {
          throw new TenantNotFoundException();
        }
        const tenant = await this.connections.findTenant(reference);

        if (!tenant) {
          throw new TenantNotFoundException(reference);
        }
        if (tenant.status !== ACTIVE_TENANT_STATUS) {
          throw new TenantInactiveException(tenant.status);
        }

        req.tenantId = tenant.id;
        req.tenantSlug = tenant.slug;
        connection = await this.connections.acquireScoped(tenant.id);
      }

      req.tenantConnection = connection;
      this.releaseOnResponseEnd(res, connection);
    } catch (error) {
      if (connection) {
        await this.safelyRelease(connection);
      }
      next(error);
      return;
    }

    next();
  }

  private releaseOnResponseEnd(
    res: Response,
    connection: TenantScopedConnection,
  ): void {
    let done = false;
    const release = () => {
      if (done) {
        return;
      }
      done = true;
      res.removeListener('finish', release);
      res.removeListener('close', release);
      void this.safelyRelease(connection);
    };

    res.on('finish', release);
    res.on('close', release);
  }

  private async safelyRelease(
    connection: TenantScopedConnection,
  ): Promise<void> {
    try {
      await connection.release();
    } catch {
      // The client is still returned to the pool by the wrapper; a failed
      // COMMIT must not crash the process.
    }
  }
}
