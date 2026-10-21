/**
 * Query shape for the report routes.
 *
 * Plain interfaces, matching the rest of the project: there is no
 * `class-validator` pipe, so the controller/facade validates and rejects bad
 * input with a clear 400 rather than trusting the cast.
 */
export interface ReportQueryDto {
  /** First day of the report period, inclusive, as `YYYY-MM-DD`. */
  from?: string;
  /** Last day of the report period, inclusive, as `YYYY-MM-DD`. */
  to?: string;
  /** `json` (default), `csv`, or `pdf`. */
  format?: string;
}
