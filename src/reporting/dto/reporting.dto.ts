import { IsOptional, IsString, Matches } from 'class-validator';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Query shape for the report routes.
 *
 * The date shape is checked here so a typo becomes a clear 400; the range
 * rules (both ends or neither, start before end) stay in the reporting facade.
 */
export class ReportQueryDto {
  /** First day of the report period, inclusive, as `YYYY-MM-DD`. */
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  from?: string;

  /** Last day of the report period, inclusive, as `YYYY-MM-DD`. */
  @IsOptional()
  @IsString()
  @Matches(DATE_ONLY)
  to?: string;

  /** `json` (default), `csv`, or `pdf`. */
  @IsOptional()
  @IsString()
  format?: string;
}
