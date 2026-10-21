import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';

/**
 * Reads the contact/preference data a notification needs.
 *
 * This module owns no tables. It reads `customers` and `users` (via `roles`)
 * and nothing else: notification is a consumer of the tenant's existing
 * records, not a second customer database. The only schema change it needs is
 * migration 016, which adds the preference columns to `customers`.
 *
 * Every query filters on `tenant_id` in addition to RLS. The two protections
 * are independent, exactly as in the CRM/inventory/staff repositories: a
 * forgotten predicate becomes a caught bug rather than a cross-tenant leak.
 */

/** Raw contact row for a customer. */
export interface CustomerContactRow {
  id: string;
  tenant_id: string;
  full_name: string | null;
  phone: string | null;
  email: string | null;
  push_token: string | null;
  notification_opt_out: boolean;
  notification_channel: string | null;
}

/** The order header plus its customer, when one is attached. */
export interface OrderNotificationContextRow {
  order_id: string;
  tenant_id: string;
  branch_id: string;
  order_type: string;
  table_id: string | null;
  total_amount: string;
  customer: CustomerContactRow | null;
}

/** A branch manager who should hear about an operational problem. */
export interface BranchManagerRow {
  id: string;
  full_name: string;
  email: string;
  branch_id: string | null;
}

const CUSTOMER_COLUMNS = `c.id, c.tenant_id, c.full_name, c.phone, c.email,
  c.push_token, c.notification_opt_out, c.notification_channel`;

@Injectable()
export class NotificationRepository {
  async findOrderContext(
    connection: TenantScopedConnection,
    tenantId: string,
    orderId: string,
  ): Promise<OrderNotificationContextRow | null> {
    const result = await connection.query<{
      order_id: string;
      tenant_id: string;
      branch_id: string;
      order_type: string;
      table_id: string | null;
      total_amount: string;
      customer_id: string | null;
      full_name: string | null;
      phone: string | null;
      email: string | null;
      push_token: string | null;
      notification_opt_out: boolean | null;
      notification_channel: string | null;
    }>(
      `SELECT o.id AS order_id, o.tenant_id, o.branch_id, o.order_type,
              o.table_id, o.total_amount,
              c.id AS customer_id, c.full_name, c.phone, c.email,
              c.push_token, c.notification_opt_out, c.notification_channel
         FROM orders o
         LEFT JOIN customers c
           ON c.id = o.customer_id AND c.tenant_id = o.tenant_id
        WHERE o.tenant_id = $1 AND o.id = $2`,
      [tenantId, orderId],
    );

    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      order_id: row.order_id,
      tenant_id: row.tenant_id,
      branch_id: row.branch_id,
      order_type: row.order_type,
      table_id: row.table_id,
      total_amount: row.total_amount,
      customer: row.customer_id
        ? {
            id: row.customer_id,
            tenant_id: row.tenant_id,
            full_name: row.full_name,
            phone: row.phone,
            email: row.email,
            push_token: row.push_token,
            notification_opt_out: row.notification_opt_out ?? false,
            notification_channel: row.notification_channel,
          }
        : null,
    };
  }

  async findCustomerContact(
    connection: TenantScopedConnection,
    tenantId: string,
    customerId: string,
  ): Promise<CustomerContactRow | null> {
    if (!isUuid(customerId)) {
      return null;
    }
    const result = await connection.query<CustomerContactRow>(
      `SELECT ${CUSTOMER_COLUMNS}
         FROM customers c
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, customerId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Active branch managers for one branch.
   *
   * All of them, not the first row: a branch can have a day manager and a night
   * manager, and a low-stock alert that reaches only one of them is a bug the
   * other one cannot see. `org_owner`/`super_admin` are deliberately excluded —
   * they are not the person restocking this branch, and widening the audience
   * turns an operational alert into noise.
   */
  async listBranchManagers(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<BranchManagerRow[]> {
    const result = await connection.query<BranchManagerRow>(
      `SELECT u.id, u.full_name, u.email, u.branch_id
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1
          AND u.branch_id = $2
          AND u.is_active = true
          AND r.name = 'branch_manager'
        ORDER BY u.created_at ASC, u.id ASC`,
      [tenantId, branchId],
    );
    return result.rows;
  }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether a string is shaped like a UUID.
 *
 * A malformed id would make Postgres raise `22P02` instead of returning zero
 * rows, turning a stale event into a 500-shaped failure. The listener catches
 * it either way, but returning null is the honest answer.
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
