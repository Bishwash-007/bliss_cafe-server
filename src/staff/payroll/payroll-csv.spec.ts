import type { PayrollLine, PayrollSummary } from '../staff.types';
import { escapeCsvField, payrollCsv } from './payroll-csv';

function line(overrides: Partial<PayrollLine> = {}): PayrollLine {
  return {
    userId: 'user-1',
    fullName: 'Asha Rai',
    role: 'waiter',
    payType: 'hourly',
    rate: 100,
    hoursWorked: 7.5,
    wage: 750,
    openRecords: 0,
    ...overrides,
  };
}

function summary(lines: PayrollLine[]): PayrollSummary {
  return {
    branchId: 'branch-1',
    from: '2026-10-01',
    to: '2026-10-31',
    lines,
    total: lines.reduce((sum, entry) => sum + entry.wage, 0),
  };
}

describe('payrollCsv', () => {
  it('writes the column names as the first line', () => {
    const csv = payrollCsv(summary([line()]));

    expect(csv.split('\r\n')[0]).toBe(
      'Staff ID,Name,Role,Pay Type,Rate,Hours Worked,Wage,Open Records',
    );
  });

  it('writes one row per staff member', () => {
    const csv = payrollCsv(summary([line(), line({ userId: 'user-2' })]));

    const rows = csv.trim().split('\r\n');
    // header + 2 staff + total
    expect(rows).toHaveLength(4);
    expect(rows[1]).toContain('user-1');
    expect(rows[2]).toContain('user-2');
  });

  it('ends with a total row', () => {
    const csv = payrollCsv(summary([line()]));

    const rows = csv.trim().split('\r\n');
    expect(rows[rows.length - 1]).toContain('TOTAL');
  });

  it('writes a total equal to the sum of the wages above it', () => {
    const lines = [
      line({ wage: 750 }),
      line({ userId: 'user-2', wage: 250.5 }),
      line({ userId: 'user-3', wage: 99.99 }),
    ];
    const csv = payrollCsv(summary(lines));

    const rows = csv.trim().split('\r\n');
    const total = Number(rows[rows.length - 1].split(',')[6]);

    expect(total).toBe(lines.reduce((sum, entry) => sum + entry.wage, 0));
  });

  it('writes a zero total when nobody worked', () => {
    const csv = payrollCsv(summary([]));

    const rows = csv.trim().split('\r\n');
    expect(rows[rows.length - 1]).toContain('0.00');
  });

  it('formats money with exactly two decimal places', () => {
    const csv = payrollCsv(summary([line({ rate: 100, wage: 750 })]));

    const rows = csv.trim().split('\r\n');
    expect(rows[1]).toContain(',100.00,');
    expect(rows[1]).toContain(',750.00,');
  });

  it('formats hours with two decimal places', () => {
    const csv = payrollCsv(summary([line({ hoursWorked: 7.5 })]));

    const rows = csv.trim().split('\r\n');
    expect(rows[1]).toContain('7.50');
  });

  it('ends the file with a newline', () => {
    // Without it some readers drop the last record — the total row.
    expect(payrollCsv(summary([line()])).endsWith('\r\n')).toBe(true);
  });
});

describe('escapeCsvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(escapeCsvField('Asha Rai')).toBe('Asha Rai');
  });

  it('quotes a value containing a comma', () => {
    // A naive `split(',')` would turn one row into two, and the mistake would
    // show up in a spreadsheet as a missing person rather than as an error.
    expect(escapeCsvField('Nguyen, Thi')).toBe('"Nguyen, Thi"');
  });

  it('doubles a quote inside a quoted value', () => {
    expect(escapeCsvField('Ana "Annie" Silva')).toBe('"Ana ""Annie"" Silva"');
  });

  it('quotes a value containing a newline', () => {
    expect(escapeCsvField('line one\nline two')).toBe('"line one\nline two"');
  });

  it('quotes an empty value only when it would otherwise be ambiguous', () => {
    // An empty field is written as nothing, which is what RFC 4180 says.
    expect(escapeCsvField('')).toBe('');
  });
});
