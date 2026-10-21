/**
 * Public vocabulary for the Reporting module.
 *
 * Every report is a collection of small, serialisable tables plus a summary
 * row. That shape is deliberately boring: the same structure feeds both the
 * JSON response and the CSV/PDF exporters, so a report does not need a second
 * presentation model for every output format.
 */

/** Inclusive calendar dates, as `YYYY-MM-DD`. */
export interface DateRange {
  from: string;
  to: string;
}

/** A range whose bounds have been validated and converted to instants. */
export interface ResolvedDateRange extends DateRange {
  /** `from` at 00:00:00.000 UTC, inclusive. */
  fromInstant: Date;
  /** The day after `to` at 00:00:00.000 UTC, exclusive. */
  toInstant: Date;
}

export type ReportExportType = 'csv' | 'pdf';

/** One value in a report table or summary row. */
export type ReportCell = string | number | boolean | null;

export type ReportRow = Record<string, ReportCell>;

export interface ReportColumn {
  /** Key into `ReportRow`. */
  key: string;
  /** Human-readable heading used by every exporter. */
  label: string;
}

export interface ReportTable {
  /** Stable identifier, useful for clients that want one section only. */
  key: string;
  title: string;
  columns: ReportColumn[];
  rows: ReportRow[];
  /** An optional final row, summed from the rows above it. */
  totals?: ReportRow;
}

/**
 * Everything a concrete report must produce before the base class formats and
 * exports it. Concrete generators override `fetchData()` and `aggregate()` to
 * build this; they never build a file themselves.
 */
export interface ReportBody {
  type: string;
  title: string;
  /** `null` for a platform-wide report. */
  branchId: string | null;
  /** `null` for an all-time platform report. */
  range: DateRange | null;
  summary: ReportRow;
  tables: ReportTable[];
}

export interface ReportExportArtifact {
  type: ReportExportType;
  filename: string;
  contentType: string;
  encoding: 'utf8' | 'base64';
  content: string;
}

/** The finished product of `ReportGenerator.generate()`. */
export interface Report extends ReportBody {
  generatedAt: string;
  export: ReportExportArtifact;
}

/** Called by the base class at each template-method step. */
export type ReportStep = 'fetch' | 'aggregate' | 'format' | 'export';

export interface ReportLifecycleHooks {
  onStep?: (step: ReportStep) => void;
}

/**
 * Revenue is recognised on orders that have been settled.
 *
 * `paid` means the provider confirmed settlement; `completed` is the terminal
 * state after that. `served`/`awaiting_payment` are deliberately excluded:
 * those orders may still be cancelled, and counting them would report money
 * that has not arrived. Cancelled orders are excluded for the same reason.
 *
 * The same list is used by the sales and platform reports and by the tests, so
 * a reconciliation test cannot silently disagree with the report about which
 * rows count.
 */
export const REVENUE_ORDER_STATUSES = ['paid', 'completed'] as const;

/** Order volume counts every order that was not cancelled. */
export const NON_CANCELLED_ORDER_STATUSES = [
  'placed',
  'confirmed',
  'preparing',
  'ready',
  'served',
  'awaiting_payment',
  'paid',
  'completed',
] as const;

/** Stock-out movement types that make up consumption. */
export const CONSUMPTION_MOVEMENT_TYPES = ['usage', 'wastage'] as const;
