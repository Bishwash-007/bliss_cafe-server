import { Inject, Injectable, Logger } from '@nestjs/common';
import { PaymentProviderFactory } from '../payment';
import type { PaymentResult } from '../payment';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { BillingRepository } from './billing.repository';
import {
  BILLING_CYCLE_DAYS,
  addDays,
  daysRemainingUntil,
  money,
  planFromPlanRow,
  planFromRow,
  subscriptionView,
  type BillingPlan,
  type PlanChangeResult,
  type RenewalOutcome,
  type RenewalRunSummary,
  type SubscriptionActionResult,
  type SubscriptionView,
  type SubscriptionWithPlanRow,
} from './billing.types';
import { BILLING_CLOCK, type BillingClock } from './clock';
import {
  InvalidPlanChangeException,
  InvalidSubscriptionActionException,
  MissingPlanChangeTargetException,
  PlanNotFoundException,
  SubscriptionChargeFailedException,
  SubscriptionNotFoundException,
} from './exceptions/billing.exceptions';
import {
  PRORATION_STRATEGY,
  type ProrationStrategy,
} from './proration/proration.strategy';
import { isSubscriptionAction } from './state/subscription-state';
import { subscriptionStateFor } from './state/subscription-state.factory';

export interface PerformActionOptions {
  /** Required for `upgrade` and `downgrade`. */
  planId?: string;
}

/**
 * # SubscriptionService
 *
 * The lifecycle hub for a tenant's SaaS subscription: reads, state-guarded
 * actions, prorated plan changes and the daily renewal sweep.
 *
 * ## Why it acquires its own connection
 *
 * The module brief specifies `performAction(tenantId, action)` — no connection
 * parameter — so the service owns the transaction boundary. That also makes the
 * renewal sweep, which runs from a cron with no HTTP request, use exactly the
 * same code path as an owner pressing "retry payment".
 *
 * ## Charging
 *
 * Every charge goes through `PaymentProviderFactory.getProvider(tenantId)`
 * imported from `PaymentModule`. This module contains no Stripe/eSewa/Razorpay
 * client, no API keys and no signature logic. It sees only `PaymentResult`.
 *
 * ## Failure semantics
 *
 * A renewal charge that does not settle commits `past_due` BEFORE the exception
 * leaves this class. That ordering is the whole point: rolling the status
 * change back would leave the subscription looking `active` while no money
 * arrived, which is exactly the silent failure the brief forbids.
 */
@Injectable()
export class SubscriptionService {
  private readonly logger = new Logger(SubscriptionService.name);

  constructor(
    private readonly repository: BillingRepository,
    private readonly connections: TenantConnectionService,
    private readonly providers: PaymentProviderFactory,
    @Inject(PRORATION_STRATEGY)
    private readonly proration: ProrationStrategy,
    @Inject(BILLING_CLOCK) private readonly clock: BillingClock,
  ) {}

  // ------------------------------------------------------------------ reads

  /** The tenant's current subscription, or a 404 when onboarding created none. */
  async getSubscription(tenantId: string): Promise<SubscriptionView> {
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      const row = await this.repository.findCurrentWithPlan(
        connection,
        tenantId,
      );
      if (!row) {
        throw new SubscriptionNotFoundException(tenantId);
      }
      await connection.commit();
      return subscriptionView(row);
    } catch (error) {
      await this.releaseAfterError(connection);
      throw error;
    }
  }

  /** Every plan, cheapest first, for the owner-facing plan picker. */
  async listPlans(tenantId: string): Promise<BillingPlan[]> {
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      const rows = await this.repository.listPlans(connection);
      await connection.commit();
      return rows.map(planFromPlanRow);
    } catch (error) {
      await this.releaseAfterError(connection);
      throw error;
    }
  }

  // ---------------------------------------------------------------- actions

  /**
   * Performs one state-guarded action.
   *
   * The state's `allowedActions()` is consulted before any work happens, so a
   * `past_due` tenant asking to upgrade is refused without reading a plan,
   * calling a gateway or writing a row.
   */
  async performAction(
    tenantId: string,
    action: string,
    options: PerformActionOptions = {},
  ): Promise<SubscriptionActionResult> {
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      const row = await this.repository.findCurrentWithPlan(
        connection,
        tenantId,
        true,
      );
      if (!row) {
        throw new SubscriptionNotFoundException(tenantId);
      }

      const state = subscriptionStateFor(row.status);
      if (!isSubscriptionAction(action)) {
        throw new InvalidSubscriptionActionException(
          action,
          row.status,
          state.allowedActions(),
        );
      }

      const allowed = state.allowedActions();
      if (!state.can(action)) {
        throw new InvalidSubscriptionActionException(
          action,
          row.status,
          allowed,
        );
      }

      switch (action) {
        case 'cancel':
          return await this.cancel(connection, tenantId, row);
        case 'upgrade':
        case 'downgrade':
          return await this.changePlan(
            connection,
            tenantId,
            row,
            action,
            options.planId,
          );
        case 'renew':
        case 'retry_payment':
          return await this.renew(connection, tenantId, row, action);
      }
    } catch (error) {
      await this.releaseAfterError(connection);
      throw error;
    }
  }

  // --------------------------------------------------------------- renewal

  /**
   * The daily sweep: finds every active/trialing subscription whose period has
   * ended and attempts to renew it.
   *
   * One tenant's failure never aborts the run. It is committed as `past_due`,
   * recorded in the summary and the next tenant is processed.
   */
  async renewDueSubscriptions(
    now: Date = this.clock.now(),
  ): Promise<RenewalRunSummary> {
    const tenants = await this.connections.listActiveTenants();
    const outcomes: RenewalOutcome[] = [];

    for (const tenant of tenants) {
      try {
        outcomes.push(await this.renewTenantIfDue(tenant.id, now));
      } catch (error) {
        const reason = messageOf(error);
        this.logger.error(
          `Unexpected billing renewal failure for tenant ${tenant.id}: ${reason}`,
        );
        outcomes.push({
          tenantId: tenant.id,
          status: 'failed',
          subscription: null,
          reason,
        });
      }
    }

    return {
      checked: tenants.length,
      renewed: outcomes.filter((outcome) => outcome.status === 'renewed')
        .length,
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'skipped')
        .length,
      outcomes,
    };
  }

  private async renewTenantIfDue(
    tenantId: string,
    now: Date,
  ): Promise<RenewalOutcome> {
    const connection = await this.connections.acquireScoped(tenantId);
    let due: SubscriptionWithPlanRow | null = null;
    try {
      due = await this.repository.findDueForUpdate(connection, tenantId, now);
      if (!due) {
        await connection.commit();
        return {
          tenantId,
          status: 'skipped',
          subscription: null,
          reason: null,
        };
      }

      const result = await this.renew(connection, tenantId, due, 'renew', now);
      return {
        tenantId,
        status: 'renewed',
        subscription: result.subscription,
        reason: null,
      };
    } catch (error) {
      await this.releaseAfterError(connection);
      const reason = messageOf(error);
      this.logger.warn(
        `Billing renewal failed for tenant ${tenantId}: ${reason}`,
      );
      return {
        tenantId,
        status: 'failed',
        subscription: null,
        reason,
      };
    }
  }

  // ---------------------------------------------------------------- helpers

  private async cancel(
    connection: TenantScopedConnection,
    tenantId: string,
    row: SubscriptionWithPlanRow,
  ): Promise<SubscriptionActionResult> {
    const now = this.clock.now();
    const updated = await this.repository.setStatus(
      connection,
      tenantId,
      row.id,
      'cancelled',
      now,
    );
    if (!updated) {
      throw new SubscriptionNotFoundException(tenantId);
    }
    await connection.commit();
    return {
      action: 'cancel',
      subscription: subscriptionView(updated),
      chargedAmount: 0,
      creditedAmount: 0,
      providerReference: null,
    };
  }

  private async changePlan(
    connection: TenantScopedConnection,
    tenantId: string,
    row: SubscriptionWithPlanRow,
    action: 'upgrade' | 'downgrade',
    planId: string | undefined,
  ): Promise<SubscriptionActionResult> {
    if (!planId) {
      throw new MissingPlanChangeTargetException(action);
    }

    const targetRow = await this.repository.findPlanById(connection, planId);
    if (!targetRow) {
      throw new PlanNotFoundException(planId);
    }

    const oldPlan = planFromRow(row);
    const newPlan = planFromPlanRow(targetRow);
    if (newPlan.id === oldPlan.id) {
      throw new InvalidPlanChangeException(action, oldPlan.id, newPlan.id);
    }

    const actualDirection =
      newPlan.priceMonthly > oldPlan.priceMonthly ? 'upgrade' : 'downgrade';
    if (
      newPlan.priceMonthly === oldPlan.priceMonthly ||
      actualDirection !== action
    ) {
      throw new InvalidPlanChangeException(action, oldPlan.id, newPlan.id);
    }

    const now = this.clock.now();
    const daysRemaining = daysRemainingUntil(row.ends_at, now);
    const amount = this.proration.calculate(oldPlan, newPlan, daysRemaining);

    let providerReference: string | null = null;
    if (amount > 0) {
      const charge = await this.chargeOrThrow(
        tenantId,
        amount,
        this.chargeReference(row, now, `plan_${newPlan.id.slice(0, 8)}`),
      );
      providerReference = charge.providerReference;
    }

    await this.repository.changePlan(connection, tenantId, row.id, newPlan.id);
    const updated = await this.repository.findCurrentWithPlan(
      connection,
      tenantId,
    );
    if (!updated) {
      throw new SubscriptionNotFoundException(tenantId);
    }
    await connection.commit();

    const result: PlanChangeResult = {
      subscription: subscriptionView(updated),
      previousPlanId: oldPlan.id,
      proration: {
        amount,
        daysRemainingInCycle: daysRemaining,
        cycleDays: BILLING_CYCLE_DAYS,
      },
      providerReference,
    };

    return {
      action,
      subscription: result.subscription,
      chargedAmount: Math.max(0, amount),
      creditedAmount: Math.max(0, -amount),
      providerReference: result.providerReference,
    };
  }

  /**
   * Charges one billing period and moves the subscription to `active`, or
   * commits `past_due` and throws.
   *
   * The new `ends_at` is calculated from whichever is later: now, or the
   * existing period end. Renewing early therefore extends the paid term rather
   * than discarding the remaining days.
   *
   * ## Provider limitation (flagged, not hidden)
   *
   * The shared adapter contract has no card-on-file token or idempotency key.
   * Stripe `charge` needs a configured `paymentMethod`, Razorpay's `charge`
   * creates a gateway order (`pending`), and eSewa calls its charge product.
   * A non-`succeeded` outcome is therefore treated as an unpaid period and moves
   * the subscription to `past_due`; it is never optimistically extended.
   *
   * There is also a narrow crash window between a successful gateway charge and
   * the local COMMIT. Closing it needs an invoice ledger with the provider
   * reference written before the charge and reconciled after; that is a schema
   * change, documented in the module's deliberate-gaps note rather than
   * simulated here.
   */
  private async renew(
    connection: TenantScopedConnection,
    tenantId: string,
    row: SubscriptionWithPlanRow,
    action: 'renew' | 'retry_payment',
    now: Date = this.clock.now(),
  ): Promise<SubscriptionActionResult> {
    const plan = planFromRow(row);
    let providerReference: string | null = null;

    if (plan.priceMonthly > 0) {
      try {
        const charge = await this.chargeOrThrow(
          tenantId,
          plan.priceMonthly,
          this.chargeReference(row, now, 'renew'),
        );
        providerReference = charge.providerReference;
      } catch (error) {
        await this.commitPastDue(connection, tenantId, row.id);
        throw error;
      }
    }

    const base =
      row.ends_at && row.ends_at.getTime() > now.getTime() ? row.ends_at : now;
    const updated = await this.repository.setStatus(
      connection,
      tenantId,
      row.id,
      'active',
      addDays(base, BILLING_CYCLE_DAYS),
    );
    if (!updated) {
      throw new SubscriptionNotFoundException(tenantId);
    }

    await connection.commit();
    return {
      action,
      subscription: subscriptionView(updated),
      chargedAmount: plan.priceMonthly,
      creditedAmount: 0,
      providerReference,
    };
  }

  /**
   * Delegates to `PaymentModule`. The factory owns provider selection,
   * decryption and construction; this method only asserts the outcome.
   */
  private async chargeOrThrow(
    tenantId: string,
    amount: number,
    reference: string,
  ): Promise<PaymentResult> {
    try {
      const provider = await this.providers.getProvider(tenantId);
      const result = await provider.charge(money(amount), reference);
      if (result.status !== 'succeeded') {
        throw new SubscriptionChargeFailedException(
          tenantId,
          `provider '${result.provider}' returned '${result.status}'`,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof SubscriptionChargeFailedException) {
        throw error;
      }
      throw new SubscriptionChargeFailedException(tenantId, messageOf(error));
    }
  }

  private async commitPastDue(
    connection: TenantScopedConnection,
    tenantId: string,
    subscriptionId: string,
  ): Promise<void> {
    try {
      await this.repository.markPastDue(connection, tenantId, subscriptionId);
      await connection.commit();
    } catch (error) {
      await this.releaseAfterError(connection);
      this.logger.error(
        `Failed to record past_due for tenant ${tenantId}: ${messageOf(error)}`,
      );
    }
  }

  /** A gateway-facing reference that fits provider receipt limits. */
  private chargeReference(
    row: SubscriptionWithPlanRow,
    now: Date,
    suffix: string,
  ): string {
    const compact = row.id.replace(/-/g, '').slice(0, 16);
    const day = now.toISOString().slice(0, 10).replace(/-/g, '');
    return `sub_${compact}_${day}_${suffix}`.slice(0, 64);
  }

  private async releaseAfterError(
    connection: TenantScopedConnection,
  ): Promise<void> {
    if (connection.isReleased) {
      return;
    }
    try {
      await connection.rollback();
    } catch (error) {
      this.logger.warn(
        `Rolling back billing connection failed: ${messageOf(error)}`,
      );
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
