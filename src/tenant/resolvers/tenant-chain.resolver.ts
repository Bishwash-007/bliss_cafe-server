import { Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { TenantNotFoundException } from '../exceptions/tenant-not-found.exception';
import { TENANT_RESOLVERS } from '../tenant.constants';
import type { TenantResolver } from '../interfaces/tenant-resolver.interface';

/**
 * Runs the tenant resolvers in priority order (subdomain -> header -> JWT
 * claim) and returns the first non-null result. When every resolver declines,
 * it throws `TenantNotFoundException`.
 *
 * Adding a resolution strategy later (e.g. custom-domain mapping) only requires
 * appending a resolver to the `TENANT_RESOLVERS` array — no resolver re-wiring.
 */
@Injectable()
export class TenantChainResolver implements TenantResolver {
  constructor(
    @Inject(TENANT_RESOLVERS)
    private readonly resolvers: readonly TenantResolver[],
  ) {}

  resolve(req: Request): string | null {
    for (const resolver of this.resolvers) {
      const reference = resolver.resolve(req);
      if (
        reference !== null &&
        reference !== undefined &&
        reference.trim().length > 0
      ) {
        return reference;
      }
    }

    throw new TenantNotFoundException();
  }
}
