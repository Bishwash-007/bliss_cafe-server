import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { PlanRow, SubscriptionWithPlanRow } from './billing.types';

/**
 * Data access for `tenant_subscriptions` and `plans`.
 *
 * ## RLS and the platform tables
 *
 * `tenant_subscriptions` is RLS-protected (migration 010), so every call takes
 * the tenant-scoped connection and filters by `tenant_id` as a second layer.
 * `plans` and `tenants` are platform tables with no RLS policy, so reading them
 * through the same connection is safe and does not widen what a tenant can see.
 *
 * ## Why there is no `DELETE`
 *
 * Billing history is never deleted. Cancelling flips `status`; the row remains
 * so a later audit can answer "what was this tenant paying, and when".
 */
@Injectable()
export class BillingRepository {
  /**
   * The tenant's current subscription, joined to its plan.
   *
   * `ORDER BY started_at DESC` defines "current" as the newest row. The schema
   * has no unique-current constraint (adding one would be a migration and a
   * data-cleanup exercise), so the service also serialises writes with
   * `FOR UPDATE` where a state change is about to happen.
   */
  async findCurrentWithPlan(
    connection: TenantScopedConnection,
    tenantId: string,
    forUpdate = false,
  ): Promise<SubscriptionWithPlanRow | null> {
    const result = await connection.query<SubscriptionWithPlanRow>(
      `SELECT s.id,
              s.tenant_id,
              s.plan_id,
              s.started_at,
              s.ends_at,
              s.status,
              p.name          AS plan_name,
              p.price_monthly AS price_monthly,
              p.max_branches,
              p.max_staff
         FROM tenant_subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1
        ORDER BY s.started_at DESC, s.id DESC
        LIMIT 1
        ${forUpdate ? 'FOR UPDATE OF s' : ''}`,
      [tenantId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The newest subscription for one tenant that is due for renewal, locked for
   * the duration of the transaction.
   *
   * `FOR UPDATE` is what stops two app instances from charging the same tenant
   * twice: the second waits, then re-evaluates the WHERE clause against the
   * committed row, whose `ends_at` has already moved into the future.
   */
  async findDueForUpdate(
    connection: TenantScopedConnection,
    tenantId: string,
    now: Date,
  ): Promise<SubscriptionWithPlanRow | null> {
    const result = await connection.query<SubscriptionWithPlanRow>(
      `SELECT s.id,
              s.tenant_id,
              s.plan_id,
              s.started_at,
              s.ends_at,
              s.status,
              p.name          AS plan_name,
              p.price_monthly AS price_monthly,
              p.max_branches,
              p.max_staff
         FROM tenant_subscriptions s
         JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = $1
          AND s.id = (
                SELECT current.id
                  FROM tenant_subscriptions current
                 WHERE current.tenant_id = $1
                 ORDER BY current.started_at DESC, current.id DESC
                 LIMIT 1
              )
          AND s.status IN ('active', 'trialing')
          AND s.ends_at IS NOT NULL
          AND s.ends_at <= $2
        FOR UPDATE OF s`,
      [tenantId, now],
    );
    return result.rows[0] ?? null;
  }

  async findPlanById(
    connection: TenantScopedConnection,
    planId: string,
  ): Promise<PlanRow | null> {
    const result = await connection.query<PlanRow>(
      `SELECT id, name, max_branches, max_staff, price_monthly, created_at
         FROM plans
        WHERE id = $1`,
      [planId],
    );
    return result.rows[0] ?? null;
  }

  async listPlans(connection: TenantScopedConnection): Promise<PlanRow[]> {
    const result = await connection.query<PlanRow>(
      `SELECT id, name, max_branches, max_staff, price_monthly, created_at
         FROM plans
        ORDER BY price_monthly, name`,
    );
    return result.rows;
  }

  /**
   * Moves a subscription to another plan and mirrors the change onto
   * `tenants.plan_id`, in the caller's transaction.
   *
   * Both writes matter: `tenants.plan_id` is what branch/staff limits and the
   * platform report read, while `tenant_subscriptions.plan_id` is the billing
   * history. Updating only one would make the tenant's limits and its invoice
   * disagree.
   */
  async changePlan(
    connection: TenantScopedConnection,
    tenantId: string,
    subscriptionId: string,
    planId: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE tenant_subscriptions
          SET plan_id = $3
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, subscriptionId, planId],
    );
    await connection.query(
      `UPDATE tenants
          SET plan_id = $2,
              updated_at = now()
        WHERE id = $1`,
      [tenantId, planId],
    );
  }

  /**
   * Writes a new lifecycle status and period end.
   *
   * The conditional `status <> 'cancelled'` makes cancellation terminal even if
   * a stale renewal job reaches this row: a cancelled subscription can never be
   * moved back to active by a background write.
   */
  async setStatus(
    connection: TenantScopedConnection,
    tenantId: string,
    subscriptionId: string,
    status: string,
    endsAt: Date | null,
  ): Promise<SubscriptionWithPlanRow | null> {
    const result = await connection.query<SubscriptionWithPlanRow>(
      `WITH updated AS (
         UPDATE tenant_subscriptions
            SET status = $3,
                ends_at = $4
          WHERE tenant_id = $1
            AND id = $2
            AND status <> 'cancelled'
          RETURNING id, tenant_id, plan_id, started_at, ends_at, status
       )
       SELECT u.id,
              u.tenant_id,
              u.plan_id,
              u.started_at,
              u.ends_at,
              u.status,
              p.name          AS plan_name,
              p.price_monthly AS price_monthly,
              p.max_branches,
              p.max_staff
         FROM updated u
         JOIN plans p ON p.id = u.plan_id`,
      [tenantId, subscriptionId, status, endsAt],
    );
    return result.rows[0] ?? null;
  }

  /**
   * The status-only update used when a charge fails.
   *
   * `ends_at` is intentionally left untouched: the unpaid period's end date is
   * the evidence of what was due, and `past_due` is the durable marker that it
   * was not paid.
   */
  async markPastDue(
    connection: TenantScopedConnection,
    tenantId: string,
    subscriptionId: string,
  ): Promise<SubscriptionWithPlanRow | null> {
    const result = await connection.query<SubscriptionWithPlanRow>(
      `WITH updated AS (
         UPDATE tenant_subscriptions
            SET status = 'past_due'
          WHERE tenant_id = $1
            AND id = $2
            AND status <> 'cancelled'
          RETURNING id, tenant_id, plan_id, started_at, ends_at, status
       )
       SELECT u.id,
              u.tenant_id,
              u.plan_id,
              u.started_at,
              u.ends_at,
              u.status,
              p.name          AS plan_name,
              p.price_monthly AS price_monthly,
              p.max_branches,
              p.max_staff
         FROM updated u
         JOIN plans p ON p.id = u.plan_id`,
      [tenantId, subscriptionId],
    );
    return result.rows[0] ?? null;
  }
}
