import { BadRequestException, StreamableFile } from '@nestjs/common';
import type { Request } from 'express';
import type { Report, ReportExportType } from './reporting.types';

export type RequestedReportFormat = 'json' | 'csv' | 'pdf';

const FORMATS: RequestedReportFormat[] = ['json', 'csv', 'pdf'];

export function parseReportFormat(
  value: string | undefined,
): RequestedReportFormat {
  if (value === undefined || value.trim() === '') {
    return 'json';
  }
  if (!FORMATS.includes(value as RequestedReportFormat)) {
    throw new BadRequestException(
      `format must be one of ${FORMATS.join(', ')}`,
    );
  }
  return value as RequestedReportFormat;
}

export function exportTypeFor(format: RequestedReportFormat): ReportExportType {
  return format === 'pdf' ? 'pdf' : 'csv';
}

/** A finished report body (for JSON) or a serialised file. */
export type ReportResponse = Omit<Report, 'export'> | string | StreamableFile;

/**
 * Turns the finished report into the requested representation.
 *
 * `json` returns the report body without the serialised artifact: the default
 * response should be a data structure, not an embedded CSV string. File
 * formats set `Content-Disposition` through `req.res`, following the payroll
 * export pattern, so the browser saves a named file instead of a page.
 *
 * PDF bytes are wrapped in a `StreamableFile`. Returning a raw `Buffer` from a
 * Nest handler makes the framework's serialiser decide what it is, which is
 * how binary PDFs end up JSON-encoded as `{"type":"Buffer",...}`.
 */
export function sendReport(
  req: Request,
  report: Report,
  format: RequestedReportFormat,
): ReportResponse {
  if (format === 'json') {
    const { export: _export, ...body } = report;
    return body;
  }

  req.res?.setHeader('Content-Type', report.export.contentType);
  req.res?.setHeader(
    'Content-Disposition',
    `attachment; filename="${report.export.filename}"`,
  );

  if (report.export.encoding === 'base64') {
    return new StreamableFile(Buffer.from(report.export.content, 'base64'), {
      type: report.export.contentType,
      disposition: `attachment; filename="${report.export.filename}"`,
    });
  }

  return report.export.content;
}
