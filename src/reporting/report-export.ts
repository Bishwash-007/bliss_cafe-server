import type {
  ReportBody,
  ReportCell,
  ReportExportArtifact,
  ReportExportType,
  ReportTable,
} from './reporting.types';

type ReportSource = ReportBody & { generatedAt: string };

/**
 * CSV and PDF rendering for every report.
 *
 * Keeping both exporters here means a new report inherits them by implementing
 * `fetchData()` and `aggregate()` only. It also means the escaping rules and
 * the PDF writer are tested once rather than once per report type.
 */

function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(values: readonly string[]): string {
  return values.map(escapeCsvField).join(',');
}

function cellText(value: ReportCell | undefined): string {
  if (value === undefined || value === null) {
    return '';
  }
  return String(value);
}

/** `orderCount` -> `Order count`, so a generic summary still reads well. */
function humanize(key: string): string {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

export function reportToCsv(report: ReportSource): string {
  const lines: string[] = [];

  lines.push(csvRow([report.title]));
  lines.push(csvRow(['Generated at', report.generatedAt]));
  if (report.branchId) {
    lines.push(csvRow(['Branch', report.branchId]));
  }
  if (report.range) {
    lines.push(csvRow(['From', report.range.from, 'To', report.range.to]));
  }

  const summaryEntries = Object.entries(report.summary);
  if (summaryEntries.length > 0) {
    lines.push('');
    lines.push(csvRow(['Summary']));
    lines.push(csvRow(['Metric', 'Value']));
    for (const [key, value] of summaryEntries) {
      lines.push(csvRow([humanize(key), cellText(value)]));
    }
  }

  for (const table of report.tables) {
    lines.push('');
    lines.push(csvRow([table.title]));
    lines.push(csvRow(table.columns.map((column) => column.label)));

    for (const row of table.rows) {
      lines.push(
        csvRow(table.columns.map((column) => cellText(row[column.key]))),
      );
    }

    if (table.totals) {
      lines.push(totalsCsvRow(table));
    }
  }

  return `${lines.join('\r\n')}\r\n`;
}

function totalsCsvRow(table: ReportTable): string {
  const totals = table.totals ?? {};
  return csvRow(
    table.columns.map((column, index) => {
      const value = totals[column.key];
      if (index === 0 && value === undefined) {
        return 'TOTAL';
      }
      return cellText(value);
    }),
  );
}

function pdfText(value: ReportCell | undefined): string {
  return cellText(value)
    .replace(/[^\x20-\x7E]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

function pdfLines(report: ReportSource): string[] {
  const lines: string[] = [];
  lines.push(report.title);
  lines.push(`Generated: ${report.generatedAt}`);
  if (report.branchId) {
    lines.push(`Branch: ${report.branchId}`);
  }
  if (report.range) {
    lines.push(`Range: ${report.range.from} to ${report.range.to}`);
  }

  const summaryEntries = Object.entries(report.summary);
  if (summaryEntries.length > 0) {
    lines.push('');
    lines.push('Summary');
    for (const [key, value] of summaryEntries) {
      lines.push(`  ${humanize(key)}: ${cellText(value)}`);
    }
  }

  for (const table of report.tables) {
    lines.push('');
    lines.push(table.title);
    lines.push(
      truncate(
        table.columns.map((column) => truncate(column.label, 22)).join(' | '),
        150,
      ),
    );
    for (const row of table.rows) {
      lines.push(
        truncate(
          table.columns
            .map((column) => truncate(cellText(row[column.key]), 22))
            .join(' | '),
          150,
        ),
      );
    }
    if (table.totals) {
      lines.push(
        truncate(
          table.columns
            .map((column, index) => {
              const value = table.totals?.[column.key];
              return truncate(
                index === 0 && value === undefined ? 'TOTAL' : cellText(value),
                22,
              );
            })
            .join(' | '),
          150,
        ),
      );
    }
  }

  return lines;
}

const PAGE_WIDTH = 792;
const PAGE_HEIGHT = 612;
const LINES_PER_PAGE = 48;

/**
 * A deliberately small, dependency-free PDF writer.
 *
 * It emits one Helvetica text line per report line on a landscape Letter page.
 * That is enough for an operational export and avoids adding a PDF dependency
 * (and its transitive tree) to a module whose brief explicitly says not to
 * over-invest in presentation. Accented names are transliterated to `?` by the
 * ASCII-only font path; if branded or Unicode PDFs become a product
 * requirement, that is the point to adopt a real PDF library.
 */
export function reportToPdf(report: ReportSource): Buffer {
  const sourceLines = pdfLines(report);
  const pages: string[][] = [];
  for (let index = 0; index < sourceLines.length; index += LINES_PER_PAGE) {
    pages.push(sourceLines.slice(index, index + LINES_PER_PAGE));
  }
  if (pages.length === 0) {
    pages.push([]);
  }

  const objects: string[] = [];
  const pageObjectNumbers = pages.map((_, index) => 4 + index * 2);

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageObjectNumbers
    .map((number) => `${number} 0 R`)
    .join(' ')}] /Count ${pages.length} >>`;
  objects[3] =
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  pages.forEach((lines, index) => {
    const contentObject = 3 + index * 2 + 1;
    const pageObject = 4 + index * 2;
    const text = lines.map((line) => `(${pdfText(line)}) Tj T*`).join('\n');
    const stream = [
      'BT',
      '/F1 8 Tf',
      `40 ${PAGE_HEIGHT - 42} Td`,
      '11 TL',
      text,
      'ET',
    ].join('\n');

    objects[contentObject] =
      `<< /Length ${Buffer.byteLength(stream, 'utf8')} >>\n` +
      `stream\n${stream}\nendstream`;
    objects[pageObject] =
      '<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${PAGE_WIDTH} ${PAGE_HEIGHT}] ` +
      `/Resources << /Font << /F1 3 0 R >> >> ` +
      `/Contents ${contentObject} 0 R >>`;
  });

  const objectCount = objects.length - 1;
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];

  for (let number = 1; number <= objectCount; number += 1) {
    offsets[number] = Buffer.byteLength(pdf, 'utf8');
    pdf += `${number} 0 obj\n${objects[number] ?? '<< >>'}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objectCount + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let number = 1; number <= objectCount; number += 1) {
    pdf += `${String(offsets[number] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  pdf +=
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf8');
}

function filenameFor(report: ReportSource, type: ReportExportType): string {
  const period = report.range
    ? `${report.range.from}-to-${report.range.to}`
    : 'all-time';
  const date = report.generatedAt.slice(0, 10);
  return `${report.type}-${period}-${date}.${type}`;
}

export function buildReportExport(
  report: ReportSource,
  type: ReportExportType,
): ReportExportArtifact {
  if (type === 'pdf') {
    return {
      type,
      filename: filenameFor(report, type),
      contentType: 'application/pdf',
      encoding: 'base64',
      content: reportToPdf(report).toString('base64'),
    };
  }

  return {
    type,
    filename: filenameFor(report, type),
    contentType: 'text/csv; charset=utf-8',
    encoding: 'utf8',
    content: reportToCsv(report),
  };
}
