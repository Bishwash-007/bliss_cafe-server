import type { AttendanceRecord } from '../staff.types';

/**
 * # WageCalculationStrategy
 *
 * A wage is not one formula. A cafe pays a barista by the hour, a shift lead
 * a fixed salary, and the floor a share of the tips. Those are three different
 * arithmetic problems, and hard-coding any one of them into the payroll
 * service guarantees the service is wrong the moment the tenant hires somebody
 * paid a different way.
 *
 * So the arithmetic is behind this interface, and `PayrollService` never
 * contains a formula at all — it asks the registry which strategy a staff
 * member's pay type selects, and hands it the records and the rate.
 *
 * ## Adding a strategy
 *
 * Three steps, and NOT ONE of them touches `PayrollService`:
 *
 *  1. Implement this interface in a new class. Give it a `name` that matches
 *     the `pay_type` stored in `staff_wage_rates`.
 *  2. Add the class to `providers` in `StaffModule`, and to the
 *     `WAGE_CALCULATION_STRATEGIES` array in the same file.
 *  3. Accept the new `pay_type` when writing a rate.
 *
 * `PayrollService` compiles and behaves identically before and after. That is
 * the whole point of the seam, and it is what the test in
 * `payroll/wage-strategy.registry.spec.ts` protects.
 *
 * ## The contract
 *
 * `calculate` MUST be pure: same records and same rate in, same number out. It
 * MUST NOT read the clock, the database, or any ambient state — a payroll that
 * changes when you call it twice is not a payroll, and the CSV export and the
 * JSON view have to agree to the cent.
 *
 * It MUST return a finite number. A `NaN` in a total is not a rounding
 * curiosity: it silently turns a total into `NaN`, and `NaN` in a CSV cell is
 * a file nobody can reconcile.
 */
export interface WageCalculationStrategy {
  /**
   * The strategy's name, matching the `pay_type` in `staff_wage_rates`.
   *
   * This is the string a tenant's rate row stores, and the string the registry
   * looks up. It is part of the interface rather than a class name so that
   * renaming a class cannot silently change what a stored `pay_type` means.
   */
  readonly name: string;

  /**
   * The wage for `attendanceRecords` at `rate`.
   *
   * @param attendanceRecords The completed attendance records for one staff
   *   member over one pay period. Records still open (no clock-out) MAY be
   *   ignored — a period that has not ended is not payable yet — but a strategy
   *   that counts them must say so.
   * @param rate The rate in force for that staff member. Its MEANING belongs
   *   to the strategy: money per hour for an hourly worker, money per period
   *   for a salaried one.
   * @returns The wage, as a finite number of money.
   */
  calculate(
    attendanceRecords: readonly AttendanceRecord[],
    rate: number,
  ): number;
}
