import { buildReportExport, reportToCsv, reportToPdf } from './report-export';
import type { ReportBody } from './reporting.types';

const body: ReportBody = {
  type: 'test',
  title: 'Test report',
  branchId: 'branch-1',
  range: { from: '2026-01-01', to: '2026-01-02' },
  summary: { orderCount: 2, revenue: 10.5 },
  tables: [
    {
      key: 'rows',
      title: 'Rows',
      columns: [
        { key: 'name', label: 'Name' },
        { key: 'value', label: 'Value' },
      ],
      rows: [
        { name: 'Nguyen, Thi', value: 4.5 },
        { name: 'A "quoted" name', value: 6 },
      ],
      totals: { name: 'TOTAL', value: 10.5 },
    },
  ],
};

const source = { ...body, generatedAt: '2026-10-22T00:00:00.000Z' };

describe('report export', () => {
  it('quotes CSV fields containing commas and quotes', () => {
    const csv = reportToCsv(source);

    expect(csv).toContain('"Nguyen, Thi",4.5');
    expect(csv).toContain('"A ""quoted"" name",6');
    expect(csv).toContain('TOTAL,10.5');
  });

  it('builds a PDF with a real header and trailer', () => {
    const pdf = reportToPdf(source).toString('latin1');

    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/BaseFont /Helvetica');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('returns a named artifact for each format', () => {
    const csv = buildReportExport(source, 'csv');
    const pdf = buildReportExport(source, 'pdf');

    expect(csv.filename).toBe('test-2026-01-01-to-2026-01-02-2026-10-22.csv');
    expect(csv.encoding).toBe('utf8');
    expect(pdf.filename).toBe('test-2026-01-01-to-2026-01-02-2026-10-22.pdf');
    expect(pdf.encoding).toBe('base64');
  });
});
