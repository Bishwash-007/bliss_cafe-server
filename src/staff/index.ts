/**
 * Public barrel for the staff module.
 *
 * ## What is implemented
 *
 *  - **Shifts** — a scheduled block of work for one staff member at one branch,
 *    with a roster view for a week.
 *  - **Attendance** — clock-in and clock-out, with a configurable window around
 *    the scheduled start and a refusal to clock out before clocking in.
 *  - **Payroll** — wages for a pay period, as JSON and as CSV, computed by a
 *    strategy chosen by the staff member's pay type.
 *  - **Wage rates** — the rate and pay type behind each staff member's wages.
 *
 * ## What is deliberately NOT implemented
 *
 * ### Purchase orders and stock intake
 *
 * The staff module has no connection to purchasing. Stock arrives, staff are
 * scheduled against the resulting workload, and the two meet only in the
 * payroll numbers. A purchase order — raising an order to a supplier, tracking
 * it as received, paying for it — is inventory's business, and the inventory
 * module records a delivery as a `stock_movements` row of type `purchase`.
 * There is no `purchase_orders` table, and inventing one here would put
 * supplier and stock concepts inside a scheduling module.
 *
 * ### Overtime and clock-out windows
 *
 * The clock-IN is checked against the scheduled start (± the configured
 * window). The clock-OUT is not: a staff member may clock out after their shift
 * has ended, and the hours are paid as worked.
 *
 * That is a deliberate gap, not an oversight. A cafe that is busy on a Friday
 * will sometimes need somebody to stay two hours, and refusing the clock-out
 * would mean a payroll that has to be corrected by hand every time it
 * happened. But it does mean a staff member who forgets to clock out is paid
 * for the time between their clock-in and whenever they next clock in — which
 * is a real way to lose money.
 *
 * The fix is a cap on payable hours per shift, or a clock-out window. Both are
 * business decisions — what counts as overtime, and whether it is paid at the
 * same rate — so neither is made unilaterally here. Until then, the roster
 * shows the scheduled hours next to the hours worked, so the gap is visible in
 * the one screen a manager looks at before a pay run.
 *
 * ### Absences, leave and holidays
 *
 * There is no leave, no sick note and no holiday calendar. A shift with no
 * attendance record is the only representation of "somebody did not work", and
 * it is the same representation as "nobody clocked in".
 *
 * ### Salaried and tip-pooled pay
 *
 * The `pay_type` column exists and the registry refuses an unknown one, so
 * adding `SalariedStrategy` and `TipPooledStrategy` later is a class and a
 * line in `staff.module.ts` — no change to the service, the controller or the
 * database. Neither is implemented today, and a tenant that sets one of them
 * gets a clear 422 rather than a number calculated by the wrong formula.
 *
 * ### Currency
 *
 * The wage rate is a plain amount. The schema has no currency concept at all
 * — not on the tenant, not on the menu, not on payments — so introducing one
 * here would mean inventing a per-tenant currency that the rest of the system
 * does not agree with. The rate is an amount in the tenant's own currency, and
 * a currency is a schema decision for the tenant and billing work.
 *
 * ### Staff accounts
 *
 * This module schedules and pays people; it does not create them. There is no
 * "add a waiter" endpoint. A staff member is a row in `users` with a role, and
 * who may create those is the auth module's business.
 */

export { StaffController } from './staff.controller';
export { StaffModule } from './staff.module';
export { StaffRepository } from './staff.repository';
export { StaffService } from './staff.service';

export { CLOCK, SystemClock, type Clock } from './clock';
export {
  CLOCK_IN_WINDOW_MINUTES,
  ClockInPolicy,
  clockInWindowFromEnv,
  DEFAULT_CLOCK_IN_WINDOW_MINUTES,
} from './clock-in-policy';

export { HourlyWageStrategy } from './payroll/hourly-wage.strategy';
export type { WageCalculationStrategy } from './payroll/wage-calculation.strategy';
export {
  DEFAULT_WAGE_STRATEGY,
  WAGE_CALCULATION_STRATEGIES,
  WageStrategyRegistry,
} from './payroll/wage-strategy.registry';
export { escapeCsvField, payrollCsv } from './payroll/payroll-csv';

export {
  AlreadyClockedInException,
  BranchNotFoundException,
  ClockInOutsideWindowException,
  ClockOutBeforeClockInException,
  InvalidDateRangeException,
  InvalidRateException,
  MissingWageRateException,
  NotClockedInException,
  NotYourShiftException,
  ShiftNotFoundException,
  StaffBranchAccessDeniedException,
  StaffMemberNotFoundException,
  UnsupportedPayTypeException,
} from './exceptions/staff.exceptions';

export type {
  AttendanceRecord,
  PayrollLine,
  PayrollSummary,
  Roster,
  RosterShift,
  RosterStaffEntry,
  Shift,
  ShiftPatch,
  StaffActor,
  StaffMember,
  StaffWageRateRow,
  WageRate,
} from './staff.types';
export type {
  ClockDto,
  CreateShiftDto,
  PayrollQueryDto,
  RosterQueryDto,
  SetWageRateDto,
  UpdateShiftDto,
} from './dto/staff.dto';
