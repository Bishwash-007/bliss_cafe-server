import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { CLOCK, type Clock } from './clock';
import { ClockInPolicy } from './clock-in-policy';
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
import { HourlyWageStrategy } from './payroll/hourly-wage.strategy';
import { WageStrategyRegistry } from './payroll/wage-strategy.registry';
import { StaffRepository, isUniqueViolation } from './staff.repository';
import { StaffService } from './staff.service';
import type {
  AttendanceRecordRow,
  PayrollAttendanceRow,
  RosterRow,
  ShiftRow,
  StaffActor,
  StaffMember,
  StaffWageRateRow,
} from './staff.types';

const TENANT = 'tenant-1';
const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

/** The staff member who does the shifts in these tests. */
const STAFF_ID = 'staff-1';

/** A tenant-wide actor: an `org_owner`, with no branch in the token. */
const OWNER: StaffActor = { userId: 'owner-1', branchId: null };

/** A `branch_manager` of BRANCH_A, who may not touch BRANCH_B. */
const MANAGER: StaffActor = { userId: 'manager-1', branchId: BRANCH_A };

/**
 * The staff member themselves: the only actor who may clock in to their own
 * shifts.
 */
const STAFF_ACTOR: StaffActor = { userId: STAFF_ID, branchId: BRANCH_A };

const WINDOW_MINUTES = 30;

/**
 * A clock that does not move.
 *
 * The clock-in window and the clock-out ordering are rules about time, and a
 * test that has to wait for a particular minute of the day to prove a rule is
 * a test nobody runs.
 */
class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return this.instant;
  }
}

function connection(): TenantScopedConnection {
  return { tenantId: TENANT } as unknown as TenantScopedConnection;
}

function shift(overrides: Partial<ShiftRow> = {}): ShiftRow {
  return {
    id: 'shift-1',
    tenant_id: TENANT,
    branch_id: BRANCH_A,
    user_id: STAFF_ID,
    start_time: new Date('2026-10-21T09:00:00Z'),
    end_time: new Date('2026-10-21T17:00:00Z'),
    created_at: new Date('2026-10-20T09:00:00Z'),
    ...overrides,
  };
}

function attendance(
  overrides: Partial<AttendanceRecordRow> = {},
): AttendanceRecordRow {
  return {
    id: 'attendance-1',
    tenant_id: TENANT,
    shift_id: 'shift-1',
    clock_in: new Date('2026-10-21T09:00:00Z'),
    clock_out: null,
    created_at: new Date('2026-10-21T09:00:00Z'),
    ...overrides,
  };
}

function staffMember(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    userId: STAFF_ID,
    fullName: 'Asha Rai',
    role: 'waiter',
    branchId: BRANCH_A,
    ...overrides,
  };
}

function wageRate(overrides: Partial<StaffWageRateRow> = {}): StaffWageRateRow {
  return {
    id: 'rate-1',
    tenant_id: TENANT,
    user_id: STAFF_ID,
    pay_type: 'hourly',
    rate: '100.00',
    created_at: new Date('2026-10-01T00:00:00Z'),
    updated_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function payrollRow(
  overrides: Partial<PayrollAttendanceRow> = {},
): PayrollAttendanceRow {
  return {
    user_id: STAFF_ID,
    full_name: 'Asha Rai',
    role: 'waiter',
    id: 'attendance-1',
    tenant_id: TENANT,
    shift_id: 'shift-1',
    clock_in: new Date('2026-10-21T09:00:00Z'),
    clock_out: new Date('2026-10-21T16:30:00Z'),
    ...overrides,
  };
}

function rosterRow(overrides: Partial<RosterRow> = {}): RosterRow {
  return {
    id: 'shift-1',
    user_id: STAFF_ID,
    full_name: 'Asha Rai',
    role: 'waiter',
    start_time: new Date('2026-10-21T09:00:00Z'),
    end_time: new Date('2026-10-21T17:00:00Z'),
    attendance_id: 'attendance-1',
    clock_in: new Date('2026-10-21T09:00:00Z'),
    clock_out: new Date('2026-10-21T16:30:00Z'),
    ...overrides,
  };
}

/** The repository, with every method a jest mock. */
function repositoryMock() {
  return {
    insertShift: jest.fn(),
    listShifts: jest.fn().mockResolvedValue([]),
    findShift: jest.fn(),
    updateShift: jest.fn(),
    deleteShift: jest.fn(),
    findAttendanceForShift: jest.fn(),
    insertAttendance: jest.fn(),
    closeAttendance: jest.fn(),
    listRosterRows: jest.fn().mockResolvedValue([]),
    listPayrollAttendance: jest.fn().mockResolvedValue([]),
    listWageRates: jest.fn().mockResolvedValue([]),
    findWageRate: jest.fn(),
    upsertWageRate: jest.fn(),
    findStaffMember: jest.fn(),
    branchExists: jest.fn().mockResolvedValue(true),
  };
}

type RepositoryMock = ReturnType<typeof repositoryMock>;

function makeService(
  repository: RepositoryMock,
  now: string = '2026-10-21T09:00:00Z',
): StaffService {
  return new StaffService(
    repository as unknown as StaffRepository,
    new WageStrategyRegistry([new HourlyWageStrategy()]),
    new ClockInPolicy(WINDOW_MINUTES),
    new FixedClock(new Date(now)),
  );
}

describe('StaffService', () => {
  let repository: RepositoryMock;
  let service: StaffService;

  beforeEach(() => {
    repository = repositoryMock();
    service = makeService(repository);
  });

  // ------------------------------------------------------------------ shifts

  describe('createShift', () => {
    beforeEach(() => {
      repository.findStaffMember.mockResolvedValue(staffMember());
      repository.insertShift.mockImplementation(
        (
          _connection: TenantScopedConnection,
          branchId: string,
          userId: string,
          startTime: Date,
          endTime: Date,
        ): Promise<ShiftRow> =>
          Promise.resolve(
            shift({
              branch_id: branchId,
              user_id: userId,
              start_time: startTime,
              end_time: endTime,
            }),
          ),
      );
    });

    it('creates the shift', async () => {
      const created = await service.createShift(connection(), OWNER, BRANCH_A, {
        userId: STAFF_ID,
        startTime: '2026-10-21T09:00:00Z',
        endTime: '2026-10-21T17:00:00Z',
      });

      expect(created.branch_id).toBe(BRANCH_A);
      expect(created.user_id).toBe(STAFF_ID);
    });

    it('refuses a shift that ends before it starts', async () => {
      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T17:00:00Z',
          endTime: '2026-10-21T09:00:00Z',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);

      expect(repository.insertShift).not.toHaveBeenCalled();
    });

    it('refuses a zero-length shift', async () => {
      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T09:00:00Z',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);
    });

    it('refuses a start time with no UTC offset', async () => {
      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);
    });

    it('refuses a staff member who does not exist', async () => {
      repository.findStaffMember.mockResolvedValue(null);

      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).rejects.toBeInstanceOf(StaffMemberNotFoundException);
    });

    it('refuses a branch that does not exist', async () => {
      repository.branchExists.mockResolvedValue(false);

      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).rejects.toBeInstanceOf(BranchNotFoundException);
    });

    it('refuses a branch manager reaching another branch', async () => {
      await expect(
        service.createShift(connection(), MANAGER, BRANCH_B, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);

      expect(repository.insertShift).not.toHaveBeenCalled();
    });

    it('refuses to schedule somebody who works at another branch', async () => {
      repository.findStaffMember.mockResolvedValue(
        staffMember({ branchId: BRANCH_B }),
      );

      await expect(
        service.createShift(connection(), MANAGER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);
    });

    it('lets a tenant-wide actor schedule somebody with no branch', async () => {
      repository.findStaffMember.mockResolvedValue(
        staffMember({ branchId: null }),
      );

      await expect(
        service.createShift(connection(), OWNER, BRANCH_A, {
          userId: STAFF_ID,
          startTime: '2026-10-21T09:00:00Z',
          endTime: '2026-10-21T17:00:00Z',
        }),
      ).resolves.toBeDefined();
    });
  });

  describe('updateShift', () => {
    beforeEach(() => {
      repository.findShift.mockResolvedValue(shift());
      repository.updateShift.mockResolvedValue(shift());
    });

    it('changes the start of a shift', async () => {
      await service.updateShift(connection(), OWNER, 'shift-1', {
        startTime: '2026-10-21T10:00:00Z',
      });

      expect(repository.updateShift).toHaveBeenCalledWith(
        connection(),
        'shift-1',
        { startTime: new Date('2026-10-21T10:00:00Z') },
      );
    });

    it('refuses a change that would end the shift before it starts', async () => {
      // The end is unchanged and perfectly valid on its own — it is the MERGED
      // shift that is impossible.
      await expect(
        service.updateShift(connection(), OWNER, 'shift-1', {
          startTime: '2026-10-21T18:00:00Z',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);

      expect(repository.updateShift).not.toHaveBeenCalled();
    });

    it('refuses a shift that does not exist', async () => {
      repository.findShift.mockResolvedValue(null);

      await expect(
        service.updateShift(connection(), OWNER, 'nope', {
          startTime: '2026-10-21T10:00:00Z',
        }),
      ).rejects.toBeInstanceOf(ShiftNotFoundException);
    });

    it('refuses a branch manager reaching another branch', async () => {
      repository.findShift.mockResolvedValue(shift({ branch_id: BRANCH_B }));

      await expect(
        service.updateShift(connection(), MANAGER, 'shift-1', {
          startTime: '2026-10-21T10:00:00Z',
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);
    });
  });

  describe('deleteShift', () => {
    it('deletes a shift the caller may reach', async () => {
      repository.findShift.mockResolvedValue(shift());

      await service.deleteShift(connection(), OWNER, 'shift-1');

      expect(repository.deleteShift).toHaveBeenCalledWith(
        connection(),
        'shift-1',
      );
    });

    it('refuses a branch manager reaching another branch', async () => {
      repository.findShift.mockResolvedValue(shift({ branch_id: BRANCH_B }));

      await expect(
        service.deleteShift(connection(), MANAGER, 'shift-1'),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);

      expect(repository.deleteShift).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------- attendance

  describe('clockIn', () => {
    beforeEach(() => {
      repository.findShift.mockResolvedValue(shift());
      repository.findAttendanceForShift.mockResolvedValue(null);
      repository.insertAttendance.mockResolvedValue(attendance());
    });

    it('records a clock-in at the start of the shift', async () => {
      const record = await service.clockIn(
        connection(),
        STAFF_ACTOR,
        BRANCH_A,
        {
          shiftId: 'shift-1',
        },
      );

      expect(record.clock_in).toEqual(new Date('2026-10-21T09:00:00Z'));
    });

    it('accepts a clock-in at the earliest edge of the window', async () => {
      service = makeService(repository, '2026-10-21T08:30:00Z');

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).resolves.toBeDefined();
    });

    it('accepts a clock-in at the latest edge of the window', async () => {
      service = makeService(repository, '2026-10-21T09:30:00Z');

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).resolves.toBeDefined();
    });

    it('refuses a clock-in long before the shift starts', async () => {
      service = makeService(repository, '2026-10-21T06:00:00Z');

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(ClockInOutsideWindowException);

      expect(repository.insertAttendance).not.toHaveBeenCalled();
    });

    it('refuses a clock-in long after the shift starts', async () => {
      service = makeService(repository, '2026-10-21T14:00:00Z');

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(ClockInOutsideWindowException);
    });

    it("refuses a clock-in to somebody else's shift", async () => {
      repository.findShift.mockResolvedValue(
        shift({ user_id: 'somebody-else' }),
      );

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(NotYourShiftException);

      expect(repository.insertAttendance).not.toHaveBeenCalled();
    });

    it('refuses a second clock-in to the same shift', async () => {
      repository.findAttendanceForShift.mockResolvedValue(attendance());

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(AlreadyClockedInException);

      expect(repository.insertAttendance).not.toHaveBeenCalled();
    });

    it('turns a losing race for the unique index into a conflict', async () => {
      repository.insertAttendance.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(AlreadyClockedInException);
    });

    it('lets a genuine database failure through', async () => {
      repository.insertAttendance.mockRejectedValue(
        Object.assign(new Error('connection lost'), { code: '08006' }),
      );

      await expect(
        service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toThrow('connection lost');
    });

    it('refuses a shift that belongs to another branch', async () => {
      repository.findShift.mockResolvedValue(shift({ branch_id: BRANCH_B }));

      await expect(
        service.clockIn(connection(), OWNER, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(ShiftNotFoundException);
    });
  });

  describe('clockOut', () => {
    beforeEach(() => {
      // The shift is 09:00–17:00 and the attendance record was opened at
      // 09:00, so "now" is the end of the shift: late enough that closing the
      // record is an ordinary clock-out, not a race with the clock-in.
      service = makeService(repository, '2026-10-21T17:00:00Z');
      repository.findShift.mockResolvedValue(shift());
      repository.findAttendanceForShift.mockResolvedValue(attendance());
      repository.closeAttendance.mockResolvedValue(
        attendance({ clock_out: new Date('2026-10-21T17:00:00Z') }),
      );
    });

    it('closes the attendance record', async () => {
      const record = await service.clockOut(
        connection(),
        STAFF_ACTOR,
        BRANCH_A,
        {
          shiftId: 'shift-1',
        },
      );

      expect(record.clock_out).toEqual(new Date('2026-10-21T17:00:00Z'));
    });

    it('refuses a clock-out at the same instant as the clock-in', async () => {
      service = makeService(repository, '2026-10-21T09:00:00Z');

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(ClockOutBeforeClockInException);

      expect(repository.closeAttendance).not.toHaveBeenCalled();
    });

    it('refuses a clock-out before the clock-in', async () => {
      service = makeService(repository, '2026-10-21T08:00:00Z');

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(ClockOutBeforeClockInException);
    });

    it('refuses a clock-out with no attendance record at all', async () => {
      repository.findAttendanceForShift.mockResolvedValue(null);

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(NotClockedInException);
    });

    it('refuses a second clock-out', async () => {
      repository.findAttendanceForShift.mockResolvedValue(
        attendance({ clock_out: new Date('2026-10-21T09:30:00Z') }),
      );

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(NotClockedInException);
    });

    it('turns a losing race into a conflict', async () => {
      repository.closeAttendance.mockResolvedValue(null);

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(NotClockedInException);
    });

    it("refuses a clock-out for somebody else's shift", async () => {
      repository.findShift.mockResolvedValue(
        shift({ user_id: 'somebody-else' }),
      );

      await expect(
        service.clockOut(connection(), STAFF_ACTOR, BRANCH_A, {
          shiftId: 'shift-1',
        }),
      ).rejects.toBeInstanceOf(NotYourShiftException);
    });
  });

  // ------------------------------------------------------------------ roster

  describe('roster', () => {
    it('groups the shifts by staff member', async () => {
      repository.listRosterRows.mockResolvedValue([
        rosterRow(),
        rosterRow({
          id: 'shift-2',
          user_id: 'staff-2',
          full_name: 'Bikash Shrestha',
        }),
      ]);

      const roster = await service.roster(connection(), OWNER, BRANCH_A, {
        week: '2026-10-21',
      });

      expect(roster.staff).toHaveLength(2);
      expect(roster.staff[0].fullName).toBe('Asha Rai');
      expect(roster.staff[0].shifts).toHaveLength(1);
    });

    it('reports the week as Monday to Sunday', async () => {
      const roster = await service.roster(connection(), OWNER, BRANCH_A, {
        week: '2026-10-21',
      });

      expect(roster.weekStart).toBe('2026-10-19');
      expect(roster.weekEnd).toBe('2026-10-25');
    });

    it('reports the scheduled and the worked hours', async () => {
      repository.listRosterRows.mockResolvedValue([rosterRow()]);

      const roster = await service.roster(connection(), OWNER, BRANCH_A, {
        week: '2026-10-21',
      });

      const entry = roster.staff[0].shifts[0];
      expect(entry.scheduledHours).toBe(8);
      expect(entry.hoursWorked).toBe(7.5);
    });

    it('reports a shift nobody clocked in to', async () => {
      repository.listRosterRows.mockResolvedValue([
        rosterRow({
          attendance_id: null,
          clock_in: null,
          clock_out: null,
        }),
      ]);

      const roster = await service.roster(connection(), OWNER, BRANCH_A, {
        week: '2026-10-21',
      });

      const entry = roster.staff[0].shifts[0];
      expect(entry.clockIn).toBeNull();
      expect(entry.hoursWorked).toBeNull();
    });

    it('refuses a branch manager reading another branch', async () => {
      await expect(
        service.roster(connection(), MANAGER, BRANCH_B, {
          week: '2026-10-21',
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);

      expect(repository.listRosterRows).not.toHaveBeenCalled();
    });

    it('refuses a week that is not a date', async () => {
      await expect(
        service.roster(connection(), OWNER, BRANCH_A, { week: 'last week' }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);
    });
  });

  // ----------------------------------------------------------------- payroll

  describe('payroll', () => {
    beforeEach(() => {
      repository.listPayrollAttendance.mockResolvedValue([payrollRow()]);
      repository.listWageRates.mockResolvedValue([wageRate()]);
    });

    it('pays the hours worked', async () => {
      const summary = await service.payroll(connection(), OWNER, BRANCH_A, {
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(summary.lines).toHaveLength(1);
      expect(summary.lines[0].hoursWorked).toBe(7.5);
      expect(summary.lines[0].wage).toBe(750);
      expect(summary.total).toBe(750);
    });

    it('reports the period it covered', async () => {
      const summary = await service.payroll(connection(), OWNER, BRANCH_A, {
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(summary.from).toBe('2026-10-01');
      expect(summary.to).toBe('2026-10-31');
    });

    it('makes the total the sum of the lines', async () => {
      repository.listPayrollAttendance.mockResolvedValue([
        payrollRow(),
        payrollRow({
          user_id: 'staff-2',
          full_name: 'Bikash Shrestha',
          id: 'attendance-2',
          clock_out: new Date('2026-10-21T17:00:00Z'),
        }),
      ]);
      repository.listWageRates.mockResolvedValue([
        wageRate(),
        wageRate({ user_id: 'staff-2', rate: '50.00' }),
      ]);

      const summary = await service.payroll(connection(), OWNER, BRANCH_A, {
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(summary.total).toBe(
        summary.lines.reduce((sum, line) => sum + line.wage, 0),
      );
      expect(summary.total).toBe(750 + 400);
    });

    it('refuses to pay somebody who worked but has no rate', async () => {
      repository.listWageRates.mockResolvedValue([]);

      await expect(
        service.payroll(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
          to: '2026-10-31',
        }),
      ).rejects.toBeInstanceOf(MissingWageRateException);
    });

    it('does not refuse somebody whose shift is still open', async () => {
      repository.listPayrollAttendance.mockResolvedValue([
        payrollRow({ clock_out: null }),
      ]);
      repository.listWageRates.mockResolvedValue([]);

      const summary = await service.payroll(connection(), OWNER, BRANCH_A, {
        from: '2026-10-01',
        to: '2026-10-31',
      });

      expect(summary.lines[0].wage).toBe(0);
      expect(summary.lines[0].openRecords).toBe(1);
    });

    it('refuses a pay type with no strategy', async () => {
      repository.listWageRates.mockResolvedValue([
        wageRate({ pay_type: 'salaried' }),
      ]);

      await expect(
        service.payroll(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
          to: '2026-10-31',
        }),
      ).rejects.toBeInstanceOf(UnsupportedPayTypeException);
    });

    it('refuses a period with only one end given', async () => {
      await expect(
        service.payroll(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);
    });

    it('refuses a period longer than a year', async () => {
      await expect(
        service.payroll(connection(), OWNER, BRANCH_A, {
          from: '2020-01-01',
          to: '2026-10-31',
        }),
      ).rejects.toBeInstanceOf(InvalidDateRangeException);
    });

    it('refuses a branch manager reading another branch', async () => {
      await expect(
        service.payroll(connection(), MANAGER, BRANCH_B, {
          from: '2026-10-01',
          to: '2026-10-31',
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);
    });

    describe('the CSV export', () => {
      it('writes a total equal to the sum of the wages above it', async () => {
        repository.listPayrollAttendance.mockResolvedValue([
          payrollRow(),
          payrollRow({
            user_id: 'staff-2',
            full_name: 'Bikash Shrestha',
            id: 'attendance-2',
            clock_out: new Date('2026-10-21T17:00:00Z'),
          }),
        ]);
        repository.listWageRates.mockResolvedValue([
          wageRate(),
          wageRate({ user_id: 'staff-2', rate: '50.00' }),
        ]);

        const csv = await service.payrollCsv(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
          to: '2026-10-31',
        });

        const rows = csv.trim().split('\r\n');
        const total = Number(rows[rows.length - 1].split(',')[6]);
        const wages = rows
          .slice(1, rows.length - 1)
          .map((row) => Number(row.split(',')[6]));

        expect(total).toBe(wages.reduce((sum, wage) => sum + wage, 0));
        expect(total).toBe(1150);
      });

      it('agrees with the JSON payroll', async () => {
        const summary = await service.payroll(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
          to: '2026-10-31',
        });
        const csv = await service.payrollCsv(connection(), OWNER, BRANCH_A, {
          from: '2026-10-01',
          to: '2026-10-31',
        });

        const rows = csv.trim().split('\r\n');
        const total = Number(rows[rows.length - 1].split(',')[6]);

        expect(total).toBe(summary.total);
      });
    });
  });

  // ------------------------------------------------------------- wage rates

  describe('setWageRate', () => {
    beforeEach(() => {
      repository.findStaffMember.mockResolvedValue(staffMember());
      repository.upsertWageRate.mockResolvedValue(wageRate());
    });

    it('stores the rate', async () => {
      await service.setWageRate(connection(), OWNER, BRANCH_A, STAFF_ID, {
        payType: 'hourly',
        rate: 120,
      });

      expect(repository.upsertWageRate).toHaveBeenCalledWith(
        connection(),
        STAFF_ID,
        'hourly',
        120,
      );
    });

    it('refuses a pay type with no strategy', async () => {
      await expect(
        service.setWageRate(connection(), OWNER, BRANCH_A, STAFF_ID, {
          payType: 'salaried',
          rate: 120,
        }),
      ).rejects.toBeInstanceOf(UnsupportedPayTypeException);

      expect(repository.upsertWageRate).not.toHaveBeenCalled();
    });

    it('refuses a rate that is not a number', async () => {
      for (const rate of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
        await expect(
          service.setWageRate(connection(), OWNER, BRANCH_A, STAFF_ID, {
            payType: 'hourly',
            rate,
          }),
        ).rejects.toBeInstanceOf(InvalidRateException);
      }
    });

    it("refuses a branch manager setting another branch's rate", async () => {
      repository.findStaffMember.mockResolvedValue(
        staffMember({ branchId: BRANCH_B }),
      );

      await expect(
        service.setWageRate(connection(), MANAGER, BRANCH_A, STAFF_ID, {
          payType: 'hourly',
          rate: 120,
        }),
      ).rejects.toBeInstanceOf(StaffBranchAccessDeniedException);
    });
  });

  // -------------------------------------------------------------- helpers

  describe('the clock', () => {
    it('is the source of "now" for the clock-in', async () => {
      repository.findShift.mockResolvedValue(shift());
      repository.findAttendanceForShift.mockResolvedValue(null);
      repository.insertAttendance.mockResolvedValue(attendance());

      service = makeService(repository, '2026-10-21T09:05:00Z');
      await service.clockIn(connection(), STAFF_ACTOR, BRANCH_A, {
        shiftId: 'shift-1',
      });

      expect(repository.insertAttendance).toHaveBeenCalledWith(
        connection(),
        'shift-1',
        new Date('2026-10-21T09:05:00Z'),
      );
    });

    it('is the source of "now" for the default payroll period', async () => {
      repository.listPayrollAttendance.mockResolvedValue([]);

      const summary = await service.payroll(connection(), OWNER, BRANCH_A);

      expect(summary.from).toBe('2026-10-01');
      expect(summary.to).toBe('2026-10-31');
    });
  });
});

describe('isUniqueViolation', () => {
  it('recognises a unique violation', () => {
    expect(
      isUniqueViolation(
        Object.assign(new Error('duplicate'), { code: '23505' }),
      ),
    ).toBe(true);
  });

  it('does not mistake another failure for one', () => {
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
  });
});

describe('CLOCK', () => {
  it('is a stable token every provider can agree on', () => {
    expect(typeof CLOCK).toBe('string');
  });
});
