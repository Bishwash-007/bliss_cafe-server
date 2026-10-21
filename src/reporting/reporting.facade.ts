import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { InventoryReportGenerator } from './generators/inventory-report.generator';
import { PlatformReportGenerator } from './generators/platform-report.generator';
import { SalesReportGenerator } from './generators/sales-report.generator';
import { StaffPerformanceReportGenerator } from './generators/staff-performance-report.generator';
import { PlatformReportingRepository } from './platform-reporting.repository';
import { isUuid, resolveDateRange } from './reporting.dates';
import { ReportingRepository } from './reporting.repository';
import type {
  DateRange,
  Report,
  ReportExportType,
  ResolvedDateRange,
} from './reporting.types';

/**
 * # ReportingFacade
 *
 * One entry point per report. A controller calls a method with a branch and a
 * date range; the facade resolves the tenant connection, validates the range,
 * chooses the generator, and returns the finished report. No aggregation SQL
 * is visible to a controller, and no controller needs to know which tables a
 * report touches.
 *
 * The facade is request-scoped because `TenantRequestContext` is: the
 * connection is the request's RLS-pinned transaction, not a pool lookup a
 * later request could reuse.
 */
@Injectable()
export class ReportingFacade {
  constructor(
    private readonly tenantContext: TenantRequestContext,
    private readonly repository: ReportingRepository,
    private readonly platformRepository: PlatformReportingRepository,
  ) {}

  getSalesReport(
    branchId: string,
    dateRange: DateRange,
    exportType: ReportExportType = 'csv',
  ): Promise<Report> {
    const { connection, range } = this.tenantContextFor(branchId, dateRange);
    return new SalesReportGenerator(
      this.repository,
      connection,
      branchId,
      range,
    ).generate(exportType);
  }

  getInventoryConsumptionReport(
    branchId: string,
    dateRange: DateRange,
    exportType: ReportExportType = 'csv',
  ): Promise<Report> {
    const { connection, range } = this.tenantContextFor(branchId, dateRange);
    return new InventoryReportGenerator(
      this.repository,
      connection,
      branchId,
      range,
    ).generate(exportType);
  }

  getStaffPerformanceReport(
    branchId: string,
    dateRange: DateRange,
    exportType: ReportExportType = 'csv',
  ): Promise<Report> {
    const { connection, range } = this.tenantContextFor(branchId, dateRange);
    return new StaffPerformanceReportGenerator(
      this.repository,
      connection,
      branchId,
      range,
    ).generate(exportType);
  }

  /**
   * The platform view. Omitting `dateRange` means "since the beginning of
   * recorded history"; supplying one scopes volume and revenue, while the
   * tenant count in the summary is always the current count.
   */
  getPlatformReport(
    dateRange?: DateRange,
    exportType: ReportExportType = 'csv',
  ): Promise<Report> {
    const range = dateRange ? resolveDateRange(dateRange) : null;
    return new PlatformReportGenerator(this.platformRepository, range).generate(
      exportType,
    );
  }

  private tenantContextFor(
    branchId: string,
    dateRange: DateRange,
  ): { connection: TenantScopedConnection; range: ResolvedDateRange } {
    if (!isUuid(branchId)) {
      throw new BadRequestException('branchId must be a UUID');
    }

    return {
      connection: this.tenantContext.getConnection(),
      range: resolveDateRange(dateRange),
    };
  }
}
