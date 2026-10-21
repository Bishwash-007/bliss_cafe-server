import { Module } from '@nestjs/common';
import { ReportingModule } from '../reporting/reporting.module';
import { PlatformController } from './platform.controller';

@Module({
  imports: [ReportingModule],
  controllers: [PlatformController],
})
export class PlatformModule {}
