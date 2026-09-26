import { Test, TestingModule } from '@nestjs/testing';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { BranchController } from './branch.controller';
import { BranchService } from './branch.service';

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
    await controller.list();
    expect(service.listBranches).toHaveBeenCalledWith(connection, 't1');
  });

  it('creates a branch', async () => {
    await controller.create({ name: 'Brunch St' });
    expect(service.createBranch).toHaveBeenCalledWith(connection, 't1', {
      name: 'Brunch St',
    });
  });

  it('updates a branch by id', async () => {
    await controller.update('b1', { name: 'Renamed' });
    expect(service.updateBranch).toHaveBeenCalledWith(connection, 't1', 'b1', {
      name: 'Renamed',
    });
  });

  it('deactivates a branch by id', async () => {
    await controller.deactivate('b1');
    expect(service.deactivateBranch).toHaveBeenCalledWith(
      connection,
      't1',
      'b1',
    );
  });

  it('lists tables under a branch', async () => {
    await controller.listTables('b1');
    expect(service.listTables).toHaveBeenCalledWith(connection, 't1', 'b1');
  });

  it('creates a table under a branch', async () => {
    await controller.createTable('b1', { label: 'T1' });
    expect(service.createTable).toHaveBeenCalledWith(connection, 't1', 'b1', {
      label: 'T1',
    });
  });
});
