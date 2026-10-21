import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';

const T1 = 't1';
const B1 = 'b1';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'u1',
    tenantId: T1,
    branchId: null,
    role: 'org_owner',
    email: 'owner@cafe.test',
    fullName: 'Owner',
    ...overrides,
  };
}

describe('BranchController', () => {
  let controller: BranchController;
  let service: {
    listBranches: jest.Mock;
    createBranch: jest.Mock;
    updateBranch: jest.Mock;
    deactivateBranch: jest.Mock;
    listTables: jest.Mock;
    createTable: jest.Mock;
  };
  let connection: TenantScopedConnection;

  beforeEach(async () => {
    connection = {} as unknown as TenantScopedConnection;
    service = {
      listBranches: jest.fn(),
      createBranch: jest.fn(),
      updateBranch: jest.fn(),
      deactivateBranch: jest.fn(),
      listTables: jest.fn(),
      createTable: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [BranchController],
      providers: [
        { provide: BranchService, useValue: service },
        {
          provide: TenantRequestContext,
          useValue: {
            tenantId: 't1',
            getConnection: () => connection,
          },
        },
      ],
    }).compile();

    controller = module.get<BranchController>(BranchController);
  });

  it('lists branches with the tenant-scoped connection', async () => {
    await controller.list({ user: user() } as never);
    expect(service.listBranches).toHaveBeenCalledWith(
      connection,
      't1',
      undefined,
    );
  });

  it('narrows the branch list to the caller own branch', async () => {
    await controller.list({
      user: user({ role: 'branch_manager', branchId: B1 }),
    } as never);

    expect(service.listBranches).toHaveBeenCalledWith(connection, 't1', B1);
  });

  it('creates a branch', async () => {
    await controller.create({ name: 'Brunch St' });
    expect(service.createBranch).toHaveBeenCalledWith(connection, 't1', {
      name: 'Brunch St',
    });
  });

  it('updates a branch by id', async () => {
    await controller.update('b1', { name: 'Renamed' }, {
      user: user(),
    } as never);
    expect(service.updateBranch).toHaveBeenCalledWith(connection, 't1', 'b1', {
      name: 'Renamed',
    });
  });

  it('refuses to update a branch of another branch', async () => {
    await expect(
      controller.update('b2', { name: 'Renamed' }, {
        user: user({ role: 'branch_manager', branchId: B1 }),
      } as never),
    ).rejects.toThrow(ForbiddenException);

    expect(service.updateBranch).not.toHaveBeenCalled();
  });

  it('deactivates a branch by id', async () => {
    await controller.deactivate('b1', { user: user() } as never);
    expect(service.deactivateBranch).toHaveBeenCalledWith(
      connection,
      't1',
      'b1',
    );
  });

  it('lists tables under a branch', async () => {
    await controller.listTables('b1', { user: user() } as never);
    expect(service.listTables).toHaveBeenCalledWith(connection, 't1', 'b1');
  });

  it('refuses to list the tables of another branch', async () => {
    await expect(
      controller.listTables('b2', {
        user: user({ role: 'waiter', branchId: B1 }),
      } as never),
    ).rejects.toThrow(ForbiddenException);

    expect(service.listTables).not.toHaveBeenCalled();
  });

  it('creates a table under a branch', async () => {
    await controller.createTable('b1', { label: 'T1' }, {
      user: user(),
    } as never);
    expect(service.createTable).toHaveBeenCalledWith(connection, 't1', 'b1', {
      label: 'T1',
    });
  });

  it('refuses to create a table in another branch', async () => {
    await expect(
      controller.createTable('b2', { label: 'T1' }, {
        user: user({ role: 'receptionist', branchId: B1 }),
      } as never),
    ).rejects.toThrow(ForbiddenException);

    expect(service.createTable).not.toHaveBeenCalled();
  });
});
