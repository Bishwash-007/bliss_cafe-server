/**
 * Row and domain shapes for the SaaS billing module.
 *
 * `BillingModule` charges the *tenant* for its subscription. It is deliberately
 * separate from `PaymentModule`, which charges the cafe's own guests at
 * checkout. The only connection between the two is `PaymentProviderFactory`:
 * billing never instantiates a Stripe/eSewa/Razorpay client of its own.
 *
 * As everywhere else in this codebase, raw rows keep the database's snake_case
 * shape and `NUMERIC` columns arrive from `pg` as strings. Domain objects are
 * camelCase with money already parsed, so no arithmetic has to remember that
 * `price_monthly` is a string.
 */

/** The one billing cycle length this module bills on. */
export const BILLING_CYCLE_DAYS = 30;

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;
const HUNDRED = 100;

/** Rounds to 2 decimal places, half away from zero. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`Cannot round a non-finite amount: ${value}`);
  }
  const sign = value < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(value) * HUNDRED)) / HUNDRED;
}

/** Reads a Postgres `NUMERIC` (string) as a money number. */
export function money(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  return round2(Number(value));
}

/** Adds whole days to an instant without mutating the input. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * MILLIS_PER_DAY);
}

/**
 * Whole days left before `endsAt`, rounded UP.
 *
 * Rounding up is the customer-friendly direction for proration: on the last
 * partial day of a cycle the tenant still receives value for that day, so an
 * upgrade is prorated against one remaining day rather than zero.
 */
export function daysRemainingUntil(endsAt: Date | null, now: Date): number {
  if (!endsAt) {
    return BILLING_CYCLE_DAYS;
  }
  const remaining = endsAt.getTime() - now.getTime();
  return Math.max(0, Math.ceil(remaining / MILLIS_PER_DAY));
}

/** A plan as the billing module reasons about it. */
export interface BillingPlan {
  readonly id: string;
  readonly name: string;
  readonly priceMonthly: number;
  readonly maxBranches: number;
  readonly maxStaff: number;
}

/** Raw row of `plans`. */
export interface PlanRow {
  id: string;
  name: string;
  max_branches: number;
  max_staff: number;
  price_monthly: string;
  created_at: Date;
}

/** Raw row of `tenant_subscriptions`. */
export interface SubscriptionRow {
  id: string;
  tenant_id: string;
  plan_id: string;
  started_at: Date;
  ends_at: Date | null;
  status: string;
}

/** A subscription joined to its current plan. */
export interface SubscriptionWithPlanRow extends SubscriptionRow {
  plan_name: string;
  price_monthly: string;
  max_branches: number;
  max_staff: number;
}

/** The subscription shape returned by the API. */
export interface SubscriptionView {
  id: string;
  tenantId: string;
  status: string;
  startedAt: string;
  endsAt: string | null;
  plan: BillingPlan;
}

/** Converts a joined row into the public view. */
export function subscriptionView(
  row: SubscriptionWithPlanRow,
): SubscriptionView {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endsAt: row.ends_at ? row.ends_at.toISOString() : null,
    plan: planFromRow(row),
  };
}

/** Extracts the billing plan from a joined subscription row. */
export function planFromRow(
  row: Pick<
    SubscriptionWithPlanRow,
    'plan_id' | 'plan_name' | 'price_monthly' | 'max_branches' | 'max_staff'
  >,
): BillingPlan {
  return {
    id: row.plan_id,
    name: row.plan_name,
    priceMonthly: money(row.price_monthly),
    maxBranches: row.max_branches,
    maxStaff: row.max_staff,
  };
}

/** Converts a raw `plans` row into the billing plan shape. */
export function planFromPlanRow(row: PlanRow): BillingPlan {
  return {
    id: row.id,
    name: row.name,
    priceMonthly: money(row.price_monthly),
    maxBranches: row.max_branches,
    maxStaff: row.max_staff,
  };
}

/** The result of a plan change, including what was charged or credited. */
export interface PlanChangeResult {
  readonly subscription: SubscriptionView;
  readonly previousPlanId: string;
  readonly proration: {
    /** Positive means charge, negative means credit. */
    readonly amount: number;
    readonly daysRemainingInCycle: number;
    readonly cycleDays: number;
  };
  /** The gateway reference when a charge actually happened. */
  readonly providerReference: string | null;
}

/** The result of any state-guarded subscription action. */
export interface SubscriptionActionResult {
  readonly action: string;
  readonly subscription: SubscriptionView;
  readonly chargedAmount: number;
  readonly creditedAmount: number;
  readonly providerReference: string | null;
}

/** One tenant's outcome in a renewal sweep. */
export interface RenewalOutcome {
  readonly tenantId: string;
  readonly status: 'renewed' | 'failed' | 'skipped';
  readonly subscription: SubscriptionView | null;
  readonly reason: string | null;
}

/** The daily renewal sweep's summary. */
export interface RenewalRunSummary {
  readonly checked: number;
  readonly renewed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly outcomes: RenewalOutcome[];
}
