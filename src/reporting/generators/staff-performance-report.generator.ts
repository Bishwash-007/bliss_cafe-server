import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import {
  hours,
  money,
  type ReportingRepository,
  type StaffRaw,
} from '../reporting.repository';
import type { ReportBody, ResolvedDateRange } from '../reporting.types';
import { ReportGenerator } from './report-generator';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Orders handled and time worked, per staff member, at one branch.
 *
 * The report is a join of three facts that live in three modules: sales from
 * `orders`, scheduled/actual time from `shifts` + `attendance_records`, and
 * identity/role from `users` + `roles`. Staff with no activity in the period
 * are included with zeroes, because "nobody sold anything" and "this person
 * was not here" are different answers and a missing row cannot express the
 * second.
 */
export class StaffPerformanceReportGenerator extends ReportGenerator<StaffRaw> {
  constructor(
    private readonly repository: ReportingRepository,
    private readonly connection: TenantScopedConnection,
    private readonly branchId: string,
    private readonly range: ResolvedDateRange,
  ) {
    super();
  }

  protected fetchData(): Promise<StaffRaw> {
    return this.repository.fetchStaff(
      this.connection,
      this.branchId,
      this.range,
    );
  }

  protected aggregate(data: StaffRaw): ReportBody {
    const salesByUser = new Map(
      data.sales.map((row) => [
        row.user_id,
        { orderCount: row.order_count, revenue: money(row.revenue) },
      ]),
    );
    const attendanceByUser = new Map(
      data.attendance.map((row) => [
        row.user_id,
        {
          shiftsScheduled: row.shifts_scheduled,
          shiftsAttended: row.shifts_attended,
          openShifts: row.open_shifts,
          hoursWorked: hours(row.hours_worked),
        },
      ]),
    );

    const rows = data.identities.map((person) => {
      const sales = salesByUser.get(person.id) ?? {
        orderCount: 0,
        revenue: 0,
      };
      const attendance = attendanceByUser.get(person.id) ?? {
        shiftsScheduled: 0,
        shiftsAttended: 0,
        openShifts: 0,
        hoursWorked: 0,
      };

      return {
        userId: person.id,
        fullName: person.full_name,
        role: person.role,
        orderCount: sales.orderCount,
        revenue: sales.revenue,
        shiftsScheduled: attendance.shiftsScheduled,
        shiftsAttended: attendance.shiftsAttended,
        hoursWorked: attendance.hoursWorked,
        salesPerHour:
          attendance.hoursWorked === 0
            ? 0
            : round2(sales.revenue / attendance.hoursWorked),
        openShifts: attendance.openShifts,
      };
    });

    const sum = (
      key:
        | 'orderCount'
        | 'revenue'
        | 'shiftsScheduled'
        | 'shiftsAttended'
        | 'hoursWorked'
        | 'openShifts',
    ) => rows.reduce((total, row) => total + row[key], 0);
    const revenue = money(sum('revenue'));
    const hoursWorked = round2(sum('hoursWorked'));

    return {
      type: 'staff-performance',
      title: 'Staff performance report',
      branchId: this.branchId,
      range: { from: this.range.from, to: this.range.to },
      summary: {
        staffCount: rows.length,
        orderCount: sum('orderCount'),
        revenue,
        shiftsScheduled: sum('shiftsScheduled'),
        shiftsAttended: sum('shiftsAttended'),
        hoursWorked,
        openShifts: sum('openShifts'),
        salesPerHour: hoursWorked === 0 ? 0 : round2(revenue / hoursWorked),
      },
      tables: [
        {
          key: 'staff',
          title: 'Performance by staff member',
          columns: [
            { key: 'fullName', label: 'Staff' },
            { key: 'role', label: 'Role' },
            { key: 'orderCount', label: 'Orders' },
            { key: 'revenue', label: 'Revenue' },
            { key: 'shiftsScheduled', label: 'Shifts scheduled' },
            { key: 'shiftsAttended', label: 'Shifts attended' },
            { key: 'hoursWorked', label: 'Hours worked' },
            { key: 'salesPerHour', label: 'Revenue / hour' },
            { key: 'openShifts', label: 'Open shifts' },
          ],
          rows,
          totals: {
            fullName: 'TOTAL',
            orderCount: sum('orderCount'),
            revenue,
            shiftsScheduled: sum('shiftsScheduled'),
            shiftsAttended: sum('shiftsAttended'),
            hoursWorked,
            salesPerHour: hoursWorked === 0 ? 0 : round2(revenue / hoursWorked),
            openShifts: sum('openShifts'),
          },
        },
      ],
    };
  }
}
