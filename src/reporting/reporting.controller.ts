import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import type { ReportQueryDto } from './dto/reporting.dto';
import {
  exportTypeFor,
  parseReportFormat,
  sendReport,
  type ReportResponse,
} from './report-response';
import type { DateRange } from './reporting.types';
import { ReportingFacade } from './reporting.facade';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Reports are financial and operational summaries, so the same roles that can
 * read payroll and stock can read them. A waiter does not need the branch's
 * revenue, and a customer certainly does not.
 */
const REPORT_READ_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/** Roles that may read across every branch of the tenant. */
const ORG_WIDE_ROLES = ['super_admin', 'org_owner'];

function requiredRange(query: ReportQueryDto): DateRange {
  if (!query.from || !query.to) {
    throw new BadRequestException(
      'from and to are required, as inclusive YYYY-MM-DD dates',
    );
  }
  return { from: query.from, to: query.to };
}

/**
 * Tenant report endpoints.
 *
 * The branch is in the path because every report is about one branch. The
 * date range is inclusive at both ends, and `format=json|csv|pdf` selects the
 * representation; the data is identical in all three.
 */
@Controller('branches/:branchId/reports')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportingController {
  constructor(private readonly facade: ReportingFacade) {}

  @Get('sales')
  @Roles(...REPORT_READ_ROLES)
  async sales(
    @Param('branchId') branchId: string,
    @Query() query: ReportQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ReportResponse> {
    this.assertBranchScope(req, branchId);
    const format = parseReportFormat(query.format);
    const report = await this.facade.getSalesReport(
      branchId,
      requiredRange(query),
      exportTypeFor(format),
    );
    return sendReport(req, report, format);
  }

  @Get('inventory-consumption')
  @Roles(...REPORT_READ_ROLES)
  async inventoryConsumption(
    @Param('branchId') branchId: string,
    @Query() query: ReportQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ReportResponse> {
    this.assertBranchScope(req, branchId);
    const format = parseReportFormat(query.format);
    const report = await this.facade.getInventoryConsumptionReport(
      branchId,
      requiredRange(query),
      exportTypeFor(format),
    );
    return sendReport(req, report, format);
  }

  @Get('staff-performance')
  @Roles(...REPORT_READ_ROLES)
  async staffPerformance(
    @Param('branchId') branchId: string,
    @Query() query: ReportQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<ReportResponse> {
    this.assertBranchScope(req, branchId);
    const format = parseReportFormat(query.format);
    const report = await this.facade.getStaffPerformanceReport(
      branchId,
      requiredRange(query),
      exportTypeFor(format),
    );
    return sendReport(req, report, format);
  }

  /**
   * Branch managers are confined to their own branch. The branch id comes from
   * the token, never from the path, so changing the URL cannot widen access.
   */
  private assertBranchScope(req: AuthedRequest, branchId: string): void {
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('Authentication required');
    }
    if (ORG_WIDE_ROLES.includes(user.role)) {
      return;
    }
    if (user.branchId !== branchId) {
      throw new ForbiddenException(
        'You may only read reports for your own branch',
      );
    }
  }
}
