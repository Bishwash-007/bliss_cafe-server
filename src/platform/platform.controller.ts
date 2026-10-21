import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { ReportQueryDto } from '../reporting/dto/reporting.dto';
import {
  exportTypeFor,
  parseReportFormat,
  sendReport,
  type ReportResponse,
} from '../reporting/report-response';
import type { DateRange } from '../reporting/reporting.types';
import { ReportingFacade } from '../reporting/reporting.facade';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';

type PlatformRequest = Request;

function optionalRange(query: ReportQueryDto): DateRange | undefined {
  if (!query.from && !query.to) {
    return undefined;
  }
  if (!query.from || !query.to) {
    throw new BadRequestException(
      'from and to must be supplied together, as inclusive YYYY-MM-DD dates',
    );
  }
  return { from: query.from, to: query.to };
}

/**
 * Platform (SuperAdmin) area. Routes under `/platform/*` skip tenant
 * resolution entirely — `TenantContextMiddleware` marks them as
 * `platformRoute` and gives them an *unscoped* connection, so these queries
 * run without RLS and without needing a valid tenant to resolve.
 */
@Controller('platform')
export class PlatformController {
  constructor(
    private readonly tenantContext: TenantRequestContext,
    private readonly reportingFacade: ReportingFacade,
  ) {}

  /** Lists all tenants (platform tables have no RLS policy). */
  @Get('tenants')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
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

  /**
   * Cross-tenant overview: active tenants, order volume and revenue by plan.
   *
   * Unlike every tenant report, this one reads through the platform pool, not
   * the request's unscoped connection. The request connection is pinned to a
   * tenant id that cannot exist, so RLS would return zero orders and the
   * dashboard would look plausible but empty. Access is restricted to
   * `super_admin`; the role guard is the only thing standing between a tenant
   * owner and every other tenant's revenue.
   */
  @Get('reports/overview')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin')
  async overview(
    @Query() query: ReportQueryDto,
    @Req() req: PlatformRequest,
  ): Promise<ReportResponse> {
    const format = parseReportFormat(query.format);
    const report = await this.reportingFacade.getPlatformReport(
      optionalRange(query),
      exportTypeFor(format),
    );
    return sendReport(req, report, format);
  }
}
