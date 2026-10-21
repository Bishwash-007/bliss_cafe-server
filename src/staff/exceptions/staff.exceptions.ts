import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Staff-domain failures, each a distinct class so a caller can branch on the
 * exact reason a write was refused instead of matching on message text. Mirrors
 * `src/inventory/exceptions/inventory.exceptions.ts`.
 */

/** The shift does not exist for this tenant, or the tenant cannot see it. */
export class ShiftNotFoundException extends NotFoundException {
  constructor(shiftId: string) {
    super(`Shift ${shiftId} was not found for this tenant`);
  }
}

/** The staff member does not exist for this tenant. */
export class StaffMemberNotFoundException extends NotFoundException {
  constructor(userId: string) {
    super(`Staff member ${userId} was not found for this tenant`);
  }
}

/**
 * The branch does not exist for this tenant.
 *
 * Distinct from a branch access refusal: the caller may be perfectly allowed
 * to work at this branch, the branch simply is not there. Answering 404 keeps
 * the two apart — a 403 would tell a tenant-wide actor that they are not
 * allowed somewhere they were never allowed anywhere.
 */
export class BranchNotFoundException extends NotFoundException {
  constructor(branchId: string) {
    super(`Branch ${branchId} was not found for this tenant`);
  }
}

/**
 * A branch-scoped caller reached for another branch's roster, shifts or staff.
 *
 * Tenant isolation is enforced everywhere by RLS, and it is NOT enough here: a
 * `branch_manager` of branch A is inside the same tenant as branch B, so RLS
 * happily lets them read B's schedule and B's payroll. Two managers in one cafe
 * would then be editing each other's rosters, and neither set of numbers would
 * look wrong until the pay run.
 *
 * A 403 rather than a 404, deliberately: the branch is in the caller's own
 * tenant and they could legitimately be told it exists, so hiding it would only
 * make the error confusing — and unlike the cross-tenant case, there is nothing
 * here to leak. What is refused is the ACTION, not the knowledge.
 *
 * An `org_owner` or `super_admin` carries no branch in their token and is
 * therefore not refused; see `StaffActor`.
 */
export class StaffBranchAccessDeniedException extends ForbiddenException {
  constructor(reason: string) {
    super(reason);
  }
}

/**
 * A clock-in outside the window around the scheduled start.
 *
 * The window is a policy, not a law: a shift that starts at 09:00 and a
 * clock-in at 09:47 might be a late arrival or a scheduled shift that was
 * moved and never updated. The service refuses it rather than accepting it
 * silently, because an attendance record nobody checked is exactly the kind of
 * bad data that makes a payroll wrong without anyone noticing.
 *
 * The error names BOTH times and the window, so the person correcting it does
 * not have to work out which end was wrong.
 */
export class ClockInOutsideWindowException extends BadRequestException {
  constructor(
    shiftId: string,
    shiftStart: Date,
    clockIn: Date,
    windowMinutes: number,
  ) {
    const earliest = new Date(shiftStart.getTime() - windowMinutes * 60_000);
    const latest = new Date(shiftStart.getTime() + windowMinutes * 60_000);
    super(
      `Clock-in for shift ${shiftId} at ${clockIn.toISOString()} is outside the ` +
        `allowed window. The shift starts at ${shiftStart.toISOString()}, so the ` +
        `clock-in must be between ${earliest.toISOString()} and ` +
        `${latest.toISOString()} (±${windowMinutes} minutes).`,
    );
  }
}

/**
 * A clock-out at or before the clock-in.
 *
 * A zero-length or reversed attendance record is not payable and is not a
 * record of anything. The database has a CHECK for it as well, but the service
 * rejects it first so the caller gets a 400 with a clear message instead of a
 * constraint violation surfacing as a 500 from the driver.
 */
export class ClockOutBeforeClockInException extends BadRequestException {
  constructor(shiftId: string, clockIn: Date, clockOut: Date) {
    super(
      `Clock-out for shift ${shiftId} at ${clockOut.toISOString()} is not after ` +
        `the clock-in at ${clockIn.toISOString()}.`,
    );
  }
}

/**
 * A clock-in for a shift that already has an attendance record.
 *
 * A 409, not a 400: the request is well-formed, it conflicts with the current
 * state of the shift. Retrying it unchanged will not help.
 */
export class AlreadyClockedInException extends ConflictException {
  constructor(shiftId: string) {
    super(
      `Shift ${shiftId} already has an attendance record. A shift can have ` +
        `exactly one, so it cannot be clocked in to twice.`,
    );
  }
}

/**
 * A clock-out for a shift with no open attendance record.
 *
 * Either they never clocked in, or they already clocked out. Both mean there
 * is nothing to close, and the caller needs to know which.
 */
export class NotClockedInException extends ConflictException {
  constructor(shiftId: string) {
    super(
      `Shift ${shiftId} has no open attendance record to clock out of. Clock in ` +
        `first, or check whether the shift was already clocked out.`,
    );
  }
}

/**
 * A clock-in or clock-out for somebody else's shift.
 *
 * The staff member on a shift is taken from the caller's token and never from
 * the request body, so this is only reachable when a manager acts on another
 * person's shift — which this module does not offer, because correcting
 * somebody's attendance is a payroll decision, not a scheduling one.
 */
export class NotYourShiftException extends ForbiddenException {
  constructor(shiftId: string) {
    super(
      `Shift ${shiftId} is not your shift. You can only clock in and out of ` +
        `your own shifts.`,
    );
  }
}

/**
 * A wage rate that is not a real number of money.
 *
 * A 400 — the request is malformed. `NaN` and `Infinity` are the values that
 * matter: both survive a naive `typeof x === 'number'` check and both would
 * poison every payroll total they touched.
 */
export class InvalidRateException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid wage rate: ${reason}`);
  }
}

/**
 * A pay type with no strategy behind it.
 *
 * Distinct from `InvalidRateException` because the fix is different: the rate
 * is a fine number, but nothing knows how to pay it that way. Thrown rather than
 * falling back to the default strategy, because a fallback would pay a
 * salaried manager an hourly rate — a wrong number is much worse than a
 * missing one.
 */
export class UnsupportedPayTypeException extends UnprocessableEntityException {
  constructor(payType: string, supported: readonly string[]) {
    super(
      `Pay type '${payType}' has no wage calculation strategy. Supported pay ` +
        `types: ${supported.join(', ')}.`,
    );
  }
}

/**
 * A staff member who worked hours but has no wage rate configured.
 *
 * Distinct from a rate of zero. A rate of zero is a deliberate answer — an
 * unpaid trainee, a volunteer — and it pays out 0 without complaint. A
 * MISSING rate is a gap in the configuration, and paying it as zero would
 * quietly underpay somebody, which is the one failure mode a payroll must not
 * have.
 *
 * So the payroll refuses to run and names who is missing. That is louder than
 * a number that looks plausible, and the fix — set a rate — is one request
 * away.
 */
export class MissingWageRateException extends UnprocessableEntityException {
  constructor(names: readonly string[]) {
    super(
      `No wage rate is configured for: ${names.join(', ')}. Set a rate before ` +
        `running payroll, otherwise the pay for that work cannot be calculated.`,
    );
  }
}

/**
 * A pay period or roster week that cannot be read as a date.
 *
 * The two date parameters are the easiest thing to get wrong in a request, and
 * a silently misread period would produce a payroll for the wrong dates — which
 * is far worse than a refused request.
 */
export class InvalidDateRangeException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid date range: ${reason}`);
  }
}
