import { BadRequestException } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { SlugAlreadyTakenException } from './exceptions/slug-already-taken.exception';

export interface TenantOnboardingResult {
  tenantId: string;
  slug: string;
  branchId: string;
  tableIds: string[];
  ownerUserId: string;
}

/**
 * Builder for the tenant onboarding flow.
 *
 * Each fluent step stages a piece of the new tenant. `build()` executes all of
 * them inside ONE database transaction on the supplied connection (expected to
 * be an *unscoped* connection — onboarding runs before the tenant exists, so
 * the builder pins `app.tenant_id` itself after creating the tenant row so the
 * RLS-protected `branches`/`users` inserts pass their WITH CHECK policies).
 *
 * A failure anywhere in `build()` rolls the whole chain back — a half-created
 * tenant is worse than none.
 */
export class TenantOnboardingBuilder {
  private orgName: string | undefined;
  private slug: string | undefined;
  private planId: string | undefined;
  private branchName: string | undefined;
  private branchAddress: string | null | undefined;
  private defaultTables = 0;
  private ownerEmail: string | undefined;
  private ownerPasswordHash: string | undefined;

  constructor(private readonly connection: TenantScopedConnection) {}

  withOrgDetails(name: string, slug: string): this {
    this.orgName = name.trim();
    this.slug = slug.trim().toLowerCase();
    return this;
  }

  withPlan(planId: string | undefined): this {
    this.planId = planId;
    return this;
  }

  withFirstBranch(name: string, address?: string | null): this {
    this.branchName = name.trim();
    this.branchAddress = address?.trim() || null;
    return this;
  }

  withDefaultTables(count: number): this {
    this.defaultTables = Math.max(0, Math.floor(count));
    return this;
  }

  withOwnerAccount(email: string, passwordHash: string): this {
    this.ownerEmail = email.trim().toLowerCase();
    this.ownerPasswordHash = passwordHash;
    return this;
  }

  async build(): Promise<TenantOnboardingResult> {
    this.assertComplete();
    await this.connection.query('BEGIN');

    try {
      await this.assertPlanExists();
      const tenantId = await this.createTenant();
      const branchId = await this.createFirstBranch(tenantId);
      await this.createSubscription(tenantId);
      const tableIds = await this.createDefaultTables(tenantId, branchId);
      const ownerUserId = await this.createOwnerAccount(tenantId, branchId);

      await this.connection.query('COMMIT');
      return {
        tenantId,
        slug: this.slug as string,
        branchId,
        tableIds,
        ownerUserId,
      };
    } catch (error) {
      await this.safelyRollback();
      throw error;
    }
  }

  private assertComplete(): void {
    const missing: string[] = [];
    if (!this.orgName) {
      missing.push('orgName');
    }
    if (!this.slug) {
      missing.push('slug');
    }
    if (!this.branchName) {
      missing.push('branchName');
    }
    if (!this.ownerEmail) {
      missing.push('owner email');
    }
    if (!this.ownerPasswordHash) {
      missing.push('owner passwordHash');
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `Onboarding is incomplete: missing ${missing.join(', ')}`,
      );
    }
  }

  private async assertPlanExists(): Promise<void> {
    if (!this.planId) {
      return;
    }
    const result = await this.connection.query<{ id: string }>(
      'SELECT id FROM plans WHERE id = $1',
      [this.planId],
    );
    if (!result.rows[0]) {
      throw new BadRequestException(`Plan '${this.planId}' does not exist`);
    }
  }

  private async createTenant(): Promise<string> {
    const taken = await this.connection.query<{ id: string }>(
      'SELECT id FROM tenants WHERE slug = $1',
      [this.slug],
    );
    if (taken.rows[0]) {
      throw new SlugAlreadyTakenException(this.slug as string);
    }

    try {
      const result = await this.connection.query<{ id: string }>(
        `INSERT INTO tenants (name, slug, plan_id, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id`,
        [this.orgName, this.slug, this.planId ?? null],
      );
      return result.rows[0].id;
    } catch (error) {
      // Two concurrent onboardings can race through the SELECT above; the
      // unique index on tenants.slug catches the loser here.
      if (this.isUniqueViolation(error)) {
        throw new SlugAlreadyTakenException(this.slug as string);
      }
      throw error;
    }
  }

  private async createFirstBranch(tenantId: string): Promise<string> {
    // Pin RLS for the remaining tenant-owned inserts. `is_local => true`
    // resets the variable at COMMIT/ROLLBACK, so the pooled client is clean.
    await this.connection.query(
      "SELECT set_config('app.tenant_id', $1, true)",
      [tenantId],
    );

    const result = await this.connection.query<{ id: string }>(
      `INSERT INTO branches (tenant_id, name, address)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [tenantId, this.branchName, this.branchAddress],
    );
    return result.rows[0].id;
  }

  private async createSubscription(tenantId: string): Promise<void> {
    if (!this.planId) {
      // Onboarding without a plan leaves the tenant unbilled;
      // SubscriptionService reports that clearly rather than inventing a price.
      return;
    }
    await this.connection.query(
      `INSERT INTO tenant_subscriptions
         (tenant_id, plan_id, status, ends_at)
       VALUES ($1, $2, 'active', now() + interval '30 days')`,
      [tenantId, this.planId],
    );
  }

  private async createDefaultTables(
    tenantId: string,
    branchId: string,
  ): Promise<string[]> {
    const tableIds: string[] = [];
    const count = this.defaultTables;
    for (let i = 1; i <= count; i += 1) {
      const result = await this.connection.query<{ id: string }>(
        `INSERT INTO tables (tenant_id, branch_id, label, seats)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [tenantId, branchId, `T${i}`, 2],
      );
      tableIds.push(result.rows[0].id);
    }
    return tableIds;
  }

  private async createOwnerAccount(
    tenantId: string,
    branchId: string,
  ): Promise<string> {
    const email = this.ownerEmail as string;
    const fullName = email.split('@')[0] || email;
    const result = await this.connection.query<{ id: string }>(
      `INSERT INTO users
         (tenant_id, branch_id, role_id, full_name, email, password_hash)
       VALUES
         ($1, $2, (SELECT id FROM roles WHERE name = 'org_owner'), $3, $4, $5)
       RETURNING id`,
      [tenantId, branchId, fullName, email, this.ownerPasswordHash],
    );
    return result.rows[0].id;
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }

  private async safelyRollback(): Promise<void> {
    try {
      await this.connection.query('ROLLBACK');
    } catch {
      // The transaction may already have failed; a rollback error must not
      // mask the original exception.
    }
  }
}
