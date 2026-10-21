import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/**
 * Staff HTTP payloads.
 *
 * Dates arrive as ISO-8601 strings and are converted to `Date` by the service.
 * They stay strings here so that the HTTP contract is explicit about what it
 * accepts, and so a caller sending `startTime: 12345` gets a clear error
 * rather than a `Date` built from a number.
 */

/**
 * A shift to schedule.
 *
 * `userId` is the staff member the shift is for. It is validated against the
 * tenant's own users by the service — a shift for a user in another tenant
 * would be invisible under RLS and would quietly never be clocked in to.
 */
export class CreateShiftDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  /** ISO-8601 instant the shift starts. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  startTime!: string;

  /** ISO-8601 instant the shift ends. Must be after `startTime`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  endTime!: string;
}

/**
 * A partial shift change.
 *
 * Omit a field to leave it alone. Unlike the inventory module's supplier
 * update, `null` is not meaningful for any of these fields — a shift with no
 * start, no end or no staff member is not a shift — so an explicit `null` is
 * rejected rather than stored.
 */
export class UpdateShiftDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  userId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  startTime?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  endTime?: string;
}

/**
 * Which shift to clock in to or out of.
 *
 * The staff member is NOT part of the payload: it comes from the caller's
 * token, so nobody can clock in on behalf of somebody else.
 */
export class ClockDto {
  @IsString()
  @IsNotEmpty()
  shiftId!: string;
}

/**
 * A staff member's pay configuration.
 *
 * `payType` must name a registered strategy — see
 * `src/staff/payroll/wage-calculation.strategy.ts`.
 */
export class SetWageRateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  payType!: string;

  /** Money per hour for `hourly`; the meaning belongs to the strategy. */
  @IsNumber()
  rate!: number;
}

/** The week to show a roster for. */
export class RosterQueryDto {
  /**
   * Any date within the week, as `YYYY-MM-DD`. The week runs Monday to Sunday.
   * Defaults to the current week when absent.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  week?: string;
}

/** The pay period to calculate. */
export class PayrollQueryDto {
  /**
   * First day of the period, as `YYYY-MM-DD`. Inclusive.
   *
   * Required together with `to`, and optional together with it. One of the
   * two alone would be a request for a period the caller did not state.
   */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  from?: string;

  /** Last day of the period, as `YYYY-MM-DD`. Inclusive. */
  @IsOptional()
  @IsString()
  @MaxLength(10)
  to?: string;
}
