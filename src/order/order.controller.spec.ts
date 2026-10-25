import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { ROLES_KEY } from '../auth/auth.constants';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

const T1 = 't1';
const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return {
    userId: 'u1',
    tenantId: T1,
    branchId: BRANCH_A,
    role: 'waiter',
    email: 'waiter@cafe.test',
    fullName: 'Waiter',
    ...overrides,
  };
}

const asRequest = (asUser: AuthenticatedUser): never =>
  ({ user: asUser }) as never;

type RouteHandlers = Record<
  keyof OrderController,
  (...args: never[]) => unknown
>;

const routeHandlers = OrderController.prototype as unknown as RouteHandlers;

function routeMetadata<T>(
  key: string,
  method: keyof OrderController,
): T | undefined {
  return Reflect.getMetadata(key, routeHandlers[method]) as T | undefined;
}

describe('OrderController', () => {
  let controller: OrderController;
  let service: {
    create: jest.Mock;
    findById: jest.Mock;
    transition: jest.Mock;
    listActiveByBranch: jest.Mock;
    listByBranch: jest.Mock;
  };
  let connection: TenantScopedConnection;

  beforeEach(async () => {
    connection = {} as unknown as TenantScopedConnection;
    service = {
      create: jest.fn(),
      findById: jest.fn().mockResolvedValue({ id: 'o1', branch_id: BRANCH_A }),
      transition: jest.fn(),
      listActiveByBranch: jest.fn(),
      listByBranch: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [OrderController],
      providers: [
        { provide: OrderService, useValue: service },
        {
          provide: TenantRequestContext,
          useValue: { tenantId: T1, getConnection: () => connection },
        },
      ],
    }).compile();

    controller = module.get<OrderController>(OrderController);
  });

  describe('route metadata', () => {
    const routes = [
      'create',
      'transition',
      'listActive',
      'listByBranch',
      'findById',
    ] as const satisfies ReadonlyArray<keyof OrderController>;

    it.each(routes)('%s is guarded by JwtAuthGuard + RolesGuard', (method) => {
      expect(routeMetadata<unknown[]>('__guards__', method)).toEqual([
        JwtAuthGuard,
        RolesGuard,
      ]);
    });

    it.each(routes)('%s refuses a customer', (method) => {
      const roles = routeMetadata<string[]>(ROLES_KEY, method) ?? [];
      expect(roles).not.toContain('customer');
    });

    it('lets the kitchen move a ticket along', () => {
      const roles = routeMetadata<string[]>(ROLES_KEY, 'transition') ?? [];
      expect(roles).toContain('kitchen_staff');
    });
  });

  describe('branch scope', () => {
    it('creates an order in the caller’s own branch', async () => {
      await controller.create(
        { branchId: BRANCH_A } as never,
        asRequest(user({ branchId: BRANCH_A })),
      );

      expect(service.create).toHaveBeenCalledWith(connection, T1, 'u1', {
        branchId: BRANCH_A,
      });
    });

    it('refuses an order in another branch', async () => {
      await expect(
        controller.create(
          { branchId: BRANCH_B } as never,
          asRequest(user({ branchId: BRANCH_A })),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(service.create).not.toHaveBeenCalled();
    });

    it('lets an org-wide account order in any branch', async () => {
      await controller.create(
        { branchId: BRANCH_B } as never,
        asRequest(user({ role: 'org_owner', branchId: BRANCH_A })),
      );

      expect(service.create).toHaveBeenCalled();
    });

    it('refuses the active ticket list of another branch', async () => {
      await expect(
        controller.listActive(BRANCH_B, asRequest(user())),
      ).rejects.toThrow(ForbiddenException);

      expect(service.listActiveByBranch).not.toHaveBeenCalled();
    });

    it('refuses the ticket list of another branch', async () => {
      await expect(
        controller.listByBranch(BRANCH_B, asRequest(user())),
      ).rejects.toThrow(ForbiddenException);

      expect(service.listByBranch).not.toHaveBeenCalled();
    });

    it('refuses an order that belongs to another branch', async () => {
      service.findById.mockResolvedValue({ id: 'o1', branch_id: BRANCH_B });

      await expect(
        controller.findById('o1', asRequest(user())),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses a transition of an order in another branch', async () => {
      service.findById.mockResolvedValue({ id: 'o1', branch_id: BRANCH_B });

      await expect(
        controller.transition('o1', { status: 'confirmed' }, asRequest(user())),
      ).rejects.toThrow(ForbiddenException);

      expect(service.transition).not.toHaveBeenCalled();
    });

    it('reads an order of its own branch', async () => {
      const order = await controller.findById('o1', asRequest(user()));

      expect(order).toEqual({ id: 'o1', branch_id: BRANCH_A });
    });
  });
});
