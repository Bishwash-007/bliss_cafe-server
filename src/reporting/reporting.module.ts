import { Module } from '@nestjs/common';
import { platformPoolProvider } from './platform-pool.provider';
import { PlatformReportingRepository } from './platform-reporting.repository';
import { ReportingController } from './reporting.controller';
import { ReportingFacade } from './reporting.facade';
import { ReportingRepository } from './reporting.repository';

/**
 * Read-only reporting: sales, inventory consumption, staff performance and the
 * platform overview.
 *
 * No other feature module is imported. Everything here is a projection of
 * tables other modules own, read through the request's tenant-scoped
 * connection, so reporting cannot accidentally become a write path or create a
 * circular module dependency.
 *
 * `PLATFORM_POOL` is the single deliberate exception: platform aggregation
 * needs a connection that is not subject to tenant RLS. See
 * `platform-pool.provider.ts` for why that is a separate pool rather than the
 * request's "unscoped" connection.
 */
@Module({
  controllers: [ReportingController],
  providers: [
    ReportingFacade,
    ReportingRepository,
    PlatformReportingRepository,
    platformPoolProvider,
  ],
  exports: [ReportingFacade],
})
export class ReportingModule {}
