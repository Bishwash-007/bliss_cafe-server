import { NotFoundException } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { BranchRow } from './branch.repository';
import { BranchService } from './branch.service';
import { DuplicateTableLabelException } from './exceptions/duplicate-table-label.exception';
import { PlanLimitExceededException } from './exceptions/plan-limit-exceeded.exception';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const B1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';

function branchRow(overrides: Partial<BranchRow> = {}): BranchRow {
  return {
    id: B1,
    tenant_id: T1,
    name: 'Brunch St',
    address: null,
    phone: null,
    timezone: 'UTC',
    is_active: true,
    created_at: new Date(),
    ...overrides,
  };
}

describe('BranchService', () => {
  let service: BranchService;
  let repo: {
    findAll: jest.Mock;
    findById: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    deactivate: jest.Mock;
    countActive: jest.Mock;
    planBranchLimit: jest.Mock;
    listTables: jest.Mock;
    createTable: jest.Mock;
    setTableStatus: jest.Mock;
  };
  let connection: TenantScopedConnection;

  beforeEach(() => {
    connection = {} as unknown as TenantScopedConnection;
    repo = {
      findAll: jest.fn(),
      findById: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deactivate: jest.fn(),
      countActive: jest.fn(),
      planBranchLimit: jest.fn(),
      listTables: jest.fn(),
      createTable: jest.fn(),
      setTableStatus: jest.fn(),
    };
    service = new BranchService(repo);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('createBranch', () => {
    it('creates a branch when below the plan limit', async () => {
      repo.countActive.mockResolvedValue(1);
      repo.planBranchLimit.mockResolvedValue(3);
      repo.create.mockResolvedValue(branchRow());

      const row = await service.createBranch(connection, T1, {
        name: 'Brunch St',
      });

      expect(row.name).toBe('Brunch St');
      expect(repo.create).toHaveBeenCalledWith(connection, T1, {
        name: 'Brunch St',
      });
    });

    it('throws PlanLimitExceededException at the plan limit', async () => {
      repo.countActive.mockResolvedValue(3);
      repo.planBranchLimit.mockResolvedValue(3);

      await expect(
        service.createBranch(connection, T1, { name: 'Another' }),
      ).rejects.toThrow(PlanLimitExceededException);
      await expect(
        service.createBranch(connection, T1, { name: 'Another' }),
      ).rejects.toThrow(/maximum of 3/);
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('updateBranch / deactivateBranch', () => {
    it('updates an existing branch', async () => {
      repo.findById.mockResolvedValue(branchRow());
      repo.update.mockResolvedValue(branchRow({ name: 'Renamed' }));

      const updated = await service.updateBranch(connection, T1, B1, {
        name: 'Renamed',
      });
      expect(updated.name).toBe('Renamed');
    });

    it('404s when the branch does not exist', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.updateBranch(connection, T1, B1, { name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        service.deactivateBranch(connection, T1, B1),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('deactivates (soft-deletes) instead of deleting', async () => {
      repo.deactivate.mockResolvedValue(branchRow({ is_active: false }));

      const row = await service.deactivateBranch(connection, T1, B1);
      expect(row.is_active).toBe(false);
    });
  });

  describe('createTable', () => {
    it('creates a table under an existing branch', async () => {
      repo.findById.mockResolvedValue(branchRow());
      repo.createTable.mockResolvedValue({
        id: 't1',
        tenant_id: T1,
        branch_id: B1,
        label: 'T1',
        seats: 2,
        status: 'free',
        created_at: new Date(),
      });

      const table = await service.createTable(connection, T1, B1, {
        label: 'T1',
      });
      expect(table.label).toBe('T1');
    });

    it('translates a unique-constraint violation into a friendly error', async () => {
      repo.findById.mockResolvedValue(branchRow());
      repo.createTable.mockRejectedValue(
        Object.assign(new Error('duplicate key'), { code: '23505' }),
      );

      await expect(
        service.createTable(connection, T1, B1, { label: 'T1' }),
      ).rejects.toBeInstanceOf(DuplicateTableLabelException);
      await expect(
        service.createTable(connection, T1, B1, { label: 'T1' }),
      ).rejects.toThrow(/already exists/);
    });

    it('404s when the branch does not belong to this tenant', async () => {
      repo.findById.mockResolvedValue(null);

      await expect(
        service.createTable(connection, T1, B1, { label: 'T1' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.createTable).not.toHaveBeenCalled();
    });
  });

  describe('listTables', () => {
    it('requires the branch to exist first', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(
        service.listTables(connection, T1, B1),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
