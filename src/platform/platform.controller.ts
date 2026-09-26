import { Controller, Get } from '@nestjs/common';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';

/**
 * Platform (SuperAdmin) area. Routes under `/platform/*` skip tenant
 * resolution entirely — `TenantContextMiddleware` marks them as
 * `platformRoute` and gives them an *unscoped* connection, so these queries
 * run without RLS and without needing a valid tenant to resolve.
 */
@Controller('platform')
export class PlatformController {
  constructor(private readonly tenantContext: TenantRequestContext) {}

  /** Lists all tenants (platform tables have no RLS policy). */
  @Get('tenants')
  async listTenants(): Promise<
    Array<{ id: string; slug: string; status: string }>
  > {
    const connection = this.tenantContext.getConnection();
    const result = await connection.query<{
      id: string;
      slug: string;
      status: string;
    }>('SELECT id, slug, status FROM tenants ORDER BY slug');
    return result.rows;
  }
}
