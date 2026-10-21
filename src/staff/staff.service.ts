import { Inject, Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { CLOCK, type Clock } from './clock';
import { ClockInPolicy } from './clock-in-policy';
import type {
  ClockDto,
  CreateShiftDto,
  PayrollQueryDto,
  RosterQueryDto,
  SetWageRateDto,
  UpdateShiftDto,
} from './dto/staff.dto';
import {
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
import { hoursBetween } from './hours';
import { payrollCsv } from './payroll/payroll-csv';
import { WageStrategyRegistry } from './payroll/wage-strategy.registry';
import { isUniqueViolation, StaffRepository } from './staff.repository';
import {
  DAYS_IN_MILLISECONDS,
  MAX_PERIOD_DAYS,
  formatDateOnly,
  parseDateOnly,
  parseIsoInstant,
  periodBounds,
  periodLengthInDays,
  weekBounds,
} from './schedule-dates';
import {
  money,
  round2,
  sumMoney,
  type AttendanceRecord,
  type AttendanceRecordRow,
  type PayrollLine,
  type PayrollSummary,
  type Roster,
  type RosterStaffEntry,
  type ShiftPatch,
  type ShiftRow,
  type StaffActor,
  type StaffMember,
  type StaffWageRateRow,
} from './staff.types';

/**
 * The most shifts a single list request returns.
 *
 * A tenant accumulates schedule history without bound, so the list is capped.
 * The cap drops the OLDEST shifts — the query orders newest first — so the
 * shifts a manager is actually looking at are the ones that survive.
 */
const MAX_LISTED_SHIFTS = 500;

/**
 * # StaffService
 *
 * Scheduling, attendance and payroll for a branch's staff.
 *
 * ## What this service refuses to do
 *
 * Most of the code here is refusal. A branch manager cannot reach another
 * branch's roster. A staff member cannot clock in to somebody else's shift. A
 * clock-in far from the scheduled start is refused rather than recorded. A
 * payroll never reports a wage it cannot justify.
 *
 * Each of those is a place where a plausible-looking wrong answer would be
 * worse than an error: a roster that shows another branch's staff, an
 * attendance record nobody checked, a payslip that quietly underpays somebody.
 *
 * ## Where the time comes from
 *
 * The clock is injected, never `new Date()` called inline, so that a request
 * has ONE notion of now and a test can place events at chosen instants. See
 * `src/staff/clock.ts`.
 */
@Injectable()
export class StaffService {
  constructor(
    private readonly repository: StaffRepository,
    private readonly strategies: WageStrategyRegistry,
    private readonly clockInPolicy: ClockInPolicy,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------ shifts

  /**
   * Schedules a shift.
   *
   * The staff member must exist in this tenant and must work at this branch.
   * Both checks are the difference between a roster and a pile of rows: a
   * shift for a user id from another tenant is invisible under RLS to
   * everybody except the caller who made it, and a shift for somebody who
   * works elsewhere is a shift that will never be clocked in to.
   */
  async createShift(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    dto: CreateShiftDto,
  ): Promise<ShiftRow> {
    this.assertBranchScope(actor, branchId, 'This branch');
    await this.assertBranchExists(connection, branchId);

    const startTime = parseIsoInstant(dto.startTime, 'startTime');
    const endTime = parseIsoInstant(dto.endTime, 'endTime');
    this.assertEndAfterStart(startTime, endTime);

    const staff = await this.requireStaffMember(connection, dto.userId);
    this.assertStaffAtBranch(actor, staff, branchId);

    return this.repository.insertShift(
      connection,
      branchId,
      dto.userId,
      startTime,
      endTime,
    );
  }

  /**
   * Every shift at a branch, newest first.
   */
  async listShifts(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
  ): Promise<ShiftRow[]> {
    this.assertBranchScope(actor, branchId, 'This branch');
    const shifts = await this.repository.listShifts(connection, branchId);
    return shifts.slice(0, MAX_LISTED_SHIFTS);
  }

  /**
   * One shift.
   *
   * A shift from another tenant is simply not found: the query is tenant-scoped
   * and RLS filters it out, so the caller gets a 404 and learns nothing about
   * the other tenant's schedule.
   */
  async getShift(
    connection: TenantScopedConnection,
    actor: StaffActor,
    shiftId: string,
  ): Promise<ShiftRow> {
    const shift = await this.requireShift(connection, shiftId);
    this.assertBranchScope(actor, shift.branch_id, 'The shift');
    return shift;
  }

  /**
   * Changes a shift.
   *
   * The MERGED result is validated, not just the fields that were sent:
   * moving the start of a 09:00–17:00 shift to 18:00 has to be refused even
   * though the end did not change and the end alone is perfectly valid.
   */
  async updateShift(
    connection: TenantScopedConnection,
    actor: StaffActor,
    shiftId: string,
    dto: UpdateShiftDto,
  ): Promise<ShiftRow> {
    const existing = await this.requireShift(connection, shiftId);
    this.assertBranchScope(actor, existing.branch_id, 'The shift');

    const patch: ShiftPatch = {};

    if (dto.userId !== undefined) {
      const staff = await this.requireStaffMember(connection, dto.userId);
      this.assertStaffAtBranch(actor, staff, existing.branch_id);
      patch.userId = dto.userId;
    }

    const startTime =
      dto.startTime !== undefined
        ? parseIsoInstant(dto.startTime, 'startTime')
        : existing.start_time;
    const endTime =
      dto.endTime !== undefined
        ? parseIsoInstant(dto.endTime, 'endTime')
        : existing.end_time;
    this.assertEndAfterStart(startTime, endTime);

    if (dto.startTime !== undefined) {
      patch.startTime = startTime;
    }
    if (dto.endTime !== undefined) {
      patch.endTime = endTime;
    }

    const updated = await this.repository.updateShift(
      connection,
      shiftId,
      patch,
    );
    if (!updated) {
      // The shift was deleted between the read and the write.
      throw new ShiftNotFoundException(shiftId);
    }
    return updated;
  }

  /**
   * Removes a shift.
   *
   * The attendance record goes with it: `attendance_records.shift_id` cascades,
   * so deleting a shift also removes the hours recorded against it. That is a
   * deliberate consequence — deleting a shift is deleting the claim that the
   * work happened — and it is why the shift a manager is about to delete should
   * be looked at first.
   */
  async deleteShift(
    connection: TenantScopedConnection,
    actor: StaffActor,
    shiftId: string,
  ): Promise<void> {
    const existing = await this.requireShift(connection, shiftId);
    this.assertBranchScope(actor, existing.branch_id, 'The shift');
    await this.repository.deleteShift(connection, shiftId);
  }

  // --------------------------------------------------------------- attendance

  /**
   * Records a clock-in.
   *
   * Three refusals, each with a different reason:
   *
   *  - the shift is not yours (`NotYourShiftException`);
   *  - the clock-in is too far from the scheduled start
   *    (`ClockInOutsideWindowException`);
   *  - the shift already has an attendance record
   *    (`AlreadyClockedInException`).
   *
   * The last one is enforced by a unique index rather than by the check above
   * it, so two simultaneous clock-ins cannot both succeed.
   */
  async clockIn(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    dto: ClockDto,
  ): Promise<AttendanceRecordRow> {
    this.assertBranchScope(actor, branchId, 'This branch');
    const shift = await this.requireShift(connection, dto.shiftId);
    this.assertShiftAtBranch(shift, branchId);

    if (shift.user_id !== actor.userId) {
      throw new NotYourShiftException(shift.id);
    }

    const now = this.clock.now();
    if (!this.clockInPolicy.accepts(shift.start_time, now)) {
      throw new ClockInOutsideWindowException(
        shift.id,
        shift.start_time,
        now,
        this.clockInPolicy.minutes,
      );
    }

    const existing = await this.repository.findAttendanceForShift(
      connection,
      shift.id,
    );
    if (existing) {
      throw new AlreadyClockedInException(shift.id);
    }

    try {
      return await this.repository.insertAttendance(connection, shift.id, now);
    } catch (error) {
      // Somebody else clocked in between the check above and this insert.
      if (isUniqueViolation(error)) {
        throw new AlreadyClockedInException(shift.id);
      }
      throw error;
    }
  }

  /**
   * Records a clock-out.
   *
   * A clock-out at or before the clock-in is refused: a zero-length or
   * reversed attendance record is not payable and is not a record of anything.
   * The database has a CHECK for it as well, but the service refuses it first
   * so the caller gets a 400 with a clear message instead of a constraint
   * violation arriving as an opaque 500 from the driver.
   */
  async clockOut(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    dto: ClockDto,
  ): Promise<AttendanceRecordRow> {
    this.assertBranchScope(actor, branchId, 'This branch');
    const shift = await this.requireShift(connection, dto.shiftId);
    this.assertShiftAtBranch(shift, branchId);

    if (shift.user_id !== actor.userId) {
      throw new NotYourShiftException(shift.id);
    }

    const record = await this.repository.findAttendanceForShift(
      connection,
      shift.id,
    );
    if (!record || record.clock_out !== null) {
      throw new NotClockedInException(shift.id);
    }

    const now = this.clock.now();
    if (now.getTime() <= record.clock_in.getTime()) {
      throw new ClockOutBeforeClockInException(shift.id, record.clock_in, now);
    }

    const closed = await this.repository.closeAttendance(
      connection,
      shift.id,
      now,
    );
    if (!closed) {
      // Somebody else closed it a moment ago.
      throw new NotClockedInException(shift.id);
    }
    return closed;
  }

  // ------------------------------------------------------------------ roster

  /**
   * The roster for a branch and a week.
   *
   * The week runs Monday to Sunday and is identified by ANY day inside it, so
   * a caller can ask for "the week of the 21st" without having to know where
   * the week starts.
   */
  async roster(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    query: RosterQueryDto = {},
  ): Promise<Roster> {
    this.assertBranchScope(actor, branchId, 'This branch');
    await this.assertBranchExists(connection, branchId);

    const day = query.week ? parseDateOnly(query.week, 'week') : this.today();
    const bounds = weekBounds(day);

    const rows = await this.repository.listRosterRows(
      connection,
      branchId,
      bounds.start,
      bounds.end,
    );

    const byUser = new Map<string, RosterStaffEntry>();
    for (const row of rows) {
      let entry = byUser.get(row.user_id);
      if (!entry) {
        entry = {
          userId: row.user_id,
          fullName: row.full_name,
          role: row.role,
          shifts: [],
        };
        byUser.set(row.user_id, entry);
      }
      entry.shifts.push({
        id: row.id,
        userId: row.user_id,
        startTime: row.start_time,
        endTime: row.end_time,
        scheduledHours: round2(hoursBetween(row.start_time, row.end_time)),
        clockIn: row.clock_in,
        clockOut: row.clock_out,
        hoursWorked:
          row.clock_in !== null && row.clock_out !== null
            ? round2(hoursBetween(row.clock_in, row.clock_out))
            : null,
      });
    }

    return {
      branchId,
      weekStart: bounds.weekStart,
      weekEnd: bounds.weekEnd,
      staff: [...byUser.values()],
    };
  }

  // ----------------------------------------------------------------- payroll

  /**
   * The wages for a pay period.
   *
   * See `payrollCsv` for the same figures as a file. The two read the same
   * numbers from the same code path, so they cannot disagree.
   */
  async payroll(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    query: PayrollQueryDto = {},
  ): Promise<PayrollSummary> {
    this.assertBranchScope(actor, branchId, 'This branch');
    await this.assertBranchExists(connection, branchId);

    const bounds = this.resolvePeriod(query);
    const records = await this.repository.listPayrollAttendance(
      connection,
      branchId,
      bounds.from,
      bounds.to,
    );
    const rates = await this.repository.listWageRates(connection);

    const rateByUser = new Map(rates.map((rate) => [rate.user_id, rate]));
    const groups = new Map<
      string,
      { fullName: string; role: string; records: AttendanceRecord[] }
    >();

    for (const row of records) {
      let group = groups.get(row.user_id);
      if (!group) {
        group = {
          fullName: row.full_name,
          role: row.role,
          records: [],
        };
        groups.set(row.user_id, group);
      }
      group.records.push({
        id: row.id,
        tenantId: row.tenant_id,
        shiftId: row.shift_id,
        clockIn: row.clock_in,
        clockOut: row.clock_out,
      });
    }

    const lines: PayrollLine[] = [];
    const missingRates: string[] = [];

    for (const [userId, group] of groups) {
      const rateRow = rateByUser.get(userId);
      const hoursWorked = group.records.reduce(
        (total, record) =>
          record.clockOut === null
            ? total
            : total + hoursBetween(record.clockIn, record.clockOut),
        0,
      );
      const openRecords = group.records.filter(
        (record) => record.clockOut === null,
      ).length;

      if (!rateRow) {
        // A missing rate is a gap in the configuration, not a rate of zero.
        // Paying it as zero would quietly underpay somebody, so the payroll
        // refuses to run and says who is missing a rate. A staff member with no
        // HOURS is a different case: there is nothing to pay, so no rate is
        // needed and no error is raised.
        if (hoursWorked > 0) {
          missingRates.push(group.fullName);
          continue;
        }
        lines.push({
          userId,
          fullName: group.fullName,
          role: group.role,
          payType: 'none',
          rate: 0,
          hoursWorked: 0,
          wage: 0,
          openRecords,
        });
        continue;
      }

      const strategy = this.strategies.strategyForOrDefault(rateRow.pay_type);
      const wage = strategy.calculate(group.records, money(rateRow.rate));

      lines.push({
        userId,
        fullName: group.fullName,
        role: group.role,
        payType: strategy.name,
        rate: money(rateRow.rate),
        hoursWorked: round2(hoursWorked),
        wage,
        openRecords,
      });
    }

    if (missingRates.length > 0) {
      throw new MissingWageRateException(missingRates);
    }

    return {
      branchId,
      from: formatDateOnly(bounds.from),
      to: formatDateOnly(new Date(bounds.to.getTime() - DAYS_IN_MILLISECONDS)),
      lines,
      total: sumMoney(lines.map((line) => line.wage)),
    };
  }

  /**
   * The same payroll as a CSV file.
   *
   * The total row is the sum of the wages in the rows above it, computed from
   * the same rounded values — never recomputed from the raw hours, because a
   * total that does not add up to the column above it is worse than no total.
   */
  async payrollCsv(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    query: PayrollQueryDto = {},
  ): Promise<string> {
    const summary = await this.payroll(connection, actor, branchId, query);
    return payrollCsv(summary);
  }

  // ------------------------------------------------------------- wage rates

  /**
   * Sets a staff member's rate.
   *
   * The pay type is checked against the registry HERE, at the point the rate is
   * entered, so an unsupported one is refused immediately. Checking it only at
   * pay-run time would mean the mistake is discovered when the payroll is
   * being produced — which is the worst possible moment to discover it.
   */
  async setWageRate(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    userId: string,
    dto: SetWageRateDto,
  ): Promise<StaffWageRateRow> {
    this.assertBranchScope(actor, branchId, 'This branch');

    const staff = await this.requireStaffMember(connection, userId);
    this.assertStaffAtBranch(actor, staff, branchId);

    if (!this.strategies.names.includes(dto.payType)) {
      throw new UnsupportedPayTypeException(dto.payType, this.strategies.names);
    }

    if (
      typeof dto.rate !== 'number' ||
      !Number.isFinite(dto.rate) ||
      dto.rate < 0
    ) {
      throw new InvalidRateException(
        `'${String(dto.rate)}' is not a non-negative finite number.`,
      );
    }

    return this.repository.upsertWageRate(
      connection,
      userId,
      dto.payType,
      round2(dto.rate),
    );
  }

  /**
   * A staff member's rate, or null when they have none.
   */
  async getWageRate(
    connection: TenantScopedConnection,
    actor: StaffActor,
    branchId: string,
    userId: string,
  ): Promise<StaffWageRateRow | null> {
    this.assertBranchScope(actor, branchId, 'This branch');
    const staff = await this.requireStaffMember(connection, userId);
    this.assertStaffAtBranch(actor, staff, branchId);
    return this.repository.findWageRate(connection, userId);
  }

  // ----------------------------------------------------------------- helpers

  /**
   * The scope a caller may reach.
   *
   * The scope comes from the ROLE, not from the presence of a branch in the
   * token. Onboarding creates the `org_owner` against the tenant's default
   * branch, so `org_owner.branchId` is a real branch id even though the role
   * runs the whole org. Keying the scope off the id would therefore confine
   * the owner to the first branch and refuse them everywhere else — which is
   * how this check was first written in the inventory module, and the e2e
   * caught it immediately.
   *
   * `branch_manager` is the role that is confined to one branch, and there the
   * token's branch is authoritative. It is never taken from a request
   * parameter: a parameter is caller-controlled, so it would be a one-query
   * bypass.
   */
  private assertBranchScope(
    actor: StaffActor,
    targetBranchId: string,
    what: string,
  ): void {
    if (actor.branchId === null) {
      return;
    }
    if (actor.branchId === targetBranchId) {
      return;
    }
    throw new StaffBranchAccessDeniedException(
      `${what} belongs to branch ${targetBranchId}, and this request is scoped ` +
        `to branch ${actor.branchId}. A branch manager may only work with ` +
        `their own branch's staff.`,
    );
  }

  /**
   * A shift must be at the branch the request is for.
   *
   * The check exists because the shift id and the branch id arrive by two
   * different routes, and pairing a shift from one branch with another
   * branch's payroll would put a clock-in in the wrong branch's books.
   */
  private assertShiftAtBranch(shift: ShiftRow, branchId: string): void {
    if (shift.branch_id !== branchId) {
      throw new ShiftNotFoundException(shift.id);
    }
  }

  /**
   * A staff member must work at the branch in question.
   *
   * A branch manager may only schedule people at their own branch. A
   * tenant-wide actor may also schedule somebody who is not assigned to any
   * branch at all — there is no branch to conflict with, and refusing would
   * only stop an owner from rostering a new hire before assigning them.
   */
  private assertStaffAtBranch(
    actor: StaffActor,
    staff: { fullName: string; branchId: string | null },
    branchId: string,
  ): void {
    if (staff.branchId === branchId) {
      return;
    }
    if (staff.branchId === null && actor.branchId === null) {
      return;
    }
    throw new StaffBranchAccessDeniedException(
      staff.branchId === null
        ? `${staff.fullName} is not assigned to a branch, so they cannot be ` +
            `scheduled at branch ${branchId}. Assign them to a branch first.`
        : `${staff.fullName} belongs to branch ${staff.branchId}, so they ` +
            `cannot be scheduled at branch ${branchId}.`,
    );
  }

  private assertEndAfterStart(startTime: Date, endTime: Date): void {
    if (endTime.getTime() <= startTime.getTime()) {
      throw new InvalidDateRangeException(
        `a shift must end after it starts, but startTime is ` +
          `${startTime.toISOString()} and endTime is ${endTime.toISOString()}.`,
      );
    }
  }

  private async requireShift(
    connection: TenantScopedConnection,
    shiftId: string,
  ): Promise<ShiftRow> {
    const shift = await this.repository.findShift(connection, shiftId);
    if (!shift) {
      throw new ShiftNotFoundException(shiftId);
    }
    return shift;
  }

  private async requireStaffMember(
    connection: TenantScopedConnection,
    userId: string,
  ): Promise<StaffMember> {
    const staff = await this.repository.findStaffMember(connection, userId);
    if (!staff) {
      throw new StaffMemberNotFoundException(userId);
    }
    return staff;
  }

  private async assertBranchExists(
    connection: TenantScopedConnection,
    branchId: string,
  ): Promise<void> {
    if (!(await this.repository.branchExists(connection, branchId))) {
      throw new BranchNotFoundException(branchId);
    }
  }

  /**
   * The pay period a request covers.
   *
   * `from` and `to` are both required or both absent. One of them alone is a
   * request for a period nobody stated, and guessing the other end — a
   * "from" of today with an implied "to" of the end of the month — would
   * produce a payroll for a period the caller did not ask for.
   *
   * With neither, the period is the current calendar month in UTC. That is the
   * period a pay run is for, so it is the useful default.
   */
  private resolvePeriod(query: PayrollQueryDto): { from: Date; to: Date } {
    const hasFrom = query.from !== undefined && query.from !== '';
    const hasTo = query.to !== undefined && query.to !== '';
    if (hasFrom !== hasTo) {
      throw new InvalidDateRangeException(
        `both 'from' and 'to' must be given, or neither.`,
      );
    }
    if (!hasFrom || !hasTo) {
      const now = this.clock.now();
      const from = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const to = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
      );
      return { from, to };
    }
    const bounds = periodBounds(query.from as string, query.to as string);
    if (periodLengthInDays(bounds.from, bounds.to) > MAX_PERIOD_DAYS) {
      throw new InvalidDateRangeException(
        `a pay period may not be longer than ${MAX_PERIOD_DAYS} days.`,
      );
    }
    return bounds;
  }

  /** Today, in UTC. */
  private today(): Date {
    const now = this.clock.now();
    return new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
  }
}
