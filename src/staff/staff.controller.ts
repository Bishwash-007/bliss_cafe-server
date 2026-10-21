import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  ClockDto,
  CreateShiftDto,
  PayrollQueryDto,
  RosterQueryDto,
  SetWageRateDto,
  UpdateShiftDto,
} from './dto/staff.dto';
import { StaffService } from './staff.service';
import type { StaffActor } from './staff.types';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Who may read a roster.
 *
 * A roster is schedule information, which the people on it need to see and
 * the people who write it need to see. A customer has no business seeing it.
 */
const STAFF_READ_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
];

/**
 * Who may write the schedule.
 *
 * The same three roles the inventory module uses for its writes, for the same
 * reason: a shift is a management decision, and a waiter changing the roster
 * is a shift lead being asked to do two jobs at once.
 */
const STAFF_WRITE_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Who may read a payroll.
 *
 * Money. Not the whole staff team — a receptionist does not need to know what
 * the shift lead earns.
 */
const STAFF_PAYROLL_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Who may clock in and out.
 *
 * Every role that works a shift. A `customer` is not staff.
 */
const STAFF_ATTENDANCE_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
  'kitchen_staff',
];

/**
 * Staff scheduling, attendance and payroll.
 *
 * Every route lives under `/branches/:branchId`, because every staff
 * operation is about one branch. The branch is in the PATH rather than in the
 * body for that reason: it is part of what the operation is about, and a
 * body field would be one more thing that could disagree with the URL.
 *
 * ## Coexisting with `BranchController`
 *
 * `BranchController` is rooted at `/branches` too, and this controller is
 * rooted at `/branches/:branchId`. Nest registers the two sets of routes side
 * by side and they do not collide, because the branch routes end in `/tables`
 * and the staff routes all end in a segment of their own — `roster`, `shifts`,
 * `attendance`, `payroll`, `wage-rates`.
 *
 * The alternative — putting the roster on `BranchController` — would make
 * `BranchModule` depend on `StaffModule`, so the branch module would own a
 * feature it knows nothing about. This way the dependency runs the other way,
 * or not at all.
 */
@Controller('branches/:branchId')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StaffController {
  constructor(
    private readonly staffService: StaffService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  /**
   * Who is asking, and how far they may reach.
   *
   * The scope comes from the ROLE, not from the presence of a branch in the
   * token. Onboarding creates the `org_owner` against the tenant's default
   * branch, so `org_owner.branchId` is a real branch id even though the role
   * runs the whole org. Keying the scope off the id would confine the owner to
   * the first branch and refuse them everywhere else.
   *
   * `branch_manager` is the role that is confined to one branch, and there the
   * token's branch is authoritative. It is never taken from a request
   * parameter: a parameter is caller-controlled, so it would be a one-query
   * bypass.
   */
  private actor(req: AuthedRequest): StaffActor {
    const user = req.user;
    const runsTheOrg =
      user?.role === 'org_owner' || user?.role === 'super_admin';
    return {
      userId: user?.userId ?? '',
      branchId: runsTheOrg ? null : (user?.branchId ?? null),
    };
  }

  // ------------------------------------------------------------------ shifts

  @Post('shifts')
  @Roles(...STAFF_WRITE_ROLES)
  createShift(
    @Param('branchId') branchId: string,
    @Body() body: CreateShiftDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.createShift(
      this.connection(),
      this.actor(req),
      branchId,
      body,
    );
  }

  @Get('shifts')
  @Roles(...STAFF_READ_ROLES)
  listShifts(@Param('branchId') branchId: string, @Req() req: AuthedRequest) {
    return this.staffService.listShifts(
      this.connection(),
      this.actor(req),
      branchId,
    );
  }

  @Get('shifts/:id')
  @Roles(...STAFF_READ_ROLES)
  getShift(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.staffService.getShift(this.connection(), this.actor(req), id);
  }

  @Patch('shifts/:id')
  @Roles(...STAFF_WRITE_ROLES)
  updateShift(
    @Param('id') id: string,
    @Body() body: UpdateShiftDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.updateShift(
      this.connection(),
      this.actor(req),
      id,
      body,
    );
  }

  /**
   * `204`, not `200 {}`: there is no representation left to return, and a body
   * claiming success would be the only thing a client could check.
   */
  @Delete('shifts/:id')
  @HttpCode(204)
  @Roles(...STAFF_WRITE_ROLES)
  async deleteShift(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.staffService.deleteShift(this.connection(), this.actor(req), id);
  }

  // --------------------------------------------------------------- attendance

  @Post('attendance/clock-in')
  @Roles(...STAFF_ATTENDANCE_ROLES)
  clockIn(
    @Param('branchId') branchId: string,
    @Body() body: ClockDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.clockIn(
      this.connection(),
      this.actor(req),
      branchId,
      body,
    );
  }

  @Post('attendance/clock-out')
  @Roles(...STAFF_ATTENDANCE_ROLES)
  clockOut(
    @Param('branchId') branchId: string,
    @Body() body: ClockDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.clockOut(
      this.connection(),
      this.actor(req),
      branchId,
      body,
    );
  }

  // ------------------------------------------------------------------ roster

  @Get('roster')
  @Roles(...STAFF_READ_ROLES)
  roster(
    @Param('branchId') branchId: string,
    @Query() query: RosterQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.roster(
      this.connection(),
      this.actor(req),
      branchId,
      query,
    );
  }

  // ----------------------------------------------------------------- payroll

  @Get('payroll')
  @Roles(...STAFF_PAYROLL_ROLES)
  payroll(
    @Param('branchId') branchId: string,
    @Query() query: PayrollQueryDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.payroll(
      this.connection(),
      this.actor(req),
      branchId,
      query,
    );
  }

  /**
   * The same payroll as a CSV file.
   *
   * `Content-Disposition` names the file, so a browser saves it as a payroll
   * rather than as `payroll`. The name carries the period, which matters when
   * several exports land in the same folder at the end of a month.
   *
   * The header is set through `req.res` rather than through Nest's `@Res()`:
   * taking over the response object would stop Nest from serialising the
   * return value, and the body has to be the CSV itself.
   */
  @Get('payroll/export')
  @Roles(...STAFF_PAYROLL_ROLES)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportPayroll(
    @Param('branchId') branchId: string,
    @Query() query: PayrollQueryDto,
    @Req() req: AuthedRequest,
  ): Promise<string> {
    const csv = await this.staffService.payrollCsv(
      this.connection(),
      this.actor(req),
      branchId,
      query,
    );
    const period =
      query.from && query.to ? `${query.from}-${query.to}` : 'period';
    req.res?.setHeader(
      'Content-Disposition',
      `attachment; filename="payroll-${branchId}-${period}.csv"`,
    );
    return csv;
  }

  // -------------------------------------------------------------- wage rates

  @Put('wage-rates/:userId')
  @Roles(...STAFF_PAYROLL_ROLES)
  setWageRate(
    @Param('branchId') branchId: string,
    @Param('userId') userId: string,
    @Body() body: SetWageRateDto,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.setWageRate(
      this.connection(),
      this.actor(req),
      branchId,
      userId,
      body,
    );
  }

  @Get('wage-rates/:userId')
  @Roles(...STAFF_PAYROLL_ROLES)
  getWageRate(
    @Param('branchId') branchId: string,
    @Param('userId') userId: string,
    @Req() req: AuthedRequest,
  ) {
    return this.staffService.getWageRate(
      this.connection(),
      this.actor(req),
      branchId,
      userId,
    );
  }
}
