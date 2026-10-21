import {
  fromCents,
  round2,
  sumMoney,
  toCents,
  type PayrollLine,
  type PayrollSummary,
} from '../staff.types';

/**
 * # Payroll CSV
 *
 * Renders a payroll as a CSV file.
 *
 * The format is RFC 4180: fields separated by commas, records on separate
 * lines, and a field that contains a comma, a quote or a newline is wrapped in
 * quotes with its internal quotes doubled. A staff member called
 * `Nguyen, Thi` is a perfectly ordinary name and a naive
 * `name.split(',')` would turn one row into two — which is the kind of bug that
 * shows up in a spreadsheet as a missing person rather than as an error.
 *
 * The header, the per-staff rows and the total row are all written here, and
 * the total is the sum of the SAME rounded values the rows carry. It is not
 * recomputed from the raw hours, because a total that does not add up to the
 * column above it is worse than no total at all — and a reader would have no
 * way to tell which of the two was right.
 */

/** The columns, in order. */
const COLUMNS = [
  'Staff ID',
  'Name',
  'Role',
  'Pay Type',
  'Rate',
  'Hours Worked',
  'Wage',
  'Open Records',
] as const;

/**
 * Escapes one field.
 *
 * The wrapping rule is RFC 4180's: a field needs quoting when it contains a
 * comma, a double quote, a carriage return or a line feed — and a quote inside
 * a quoted field is written twice.
 */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Formats a number for a money column: always two decimal places.
 *
 * Always, not "up to" two — a column where 100 appears as `100` and 100.5 as
 * `100.5` is hard to sum by eye and impossible to import as a currency
 * column without the reader guessing.
 *
 * The amount is put on the cents grid first, so a value that arrived with
 * float noise in the fifteenth decimal place does not print it.
 */
function formatMoney(value: number): string {
  return fromCents(toCents(value)).toFixed(2);
}

/**
 * Formats a number for an hours column: two decimal places, no thousands
 * separator.
 *
 * The separator is left out on purpose — `1,234.50` inside a CSV field would
 * have to be quoted, and a spreadsheet would then read it as text.
 */
function formatHours(value: number): string {
  return round2(value).toFixed(2);
}

function row(values: readonly string[]): string {
  return values.map(escapeCsvField).join(',');
}

/**
 * Renders a payroll as CSV.
 *
 * The rows are the staff members in the order the summary lists them, and the
 * final row is the total. The total is the sum of the wages already printed,
 * so the column and the total always agree.
 */
export function payrollCsv(summary: PayrollSummary): string {
  const lines: string[] = [row(COLUMNS)];

  for (const line of summary.lines) {
    lines.push(csvRowFor(line));
  }

  const total = sumMoney(summary.lines.map((line) => line.wage));
  lines.push(row(['', '', 'TOTAL', '', '', '', formatMoney(total), '']));

  // A trailing newline: the file is a sequence of records, and the last one
  // is a record too. Without it some readers drop the final line.
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * One staff member's row.
 *
 * Exported for the tests, which assert on a single row without having to
 * parse the whole file.
 */
export function csvRowFor(line: PayrollLine): string {
  return row([
    line.userId,
    line.fullName,
    line.role,
    line.payType,
    formatMoney(line.rate),
    formatHours(line.hoursWorked),
    formatMoney(line.wage),
    String(line.openRecords),
  ]);
}
