import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { CustomerRow, LoyaltyAccountRow, PromotionRow } from './crm.types';

/**
 * PostgreSQL `23505` (unique_violation).
 *
 * Exported so the service can tell "somebody else created this phone a moment
 * ago" — in which case the right answer is to return THEIR row — apart from a
 * genuine constraint failure.
 */
export const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is shaped like a UUID.
 *
 * Checked before it reaches a `WHERE id = $2`, because Postgres raises `22P02`
 * for a malformed uuid and that surfaces as an opaque 500 instead of a 404.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** The writable columns of `promotions`, in one place. */
const PROMOTION_COLUMNS = `id, tenant_id, code, description, discount_type,
  discount_value, starts_at, ends_at, is_active`;

const CUSTOMER_COLUMNS = `id, tenant_id, full_name, phone, email, created_at`;

const LOYALTY_COLUMNS = `id, tenant_id, customer_id, points_balance, tier, updated_at`;

export interface CreatePromotionInput {
  code: string;
  description: string | null;
  discountType: string;
  discountValue: number;
  startsAt: Date | null;
  endsAt: Date | null;
  isActive: boolean;
}

export interface PromotionPatch {
  code?: string;
  description?: string | null;
  discountType?: string;
  discountValue?: number;
  startsAt?: Date | null;
  endsAt?: Date | null;
  isActive?: boolean;
}

/** The claim result of crediting one order. */
export interface CreditResult {
  /** False when the order already has a `loyalty_credits` row. */
  credited: boolean;
  account: LoyaltyAccountRow | null;
}

/**
 * Data access for customers, loyalty accounts and promotions.
 *
 * Every statement filters by `tenant_id` as well as relying on RLS. The two
 * are independent protections: a forgotten predicate is then a caught bug
 * rather than a breach. The same rule as the inventory and staff repositories.
 */
@Injectable()
export class CrmRepository {
  // ---------------------------------------------------------------- customers

  async findCustomerByPhone(
    connection: TenantScopedConnection,
    phone: string,
  ): Promise<CustomerRow | null> {
    const result = await connection.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM customers
        WHERE tenant_id = $1 AND phone = $2`,
      [this.tenantId(connection), phone],
    );
    return result.rows[0] ?? null;
  }

  async findCustomerById(
    connection: TenantScopedConnection,
    customerId: string,
  ): Promise<CustomerRow | null> {
    if (!isUuid(customerId)) {
      return null;
    }
    const result = await connection.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM customers
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), customerId],
    );
    return result.rows[0] ?? null;
  }

  async listCustomers(
    connection: TenantScopedConnection,
    limit: number,
  ): Promise<CustomerRow[]> {
    const result = await connection.query<CustomerRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM customers
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [this.tenantId(connection), limit],
    );
    return result.rows;
  }

  async insertCustomer(
    connection: TenantScopedConnection,
    input: {
      phone: string;
      fullName: string | null;
      email: string | null;
    },
  ): Promise<CustomerRow> {
    const result = await connection.query<CustomerRow>(
      `INSERT INTO customers (tenant_id, phone, full_name, email)
            VALUES ($1, $2, $3, $4)
         RETURNING ${CUSTOMER_COLUMNS}`,
      [this.tenantId(connection), input.phone, input.fullName, input.email],
    );
    return result.rows[0];
  }

  // ------------------------------------------------------------------ loyalty

  async findLoyaltyAccount(
    connection: TenantScopedConnection,
    customerId: string,
  ): Promise<LoyaltyAccountRow | null> {
    if (!isUuid(customerId)) {
      return null;
    }
    const result = await connection.query<LoyaltyAccountRow>(
      `SELECT ${LOYALTY_COLUMNS}
         FROM loyalty_accounts
        WHERE tenant_id = $1 AND customer_id = $2`,
      [this.tenantId(connection), customerId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Returns the customer's loyalty account, creating a zero-balance one if it
   * does not exist.
   *
   * `ON CONFLICT DO NOTHING` rather than a check-then-insert: two simultaneous
   * lookups for a customer made before this module existed must not race into
   * a unique violation.
   */
  async ensureLoyaltyAccount(
    connection: TenantScopedConnection,
    customerId: string,
  ): Promise<LoyaltyAccountRow> {
    const tenantId = this.tenantId(connection);
    await connection.query(
      `INSERT INTO loyalty_accounts (tenant_id, customer_id, points_balance)
            VALUES ($1, $2, 0)
       ON CONFLICT (tenant_id, customer_id) DO NOTHING`,
      [tenantId, customerId],
    );
    const account = await this.findLoyaltyAccount(connection, customerId);
    if (!account) {
      throw new Error(
        `Loyalty account for customer ${customerId} could not be created or read.`,
      );
    }
    return account;
  }

  /**
   * Credits `points` for `orderId` exactly once.
   *
   * The UNIQUE `(tenant_id, order_id)` index is the gate. The insert and the
   * balance update run inside the caller's transaction, so a failure between
   * them rolls both back; a duplicate delivery inserts nothing and the account
   * is left untouched.
   *
   * A zero-point credit still writes the ledger row. That is deliberate: a
   * 99.99 order earns no points today, but it must still be marked "seen" so a
   * redelivery cannot combine with a later price change into a credit nobody
   * expected.
   */
  async creditLoyalty(
    connection: TenantScopedConnection,
    input: {
      orderId: string;
      customerId: string;
      points: number;
    },
  ): Promise<CreditResult> {
    const tenantId = this.tenantId(connection);

    const claimed = await connection.query<{ id: string }>(
      `INSERT INTO loyalty_credits (tenant_id, order_id, customer_id, points)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, order_id) DO NOTHING
         RETURNING id`,
      [tenantId, input.orderId, input.customerId, input.points],
    );

    if (!claimed.rows[0]) {
      return {
        credited: false,
        account: await this.findLoyaltyAccount(connection, input.customerId),
      };
    }

    if (input.points <= 0) {
      return {
        credited: true,
        account: await this.findLoyaltyAccount(connection, input.customerId),
      };
    }

    const updated = await connection.query<LoyaltyAccountRow>(
      `INSERT INTO loyalty_accounts (tenant_id, customer_id, points_balance)
            VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, customer_id)
       DO UPDATE SET points_balance = loyalty_accounts.points_balance
                                      + EXCLUDED.points_balance,
                     updated_at = now()
         RETURNING ${LOYALTY_COLUMNS}`,
      [tenantId, input.customerId, input.points],
    );

    return { credited: true, account: updated.rows[0] };
  }

  /**
   * The order fields loyalty needs, read from the durable row.
   *
   * The event carries `totalAmount` too, but the database row is the record the
   * credit is audited against. Reading it also tells us whether the order has a
   * customer at all — a walk-in takeaway has nobody to credit.
   */
  async findOrderForLoyalty(
    connection: TenantScopedConnection,
    orderId: string,
  ): Promise<{ customer_id: string | null; total_amount: string } | null> {
    if (!isUuid(orderId)) {
      return null;
    }
    const result = await connection.query<{
      customer_id: string | null;
      total_amount: string;
    }>(
      `SELECT customer_id, total_amount
         FROM orders
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), orderId],
    );
    return result.rows[0] ?? null;
  }

  // --------------------------------------------------------------- promotions

  async insertPromotion(
    connection: TenantScopedConnection,
    input: CreatePromotionInput,
  ): Promise<PromotionRow> {
    const result = await connection.query<PromotionRow>(
      `INSERT INTO promotions (tenant_id, code, description, discount_type,
                               discount_value, starts_at, ends_at, is_active)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${PROMOTION_COLUMNS}`,
      [
        this.tenantId(connection),
        input.code,
        input.description,
        input.discountType,
        input.discountValue,
        input.startsAt,
        input.endsAt,
        input.isActive,
      ],
    );
    return result.rows[0];
  }

  async findPromotionById(
    connection: TenantScopedConnection,
    promotionId: string,
  ): Promise<PromotionRow | null> {
    if (!isUuid(promotionId)) {
      return null;
    }
    const result = await connection.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS}
         FROM promotions
        WHERE tenant_id = $1 AND id = $2`,
      [this.tenantId(connection), promotionId],
    );
    return result.rows[0] ?? null;
  }

  async findPromotionByCode(
    connection: TenantScopedConnection,
    code: string,
  ): Promise<PromotionRow | null> {
    const result = await connection.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS}
         FROM promotions
        WHERE tenant_id = $1 AND code = $2`,
      [this.tenantId(connection), code],
    );
    return result.rows[0] ?? null;
  }

  async listPromotions(
    connection: TenantScopedConnection,
    options: { activeOnly: boolean; limit: number },
  ): Promise<PromotionRow[]> {
    const result = await connection.query<PromotionRow>(
      `SELECT ${PROMOTION_COLUMNS}
         FROM promotions
        WHERE tenant_id = $1
          AND ($2 = false OR is_active = true)
        ORDER BY is_active DESC, code ASC
        LIMIT $3`,
      [this.tenantId(connection), options.activeOnly, options.limit],
    );
    return result.rows;
  }

  /**
   * Changes a promotion.
   *
   * Only the columns the caller actually sent are in the `SET` list. The column
   * names come from a fixed allowlist, never from the request; every value is a
   * bound parameter.
   */
  async updatePromotion(
    connection: TenantScopedConnection,
    promotionId: string,
    patch: PromotionPatch,
  ): Promise<PromotionRow | null> {
    if (!isUuid(promotionId)) {
      return null;
    }

    const assignments: string[] = [];
    const values: unknown[] = [this.tenantId(connection), promotionId];
    const add = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (patch.code !== undefined) add('code', patch.code);
    if (patch.description !== undefined) {
      add('description', patch.description);
    }
    if (patch.discountType !== undefined) {
      add('discount_type', patch.discountType);
    }
    if (patch.discountValue !== undefined) {
      add('discount_value', patch.discountValue);
    }
    if (patch.startsAt !== undefined) add('starts_at', patch.startsAt);
    if (patch.endsAt !== undefined) add('ends_at', patch.endsAt);
    if (patch.isActive !== undefined) add('is_active', patch.isActive);

    if (assignments.length === 0) {
      return this.findPromotionById(connection, promotionId);
    }

    const result = await connection.query<PromotionRow>(
      `UPDATE promotions
          SET ${assignments.join(', ')}
        WHERE tenant_id = $1 AND id = $2
        RETURNING ${PROMOTION_COLUMNS}`,
      values,
    );
    return result.rows[0] ?? null;
  }

  // ------------------------------------------------------------------ helpers

  /**
   * Runs `work` inside a SAVEPOINT.
   *
   * A unique violation aborts the enclosing transaction in Postgres (`25P02` on
   * every statement after it), so a recovery read — "who won the insert
   * race?" — is only possible if the failed insert happened in a savepoint.
   * The same helper exists in `OrderRepository`; it is four statements and
   * keeping it local is cheaper than making one feature's repository a shared
   * utility.
   */
  async withSavepoint<T>(
    connection: TenantScopedConnection,
    work: () => Promise<T>,
  ): Promise<T> {
    const name = `crm_sp_${++this.savepointCounter}`;
    await connection.query(`SAVEPOINT ${name}`);
    try {
      const value = await work();
      await connection.query(`RELEASE SAVEPOINT ${name}`);
      return value;
    } catch (error) {
      await connection
        .query(`ROLLBACK TO SAVEPOINT ${name}`)
        .catch(() => undefined);
      await connection
        .query(`RELEASE SAVEPOINT ${name}`)
        .catch(() => undefined);
      throw error;
    }
  }

  /** Unique per connection, so nested savepoints cannot collide. */
  private savepointCounter = 0;

  private tenantId(connection: TenantScopedConnection): string {
    const tenantId = connection.tenantId;
    if (tenantId === null) {
      throw new Error(
        'CRM query requires a tenant-scoped connection, but this connection ' +
          'has no tenant pinned.',
      );
    }
    return tenantId;
  }
}
