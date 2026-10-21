/**
 * Public barrel for the Reporting module.
 *
 * Controllers outside this module (the platform overview) only need the
 * facade. The generators are exported for tests and for the template-method
 * contract; they are not intended as a second entry point for application
 * code.
 */
export { ReportingModule } from './reporting.module';
export { ReportingFacade } from './reporting.facade';
export { ReportGenerator } from './generators/report-generator';
export { SalesReportGenerator } from './generators/sales-report.generator';
export { InventoryReportGenerator } from './generators/inventory-report.generator';
export { StaffPerformanceReportGenerator } from './generators/staff-performance-report.generator';
export { PlatformReportGenerator } from './generators/platform-report.generator';
export type {
  DateRange,
  Report,
  ReportBody,
  ReportCell,
  ReportColumn,
  ReportExportArtifact,
  ReportExportType,
  ReportRow,
  ReportStep,
  ReportTable,
} from './reporting.types';
