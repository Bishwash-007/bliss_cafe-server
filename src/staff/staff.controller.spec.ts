import { ROLES_KEY } from '../auth/auth.constants';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { StaffController } from './staff.controller';
import type { StaffService } from './staff.service';

/** Roles attached to a handler, or `undefined` when it has no `@Roles`. */
function rolesOf(method: string): string[] | undefined {
  const roles = Reflect.getMetadata(
    ROLES_KEY,
    (StaffController.prototype as never)[method],
  ) as string[] | undefined;
  return roles?.slice().sort();
}

const WRITE = ['branch_manager', 'org_owner', 'super_admin'];
const READ = ['branch_manager', 'org_owner', 'receptionist', 'super_admin'];
const PAYROLL = ['branch_manager', 'org_owner', 'super_admin'];
const ATTENDANCE = [
  'branch_manager',
  'kitchen_staff',
  'org_owner',
  'receptionist',
  'super_admin',
  'waiter',
];

/** The request type the controller's handlers take, re-declared for the tests. */
type AuthedRequest = Parameters<StaffController['listShifts']>[1];

/**
 * A request carrying an authenticated user.
 *
 * The role is what the controller reads, so the helper takes it. Omitting it
 * picks the pairing onboarding actually produces: no branch in the token means
 * an `org_owner`, a real branch means a `branch_manager`.
 */
function request(user: {
  userId?: string;
  branchId?: string | null;
  role?: string;
}): AuthedRequest {
  const branchId = user.branchId ?? null;
  return {
    user: {
      userId: user.userId ?? 'user-1',
      branchId,
      role: user.role ?? (branchId ? 'branch_manager' : 'org_owner'),
    },
  } as unknown as AuthedRequest;
}

function build() {
  const service = {
    createShift: jest.fn(),
    listShifts: jest.fn(),
    getShift: jest.fn(),
    updateShift: jest.fn(),
    deleteShift: jest.fn(),
    clockIn: jest.fn(),
    clockOut: jest.fn(),
    roster: jest.fn(),
    payroll: jest.fn(),
    payrollCsv: jest.fn(),
    setWageRate: jest.fn(),
    getWageRate: jest.fn(),
  };

  const connection = {} as TenantScopedConnection;
  const context = {
    getConnection: () => connection,
  } as unknown as TenantRequestContext;

  return {
    controller: new StaffController(
      service as unknown as StaffService,
      context,
    ),
    service,
    connection,
  };
}

describe('StaffController RBAC', () => {
  it('restricts every schedule write to the three management roles', () => {
    // A shift is a management decision. A waiter changing the roster is a shift
    // lead being asked to do two jobs at once.
    for (const method of ['createShift', 'updateShift', 'deleteShift']) {
      expect(rolesOf(method)).toEqual(WRITE);
    }
  });

  it('lets reception read the roster without letting it change it', () => {
    // Reception needs to know who is on today; it does not set the schedule.
    for (const method of ['listShifts', 'getShift', 'roster']) {
      expect(rolesOf(method)).toEqual(READ);
    }
    expect(rolesOf('createShift')).not.toContain('receptionist');
  });

  it('restricts payroll to the roles that already see money', () => {
    for (const method of [
      'payroll',
      'exportPayroll',
      'setWageRate',
      'getWageRate',
    ]) {
      expect(rolesOf(method)).toEqual(PAYROLL);
    }
  });

  it('keeps a receptionist out of payroll', () => {
    // A receptionist does not need to know what the shift lead earns.
    expect(rolesOf('payroll')).not.toContain('receptionist');
    expect(rolesOf('exportPayroll')).not.toContain('receptionist');
  });

  it('lets every working role clock in and out', () => {
    for (const method of ['clockIn', 'clockOut']) {
      expect(rolesOf(method)).toEqual(ATTENDANCE);
    }
  });

  it('keeps a customer out of the roster and out of attendance', () => {
    for (const method of ['roster', 'clockIn', 'clockOut', 'payroll']) {
      expect(rolesOf(method)).not.toContain('customer');
    }
  });
});

describe('StaffController actor scope', () => {
  it('gives an org_owner no branch, so the role runs the whole org', async () => {
    const { controller, service } = build();

    // Onboarding creates the owner against the DEFAULT branch, so the token
    // carries a branch id. The scope has to come from the ROLE, or the owner
    // is confined to the first branch and refused everywhere else.
    await controller.listShifts(
      'branch-a',
      request({ userId: 'owner-1', branchId: 'branch-a', role: 'org_owner' }),
    );

    expect(service.listShifts).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'owner-1', branchId: null },
      'branch-a',
    );
  });

  it('confines a branch_manager to the branch in their token', async () => {
    const { controller, service } = build();

    await controller.listShifts(
      'branch-b',
      request({
        userId: 'manager-1',
        branchId: 'branch-a',
        role: 'branch_manager',
      }),
    );

    // The service is the one that refuses this; the controller only reports
    // the actor. Confining it here too would mean two places to keep in step.
    expect(service.listShifts).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'manager-1', branchId: 'branch-a' },
      'branch-b',
    );
  });

  it('passes the caller through to attendance', async () => {
    const { controller, service } = build();

    await controller.clockIn(
      'branch-a',
      { shiftId: 'shift-1' },
      request({ userId: 'staff-9', branchId: 'branch-a', role: 'waiter' }),
    );

    expect(service.clockIn).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'staff-9', branchId: 'branch-a' },
      'branch-a',
      { shiftId: 'shift-1' },
    );
  });
});

describe('StaffController routes', () => {
  it('names the payroll file after the branch and the period', async () => {
    const { controller, service } = build();
    service.payrollCsv.mockResolvedValue('the,csv\r\n');
    const res = { setHeader: jest.fn() };

    await controller.exportPayroll(
      'branch-a',
      { from: '2026-10-01', to: '2026-10-31' },
      {
        user: { userId: 'owner-1', branchId: null, role: 'org_owner' },
        res,
      } as unknown as AuthedRequest,
    );

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="payroll-branch-a-2026-10-01-2026-10-31.csv"',
    );
  });

  it('falls back to a plain file name when no period was given', async () => {
    const { controller, service } = build();
    service.payrollCsv.mockResolvedValue('');
    const res = { setHeader: jest.fn() };

    await controller.exportPayroll('branch-a', {}, {
      user: { userId: 'owner-1', branchId: null, role: 'org_owner' },
      res,
    } as unknown as AuthedRequest);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      'attachment; filename="payroll-branch-a-period.csv"',
    );
  });

  it('returns the CSV body unchanged', async () => {
    const { controller, service } = build();
    service.payrollCsv.mockResolvedValue('Staff ID,Name\r\n');

    const body = await controller.exportPayroll(
      'branch-a',
      { from: '2026-10-01', to: '2026-10-31' },
      {
        user: { userId: 'owner-1', branchId: null, role: 'org_owner' },
        res: { setHeader: jest.fn() },
      } as unknown as AuthedRequest,
    );

    expect(body).toBe('Staff ID,Name\r\n');
  });
});
