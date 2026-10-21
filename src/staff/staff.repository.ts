import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  AttendanceRecordRow,
  PayrollAttendanceRow,
  RosterRow,
  ShiftPatch,
  ShiftRow,
  StaffMember,
  StaffWageRateRow,
} from './staff.types';

/**
 * PostgreSQL raises `23505` (unique_violation) when the unique index
 * `idx_attendance_one_per_shift` rejects a second attendance record for a
 * shift.
 *
 * Exported so the service can tell "somebody else clocked in to this shift a
 * moment ago" — which is a 409 — apart from a genuine constraint failure.
 *
 * The database is the authority here, not a check in the service. Two clock-ins
 * arriving at the same instant both pass a check-then-act, and the second one
 * would silently win. The unique index makes the second one fail, always.
 */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is shaped like a UUID.
 *
 * Checked before a UUID reaches a `WHERE id = $2` comparison, because
 * Postgres raises `22P02` (invalid_text_representation) for a malformed UUID
 * and that arrives as an opaque 500 rather than a 404. A bad id is a bad
 * request, and it should be refused as one.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Data access for shifts, attendance and wage rates.
 *
 * Every statement is filtered by `tenant_id` as well as relying on RLS — the
 * two are independent, so a forgotten predicate is a caught bug rather than a
 * breach.
 */
@Injectable()
export class StaffRepository {
  // ------------------------------------------------------------------ shifts

  async findShift(
    connection: TenantScopedConnection,
    shiftId: string,
  ): Promise<ShiftRow | null> {
    if (!isUuid(shiftId)) {
      return null;
    }
    const result = await connection.query<ShiftRow>(
      `SELECT id, tenant_id, branch_id, user_id, start_time, end_time, created_at
         FROM shifts
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), shiftId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Every shift at a branch, newest first.
   *
   * Bounded by an optional window so the list cannot grow without limit as a
   * tenant accumulates schedule history.
   */
  async listShifts(
    connection: TenantScopedConnection,
    branchId: string,
    window?: { from: Date; to: Date },
  ): Promise<ShiftRow[]> {
    const values: unknown[] = [this.tenantId(connection), branchId];
    let predicate = '';
    if (window) {
      values.push(window.from, window.to);
      predicate = ' AND s.start_time < $4 AND s.end_time > $3';
    }
    const result = await connection.query<ShiftRow>(
      `SELECT s.id, s.tenant_id, s.branch_id, s.user_id, s.start_time,
              s.end_time, s.created_at
         FROM shifts s
        WHERE s.tenant_id = $1 AND s.branch_id = $2${predicate}
        ORDER BY s.start_time DESC, s.id`,
      values,
    );
    return result.rows;
  }

  async insertShift(
    connection: TenantScopedConnection,
    branchId: string,
    userId: string,
    startTime: Date,
    endTime: Date,
  ): Promise<ShiftRow> {
    const result = await connection.query<ShiftRow>(
      `INSERT INTO shifts (tenant_id, branch_id, user_id, start_time, end_time)
            VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant_id, branch_id, user_id, start_time, end_time, created_at`,
      [this.tenantId(connection), branchId, userId, startTime, endTime],
    );
    return result.rows[0];
  }

  /**
   * Changes a shift.
   *
   * A real partial update, not a `COALESCE` over every column: the `SET` list
   * is built from the keys the caller actually sent, so an absent field is
   * never written. Only the column NAMES are interpolated, and they come from
   * a fixed allowlist rather than from the request, so nothing user-supplied
   * reaches the SQL text. Every value is still a bound parameter.
   *
   * The caller is expected to have validated the MERGED result — a shift whose
   * start is moved past its end would violate the table's CHECK, and the
   * service checks that before it gets here.
   */
  async updateShift(
    connection: TenantScopedConnection,
    shiftId: string,
    patch: ShiftPatch,
  ): Promise<ShiftRow | null> {
    const columns: ReadonlyArray<readonly [keyof ShiftPatch, string]> = [
      ['userId', 'user_id'],
      ['startTime', 'start_time'],
      ['endTime', 'end_time'],
    ];
    const values: unknown[] = [this.tenantId(connection), shiftId];
    const sets: string[] = [];
    for (const [key, column] of columns) {
      if (!(key in patch)) {
        continue;
      }
      values.push(patch[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) {
      // An empty PATCH is a no-op, not an error: report the shift as it stands
      // so the caller gets a 200 with the current state.
      return this.findShift(connection, shiftId);
    }
    const result = await connection.query<ShiftRow>(
      `UPDATE shifts
          SET ${sets.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING id, tenant_id, branch_id, user_id, start_time, end_time, created_at`,
      values,
    );
    return result.rows[0] ?? null;
  }

  async deleteShift(
    connection: TenantScopedConnection,
    shiftId: string,
  ): Promise<boolean> {
    const result = await connection.query(
      `DELETE FROM shifts WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), shiftId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  // -------------------------------------------------------------- attendance

  async findAttendanceForShift(
    connection: TenantScopedConnection,
    shiftId: string,
  ): Promise<AttendanceRecordRow | null> {
    const result = await connection.query<AttendanceRecordRow>(
      `SELECT id, tenant_id, shift_id, clock_in, clock_out, created_at
         FROM attendance_records
        WHERE tenant_id = $1 AND shift_id = $2`,
      [this.tenantId(connection), shiftId],
    );
    return result.rows[0] ?? null;
  }

  async insertAttendance(
    connection: TenantScopedConnection,
    shiftId: string,
    clockIn: Date,
  ): Promise<AttendanceRecordRow> {
    const result = await connection.query<AttendanceRecordRow>(
      `INSERT INTO attendance_records (tenant_id, shift_id, clock_in)
            VALUES ($1, $2, $3)
         RETURNING id, tenant_id, shift_id, clock_in, clock_out, created_at`,
      [this.tenantId(connection), shiftId, clockIn],
    );
    return result.rows[0];
  }

  /**
   * Closes an open attendance record.
   *
   * The `clock_out IS NULL` is in the WHERE clause, not in the application
   * logic: it makes the update itself the test, so two clock-outs arriving at
   * once cannot both succeed. The second one updates zero rows and the service
   * turns that into a 409.
   */
  async closeAttendance(
    connection: TenantScopedConnection,
    shiftId: string,
    clockOut: Date,
  ): Promise<AttendanceRecordRow | null> {
    const result = await connection.query<AttendanceRecordRow>(
      `UPDATE attendance_records
          SET clock_out = $3
        WHERE tenant_id = $1 AND shift_id = $2 AND clock_out IS NULL
        RETURNING id, tenant_id, shift_id, clock_in, clock_out, created_at`,
      [this.tenantId(connection), shiftId, clockOut],
    );
    return result.rows[0] ?? null;
  }

  // ------------------------------------------------------------------- roster

  /**
   * The shifts at a branch that overlap a window, with their staff member and
   * their attendance record.
   *
   * The overlap test is `start < windowEnd AND end > windowStart`, not
   * "starts within the window": a shift that runs from Sunday evening into
   * Monday morning belongs to both weeks, and a roster that silently dropped
   * it would under-report the hours the branch is open.
   *
   * The attendance JOIN is a LEFT JOIN, so a shift nobody clocked in to is
   * still a shift. That is the difference between a roster and a timesheet.
   */
  async listRosterRows(
    connection: TenantScopedConnection,
    branchId: string,
    from: Date,
    to: Date,
  ): Promise<RosterRow[]> {
    const result = await connection.query<RosterRow>(
      `SELECT s.id, s.user_id, u.full_name, r.name AS role,
              s.start_time, s.end_time,
              a.id AS attendance_id, a.clock_in, a.clock_out
         FROM shifts s
         JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN attendance_records a
                ON a.shift_id = s.id AND a.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
          AND s.branch_id = $2
          AND s.start_time < $4
          AND s.end_time > $3
        ORDER BY u.full_name, s.start_time, s.id`,
      [this.tenantId(connection), branchId, from, to],
    );
    return result.rows;
  }

  // ------------------------------------------------------------------ payroll

  /**
   * Every attendance record in a pay period, for one branch, with the staff
   * member it belongs to.
   *
   * A record belongs to the period when its CLOCK-IN falls inside it, and the
   * period is `[from, to + 1 day)` — a half-open range, so a shift ending
   * exactly at midnight belongs to the day it started and no record is
   * counted twice.
   *
   * The period is applied to `a.clock_in` and not to the shift's times: what
   * the payroll pays for is time actually worked, and a shift that was
   * scheduled for last month but clocked in to today is this month's pay.
   */
  async listPayrollAttendance(
    connection: TenantScopedConnection,
    branchId: string,
    from: Date,
    to: Date,
  ): Promise<PayrollAttendanceRow[]> {
    const result = await connection.query<PayrollAttendanceRow>(
      `SELECT u.id AS user_id, u.full_name, r.name AS role,
              a.id, a.tenant_id, a.shift_id, a.clock_in, a.clock_out
         FROM attendance_records a
         JOIN shifts s ON s.id = a.shift_id AND s.tenant_id = a.tenant_id
         JOIN users u ON u.id = s.user_id AND u.tenant_id = s.tenant_id
         JOIN roles r ON r.id = u.role_id
        WHERE a.tenant_id = $1
          AND s.branch_id = $2
          AND a.clock_in >= $3
          AND a.clock_in < $4
        ORDER BY u.full_name, a.clock_in, a.id`,
      [this.tenantId(connection), branchId, from, to],
    );
    return result.rows;
  }

  // ------------------------------------------------------------- wage rates

  async listWageRates(
    connection: TenantScopedConnection,
  ): Promise<StaffWageRateRow[]> {
    const result = await connection.query<StaffWageRateRow>(
      `SELECT id, tenant_id, user_id, pay_type, rate, created_at, updated_at
         FROM staff_wage_rates
        WHERE tenant_id = $1
        ORDER BY user_id`,
      [this.tenantId(connection)],
    );
    return result.rows;
  }

  async findWageRate(
    connection: TenantScopedConnection,
    userId: string,
  ): Promise<StaffWageRateRow | null> {
    const result = await connection.query<StaffWageRateRow>(
      `SELECT id, tenant_id, user_id, pay_type, rate, created_at, updated_at
         FROM staff_wage_rates
        WHERE tenant_id = $1 AND user_id = $2`,
      [this.tenantId(connection), userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Writes a staff member's rate, replacing any previous one.
   *
   * An UPSERT rather than an INSERT that can fail: a rate is configuration, and
   * the natural way to change one is to set the new value. The unique index on
   * `(tenant_id, user_id)` is what makes this a single row per person.
   */
  async upsertWageRate(
    connection: TenantScopedConnection,
    userId: string,
    payType: string,
    rate: number,
  ): Promise<StaffWageRateRow> {
    const result = await connection.query<StaffWageRateRow>(
      `INSERT INTO staff_wage_rates (tenant_id, user_id, pay_type, rate)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, user_id)
       DO UPDATE SET pay_type = EXCLUDED.pay_type,
                     rate = EXCLUDED.rate,
                     updated_at = now()
         RETURNING id, tenant_id, user_id, pay_type, rate, created_at, updated_at`,
      [this.tenantId(connection), userId, payType, rate],
    );
    return result.rows[0];
  }

  // ------------------------------------------------------------- lookups

  /**
   * A staff member of this tenant, with their role.
   *
   * Used to check that a shift belongs to somebody who is actually in this
   * tenant. Without it, a shift could be scheduled for a user id from another
   * tenant — and under RLS that shift would then be invisible to everybody
   * except the caller who made it, which is a very confusing way to lose a
   * roster.
   */
  async findStaffMember(
    connection: TenantScopedConnection,
    userId: string,
  ): Promise<StaffMember | null> {
    if (!isUuid(userId)) {
      return null;
    }
    const result = await connection.query<StaffMember>(
      `SELECT u.id AS "userId", u.full_name AS "fullName", r.name AS role,
              u.branch_id AS "branchId"
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [this.tenantId(connection), userId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Whether a branch exists in this tenant.
   *
   * Checked before a shift is scheduled so that a shift cannot be filed
   * against a branch the caller cannot see. Under RLS the INSERT itself would
   * fail with a foreign key error, which arrives as an opaque 500; this turns
   * it into a clean 404.
   */
  async branchExists(
    connection: TenantScopedConnection,
    branchId: string,
  ): Promise<boolean> {
    if (!isUuid(branchId)) {
      return false;
    }
    const result = await connection.query<{ exists: boolean }>(
      `SELECT EXISTS (
                SELECT 1 FROM branches
                 WHERE tenant_id = $1 AND id = $2
               ) AS exists`,
      [this.tenantId(connection), branchId],
    );
    return result.rows[0]?.exists === true;
  }

  private tenantId(connection: TenantScopedConnection): string {
    const tenantId = connection.tenantId;
    if (tenantId === null) {
      throw new Error(
        'Staff query requires a tenant-scoped connection, but this connection ' +
          'has no tenant pinned. Acquire it with ' +
          'TenantConnectionService.acquireScoped(tenantId).',
      );
    }
    return tenantId;
  }
}
