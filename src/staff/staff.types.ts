/**
 * Row and domain shapes for the staff module.
 *
 * Two conventions, both inherited from the inventory module:
 *
 *  - Rows are the RAW database shape, `snake_case` and `NUMERIC` columns as
 *    strings. The API returns rows in this shape deliberately, so a client reads
 *    exactly what the database stores.
 *  - Domain shapes are `camelCase` with quantities already numbers. The
 *    repository is the single place that converts, so no arithmetic anywhere
 *    else has to remember that Postgres handed it a string.
 *
 * Money is `NUMERIC(12,2)` — two decimal places, matching `menu_items.price`
 * (`NUMERIC(10,2)`). Rates and wages are read as strings and converted here.
 */

/** Multiplier for converting to integer cents without float error. */
const HUNDRED = 100;

/**
 * Rounds to 2 decimal places, half away from zero.
 *
 * Half away from zero rather than JS's banker's rounding, because it is what a
 * human doing payroll arithmetic expects: 10.005 becomes 10.01, not 10.00.
 *
 * The same grid is used for money and for hours, because both are things a
 * person reads off a screen and adds up in their head.
 *
 * This is a DISPLAY rounding. Money is calculated in whole cents — see
 * `toCents` — because multiplying by 100 and rounding afterwards loses the
 * half-cent: 0.005 dollars is 0.49999999999999994 cents in binary floating
 * point, and rounding THAT gives 0.00 instead of 0.01.
 */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * HUNDRED)) / HUNDRED;
}

/**
 * A money amount in whole cents.
 *
 * The unit every money calculation in this module happens in. Cents are whole
 * numbers, so `minutes * rateCents / 60` is an exact integer division with a
 * rounding step — no binary floating point anywhere near it.
 */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `Cannot convert a non-finite amount to cents: ${value}`,
    );
  }
  return Math.round(value * HUNDRED);
}

/** Whole cents back to a money amount. */
export function fromCents(cents: number): number {
  return cents / HUNDRED;
}

/**
 * Sums money amounts, in cents.
 *
 * `0.1 + 0.2` is 0.30000000000000004 in binary floating point, and a payroll
 * total that is wrong in the fourteenth decimal place is a total that does not
 * add up on the payslip. The cents are whole numbers, so the sum is exact.
 */
export function sumMoney(values: readonly number[]): number {
  const cents = values.reduce((total, value) => total + toCents(value), 0);
  return fromCents(cents);
}

/**
 * Postgres `NUMERIC` (string) -> JS number of money.
 *
 * Read through the cents grid, so a rate stored as `12.35` is 12.35 and not
 * 12.349999999999999.
 */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return fromCents(toCents(Number(value)));
}

/** Raw row of `shifts`. */
export interface ShiftRow {
  id: string;
  tenant_id: string;
  branch_id: string;
  user_id: string;
  start_time: Date;
  end_time: Date;
  created_at: Date;
}

/** Raw row of `attendance_records`. */
export interface AttendanceRecordRow {
  id: string;
  tenant_id: string;
  shift_id: string;
  clock_in: Date;
  clock_out: Date | null;
  created_at: Date;
}

/** Raw row of `staff_wage_rates`. */
export interface StaffWageRateRow {
  id: string;
  tenant_id: string;
  user_id: string;
  pay_type: string;
  rate: string;
  created_at: Date;
  updated_at: Date;
}

/** A scheduled block of work. */
export interface Shift {
  id: string;
  tenantId: string;
  branchId: string;
  userId: string;
  startTime: Date;
  endTime: Date;
  createdAt: Date;
}

/**
 * One clock-in / clock-out pair.
 *
 * `clockOut` is null while the person is still working. An open record
 * contributes NO hours to a wage calculation: a period that has not ended
 * cannot be paid for yet.
 */
export interface AttendanceRecord {
  id: string;
  tenantId: string;
  shiftId: string;
  clockIn: Date;
  clockOut: Date | null;
}

/** A staff member's pay configuration. */
export interface WageRate {
  id: string;
  tenantId: string;
  userId: string;
  /** Strategy name: `hourly` today; `salaried` and `tip_pooled` are planned. */
  payType: string;
  rate: number;
}

/**
 * How far a caller may reach, and who they are.
 *
 * The scope follows the ROLE, not the presence of a branch in the token:
 * onboarding creates the `org_owner` against the tenant's default branch, so
 * `org_owner.branchId` is a real branch id even though the role runs the whole
 * org. `branch_manager` is the role that is confined to one branch, and there
 * the token's branch is authoritative — never a request parameter, which would
 * be a one-query bypass.
 */
export interface StaffActor {
  /** The caller's own user id. Used to insist a clock-in is their own. */
  readonly userId: string;
  /** The branch the caller is confined to, or null for a tenant-wide role. */
  readonly branchId: string | null;
}

/** A staff member, as the roster and payroll see them. */
export interface StaffMember {
  userId: string;
  fullName: string;
  role: string;
  /**
   * The branch they are assigned to, or null when they are not assigned to
   * one.
   *
   * The branch is what stops a branch manager from scheduling somebody who
   * works at another branch, so it is read from `users.branch_id` and not
   * inferred.
   */
  branchId: string | null;
}

/**
 * A shift joined to its staff member and its attendance record.
 *
 * The raw shape of the roster query. `attendance_id` and the two clock times
 * are NULL when the shift has no attendance record yet — the LEFT JOIN is what
 * makes "scheduled but not worked" a row rather than a missing one.
 */
export interface RosterRow {
  id: string;
  user_id: string;
  full_name: string;
  role: string;
  start_time: Date;
  end_time: Date;
  attendance_id: string | null;
  clock_in: Date | null;
  clock_out: Date | null;
}

/**
 * An attendance record joined to the staff member it belongs to.
 *
 * The raw shape of the payroll query. Every record is a clock-in that fell
 * inside the pay period, for a shift at one branch.
 */
export interface PayrollAttendanceRow {
  user_id: string;
  full_name: string;
  role: string;
  id: string;
  tenant_id: string;
  shift_id: string;
  clock_in: Date;
  clock_out: Date | null;
}

/** A shift with its attendance, as the roster shows it. */
export interface RosterShift {
  id: string;
  userId: string;
  startTime: Date;
  endTime: Date;
  /** The scheduled length in hours, for display. */
  scheduledHours: number;
  clockIn: Date | null;
  clockOut: Date | null;
  /** Hours actually worked, or null when the shift has no attendance yet. */
  hoursWorked: number | null;
}

/** One staff member's shifts in a week. */
export interface RosterStaffEntry {
  userId: string;
  fullName: string;
  role: string;
  shifts: RosterShift[];
}

/** The roster for a branch and a week. */
export interface Roster {
  branchId: string;
  /** The Monday of the rostered week, as `YYYY-MM-DD`. */
  weekStart: string;
  /** The Sunday of the rostered week, as `YYYY-MM-DD`. */
  weekEnd: string;
  staff: RosterStaffEntry[];
}

/** One staff member's wage for a pay period. */
export interface PayrollLine {
  userId: string;
  fullName: string;
  role: string;
  payType: string;
  /** The rate in force for the period. */
  rate: number;
  /** Total hours worked in the period. */
  hoursWorked: number;
  /** The wage. Rounded to 2 decimal places. */
  wage: number;
  /** Attendance records that are still open, and so are not yet payable. */
  openRecords: number;
}

/** A pay period's wages, per staff member and in total. */
export interface PayrollSummary {
  branchId: string;
  from: string;
  to: string;
  lines: PayrollLine[];
  /** The sum of `lines[].wage`. */
  total: number;
}

/**
 * A partial change to a shift, as the repository writes it.
 *
 * Dates are already `Date` here: the service parses and validates the ISO
 * strings the HTTP layer received, and the repository never has to think about
 * what an ISO string means.
 */
export interface ShiftPatch {
  userId?: string;
  startTime?: Date;
  endTime?: Date;
}

export interface SetWageRateInput {
  payType: string;
  rate: number;
}
