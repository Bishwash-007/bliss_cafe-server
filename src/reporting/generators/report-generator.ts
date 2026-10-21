import { buildReportExport } from '../report-export';
import type {
  Report,
  ReportBody,
  ReportExportArtifact,
  ReportExportType,
  ReportLifecycleHooks,
} from '../reporting.types';

export type FormattedReport = ReportBody & { generatedAt: string };

/**
 * # ReportGenerator — the Template Method
 *
 * Every report follows exactly one path:
 *
 * ```text
 * generate(type)
 *   -> fetchData()
 *   -> aggregate(data)
 *   -> format(body)
 *   -> export(formatted, type)
 * ```
 *
 * Concrete reports implement only `fetchData()` and `aggregate()`. The
 * orchestration lives here once, which is what stops a new report from
 * forgetting to format, or from quietly exporting raw rows before aggregation.
 *
 * ## Why `generate` is not a normal method
 *
 * TypeScript has no `final`, and a method on a subclass prototype normally
 * wins over the base class. The constructor therefore re-defines `generate`,
 * `format` and `export` as non-writable own properties whose closures call the
 * private steps below. A subclass method with the same name is shadowed; a
 * subclass field with the same name throws at construction time. Neither can
 * skip or reorder a step. `report-generator.spec.ts` proves both cases.
 */
export abstract class ReportGenerator<TRaw> {
  /**
   * Runs the full report pipeline. Non-overridable — see the class comment.
   */
  declare readonly generate: (type?: ReportExportType) => Promise<Report>;

  /**
   * Attaches the generation timestamp and validates the assembled body.
   * Exposed for tests and for callers that already have a body; or at least,
   * exposed so a test can prove it cannot be replaced.
   */
  declare readonly format: (body: ReportBody) => FormattedReport;

  /** Serialises a formatted report. Non-overridable. */
  declare readonly export: (
    formatted: FormattedReport,
    type: ReportExportType,
  ) => ReportExportArtifact;

  protected constructor(private readonly hooks: ReportLifecycleHooks = {}) {
    Object.defineProperty(this, 'generate', {
      value: (type: ReportExportType = 'csv') => this.run(type),
      writable: false,
      configurable: false,
      enumerable: false,
    });
    Object.defineProperty(this, 'format', {
      value: (body: ReportBody) => this.formatBody(body),
      writable: false,
      configurable: false,
      enumerable: false,
    });
    Object.defineProperty(this, 'export', {
      value: (formatted: FormattedReport, type: ReportExportType) =>
        this.exportBody(formatted, type),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  }

  /** Concrete reports fetch exactly the rows they need, and nothing else. */
  protected abstract fetchData(): Promise<TRaw>;

  /** Concrete reports turn raw rows into summary and table data. */
  protected abstract aggregate(data: TRaw): ReportBody;

  private async run(type: ReportExportType): Promise<Report> {
    this.hooks.onStep?.('fetch');
    const data = await this.fetchData();

    this.hooks.onStep?.('aggregate');
    const body = this.aggregate(data);

    this.hooks.onStep?.('format');
    const formatted = this.formatBody(body);

    this.hooks.onStep?.('export');
    const artifact = this.exportBody(formatted, type);

    return { ...formatted, export: artifact };
  }

  private formatBody(body: ReportBody): FormattedReport {
    if (!body.type || !body.title) {
      throw new Error('A report needs a type and a title');
    }

    const tableKeys = new Set<string>();
    for (const table of body.tables) {
      if (tableKeys.has(table.key)) {
        throw new Error(`Duplicate report table key: ${table.key}`);
      }
      tableKeys.add(table.key);

      const columnKeys = new Set<string>();
      for (const column of table.columns) {
        if (columnKeys.has(column.key)) {
          throw new Error(
            `Duplicate column '${column.key}' in report table '${table.key}'`,
          );
        }
        columnKeys.add(column.key);
      }
    }

    return {
      ...body,
      branchId: body.branchId ?? null,
      range: body.range ?? null,
      generatedAt: new Date().toISOString(),
    };
  }

  private exportBody(
    formatted: FormattedReport,
    type: ReportExportType,
  ): ReportExportArtifact {
    return buildReportExport(formatted, type);
  }
}
