import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { PaymentConfigRow, PaymentRow } from './payment.types';

/** `23505` = unique_violation. */
const UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === UNIQUE_VIOLATION
  );
}

export interface CreatePaymentInput {
  orderId: string;
  provider: string;
  providerReference: string;
  method: string;
  amount: string;
  receivedBy: string | null;
}

/**
 * Data access for `tenant_payment_configs` and `payments`.
 *
 * Every statement filters on `tenant_id` as well as relying on RLS — the same
 * belt-and-braces rule the rest of the repository layer follows.
 *
 * ## Settlement is a conditional UPDATE
 *
 * `markSucceeded` and `markFailed` only move a row out of `pending`. That single
 * `WHERE` is the module's idempotency guarantee: whichever webhook delivery
 * (or racing app instance) wins the UPDATE publishes `order.paid`; every later
 * copy updates zero rows and the service reports it as a duplicate. No
 * application-level "already processed?" read-then-write is involved, because
 * two concurrent requests both pass that check.
 */
@Injectable()
export class PaymentRepository {
  // ------------------------------------------------------------------ config

  async listConfigs(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<PaymentConfigRow[]> {
    const result = await connection.query<PaymentConfigRow>(
      `SELECT id, tenant_id, provider, config_encrypted, is_active
         FROM tenant_payment_configs
        WHERE tenant_id = $1
        ORDER BY provider`,
      [tenantId],
    );
    return result.rows;
  }

  async findConfigByProvider(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
  ): Promise<PaymentConfigRow | null> {
    const result = await connection.query<PaymentConfigRow>(
      `SELECT id, tenant_id, provider, config_encrypted, is_active
         FROM tenant_payment_configs
        WHERE tenant_id = $1 AND provider = $2`,
      [tenantId, provider],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Active configs, capped at two.
   *
   * The cap is intentional: the caller only needs to distinguish "none", "one",
   * and "more than one". Reading every config to report an ambiguity would do
   * unnecessary work on the checkout hot path.
   */
  async findActiveConfigs(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<PaymentConfigRow[]> {
    const result = await connection.query<PaymentConfigRow>(
      `SELECT id, tenant_id, provider, config_encrypted, is_active
         FROM tenant_payment_configs
        WHERE tenant_id = $1 AND is_active = true
        ORDER BY provider
        LIMIT 2`,
      [tenantId],
    );
    return result.rows;
  }

  async upsertConfig(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
    configEncrypted: string,
    isActive: boolean,
  ): Promise<PaymentConfigRow> {
    const result = await connection.query<PaymentConfigRow>(
      `INSERT INTO tenant_payment_configs
           (tenant_id, provider, config_encrypted, is_active)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, provider)
       DO UPDATE SET config_encrypted = EXCLUDED.config_encrypted,
                     is_active = EXCLUDED.is_active
       RETURNING id, tenant_id, provider, config_encrypted, is_active`,
      [tenantId, provider, configEncrypted, isActive],
    );
    return result.rows[0];
  }

  /**
   * Makes `provider` the only active gateway for the tenant.
   *
   * The database permits several active rows (the unique key is on
   * `(tenant_id, provider)`), but checkout needs exactly one. Deactivating the
   * others here keeps that invariant at the write edge, before any reader can
   * observe an ambiguous state.
   */
  async deactivateOtherProviders(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE tenant_payment_configs
          SET is_active = false
        WHERE tenant_id = $1 AND provider <> $2 AND is_active = true`,
      [tenantId, provider],
    );
  }

  // ---------------------------------------------------------------- payments

  async createPending(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreatePaymentInput,
  ): Promise<PaymentRow> {
    const result = await connection.query<PaymentRow>(
      `INSERT INTO payments
           (tenant_id, order_id, provider, provider_reference, method,
            amount, status, received_by)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
       RETURNING *`,
      [
        tenantId,
        input.orderId,
        input.provider,
        input.providerReference,
        input.method,
        input.amount,
        input.receivedBy,
      ],
    );
    return result.rows[0];
  }

  async findPaymentById(
    connection: TenantScopedConnection,
    tenantId: string,
    id: string,
  ): Promise<PaymentRow | null> {
    const result = await connection.query<PaymentRow>(
      `SELECT *
         FROM payments
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id],
    );
    return result.rows[0] ?? null;
  }

  async findPaymentByReference(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null> {
    const result = await connection.query<PaymentRow>(
      `SELECT *
         FROM payments
        WHERE tenant_id = $1
          AND provider = $2
          AND provider_reference = $3`,
      [tenantId, provider, providerReference],
    );
    return result.rows[0] ?? null;
  }

  async listByOrder(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<PaymentRow[]> {
    const result = await connection.query<PaymentRow>(
      `SELECT *
         FROM payments
        WHERE tenant_id = $1 AND order_id = $2
        ORDER BY created_at DESC`,
      [tenantId, orderId],
    );
    return result.rows;
  }

  /** Moves a pending payment to `succeeded`; null when it was not pending. */
  async markSucceeded(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null> {
    const result = await connection.query<PaymentRow>(
      `UPDATE payments
          SET status = 'succeeded',
              paid_at = now(),
              updated_at = now()
        WHERE tenant_id = $1
          AND provider = $2
          AND provider_reference = $3
          AND status = 'pending'
        RETURNING *`,
      [tenantId, provider, providerReference],
    );
    return result.rows[0] ?? null;
  }

  /** Moves a pending payment to `failed`; null when it was not pending. */
  async markFailed(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
    providerReference: string,
  ): Promise<PaymentRow | null> {
    const result = await connection.query<PaymentRow>(
      `UPDATE payments
          SET status = 'failed',
              updated_at = now()
        WHERE tenant_id = $1
          AND provider = $2
          AND provider_reference = $3
          AND status = 'pending'
        RETURNING *`,
      [tenantId, provider, providerReference],
    );
    return result.rows[0] ?? null;
  }

  /** Moves a succeeded payment to `refunded`; null when it was not succeeded. */
  async markRefunded(
    connection: TenantScopedConnection,
    tenantId: string,
    paymentId: string,
  ): Promise<PaymentRow | null> {
    const result = await connection.query<PaymentRow>(
      `UPDATE payments
          SET status = 'refunded',
              updated_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'succeeded'
        RETURNING *`,
      [tenantId, paymentId],
    );
    return result.rows[0] ?? null;
  }
}
