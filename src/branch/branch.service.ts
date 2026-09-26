import { Injectable, NotFoundException } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import {
  BranchRepository,
  type BranchRow,
  type CreateBranchInput,
  type CreateTableInput,
  type TableRow,
  type TableStatus,
  type UpdateBranchInput,
} from './branch.repository';
import { DuplicateTableLabelException } from './exceptions/duplicate-table-label.exception';
import { PlanLimitExceededException } from './exceptions/plan-limit-exceeded.exception';
import { TableNotFoundException } from './exceptions/table-not-found.exception';

/**
 * Branch + table management, tenant-scoped. Connections are passed in
 * explicitly (from `TenantRequestContext`) so the logic stays testable and
 * the RLS pinning is guaranteed by the caller.
 */
@Injectable()
export class BranchService {
  constructor(private readonly repository: BranchRepository) {}

  listBranches(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<BranchRow[]> {
    return this.repository.findAll(connection, tenantId);
  }

  async createBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    input: CreateBranchInput,
  ): Promise<BranchRow> {
    // Sequential, not `Promise.all`: both reads share the one `pg` client behind
    // `connection`, so running them "in parallel" would only queue two statements
    // on a client that cannot multiplex. They are also a guard, not a read: the
    // count must be taken before the limit is compared against it.
    const activeCount = await this.repository.countActive(connection, tenantId);
    const limit = await this.repository.planBranchLimit(connection, tenantId);

    if (activeCount >= limit) {
      throw new PlanLimitExceededException(limit);
    }

    return this.repository.create(connection, tenantId, input);
  }

  async updateBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    patch: UpdateBranchInput,
  ): Promise<BranchRow> {
    const existing = await this.repository.findById(
      connection,
      tenantId,
      branchId,
    );
    if (!existing) {
      throw new NotFoundException(`Branch '${branchId}' not found`);
    }
    const updated = await this.repository.update(
      connection,
      tenantId,
      branchId,
      patch,
    );
    if (!updated) {
      throw new NotFoundException(`Branch '${branchId}' not found`);
    }
    return updated;
  }

  async deactivateBranch(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<BranchRow> {
    const deactivated = await this.repository.deactivate(
      connection,
      tenantId,
      branchId,
    );
    if (!deactivated) {
      throw new NotFoundException(`Branch '${branchId}' not found`);
    }
    return deactivated;
  }

  async listTables(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<TableRow[]> {
    await this.assertBranchExists(connection, tenantId, branchId);
    return this.repository.listTables(connection, tenantId, branchId);
  }

  async createTable(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
    input: CreateTableInput,
  ): Promise<TableRow> {
    await this.assertBranchExists(connection, tenantId, branchId);

    try {
      return await this.repository.createTable(
        connection,
        tenantId,
        branchId,
        input,
      );
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new DuplicateTableLabelException(input.label.trim());
      }
      throw error;
    }
  }

  /**
   * Marks a table busy or free.
   *
   * Exposed (rather than left as a repository detail) for two callers that must
   * not disagree: the receptionist-facing table endpoints, and `OrderService`,
   * which sets `occupied` when a dine-in ticket lands and `free` when that
   * order completes or is cancelled.
   */
  async setTableStatus(
    connection: TenantScopedConnection,
    tenantId: string,
    tableId: string,
    status: TableStatus,
  ): Promise<TableRow> {
    const updated = await this.repository.setTableStatus(
      connection,
      tenantId,
      tableId,
      status,
    );
    if (!updated) {
      throw new TableNotFoundException(tableId);
    }
    return updated;
  }

  private async assertBranchExists(
    connection: TenantScopedConnection,
    tenantId: string,
    branchId: string,
  ): Promise<void> {
    const branch = await this.repository.findById(
      connection,
      tenantId,
      branchId,
    );
    if (!branch) {
      throw new NotFoundException(`Branch '${branchId}' not found`);
    }
  }

  private isUniqueViolation(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === '23505'
    );
  }
}
