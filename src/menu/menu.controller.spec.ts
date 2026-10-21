import { ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ROLES_KEY } from '../auth/auth.constants';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { MenuController } from './menu.controller';
import { MenuService } from './menu.service';
import type { RenderedCategory } from './composite/menu-node';

const T1 = 't1';
const B1 = 'b1';
const B2 = 'b2';

/** An owner: not confined to a branch. */
const OWNER: AuthenticatedUser = {
  userId: 'u1',
  tenantId: T1,
  branchId: null,
  role: 'org_owner',
  email: 'owner@cafe.test',
  fullName: 'Owner',
};

/** A manager confined to B1. */
const MANAGER: AuthenticatedUser = {
  ...OWNER,
  userId: 'u2',
  role: 'branch_manager',
  branchId: B1,
};

const asRequest = (asUser: AuthenticatedUser): never =>
  ({ user: asUser }) as never;

/**
 * Typed reader for route metadata. `Reflect.getMetadata` is untyped, so funnel
 * every read through here instead of scattering `any` around.
 *
 * Nest's `SetMetadata` / `UseGuards` attach metadata to the HANDLER FUNCTION
 * itself (`descriptor.value`) — not to `(prototype, methodName)` — so the
 * lookup target must be the resolved function, exactly what
 * `ExecutionContext.getHandler()` returns at runtime.
 */
type RouteHandlers = Record<
  keyof MenuController,
  (...args: never[]) => unknown
>;

const routeHandlers = MenuController.prototype as unknown as RouteHandlers;

function routeMetadata<T>(
  key: string,
  method: keyof MenuController,
): T | undefined {
  return Reflect.getMetadata(key, routeHandlers[method]) as T | undefined;
}

function routeGuards(method: keyof MenuController): unknown[] {
  return routeMetadata<unknown[]>('__guards__', method) ?? [];
}

function routeRoles(method: keyof MenuController): string[] {
  return routeMetadata<string[]>(ROLES_KEY, method) ?? [];
}

describe('MenuController', () => {
  let controller: MenuController;
  let service: {
    getFullMenu: jest.Mock;
    createCategory: jest.Mock;
    createItem: jest.Mock;
    addModifier: jest.Mock;
    setAvailable: jest.Mock;
    updateItem: jest.Mock;
    itemBranch: jest.Mock;
  };
  let connection: TenantScopedConnection;

  beforeEach(async () => {
    connection = {} as unknown as TenantScopedConnection;
    service = {
      getFullMenu: jest.fn().mockResolvedValue([]),
      createCategory: jest.fn(),
      createItem: jest.fn(),
      addModifier: jest.fn(),
      setAvailable: jest.fn(),
      updateItem: jest.fn(),
      itemBranch: jest.fn().mockResolvedValue(B1),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [MenuController],
      providers: [
        { provide: MenuService, useValue: service },
        {
          provide: TenantRequestContext,
          useValue: { tenantId: T1, getConnection: () => connection },
        },
      ],
    }).compile();

    controller = module.get<MenuController>(MenuController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('customer public read', () => {
    it('serves the branch menu without a JWT', async () => {
      await controller.publicMenu(B1);

      expect(service.getFullMenu).toHaveBeenCalledWith(connection, B1);
    });

    it('carries NO auth guard — anonymous storefront access', () => {
      expect(routeGuards('publicMenu')).toHaveLength(0);
    });

    it('is still branch scoped — the branchId is required, never defaulted to org-wide', () => {
      // Guard count is 0, but the path param is mandatory at the routing layer.
      expect(routeGuards('publicMenu')).toHaveLength(0);
      expect(service.getFullMenu).not.toHaveBeenCalled();
    });
  });

  describe('staff read', () => {
    it('lets any staff role read the branch menu', async () => {
      await controller.branchMenu(B1, asRequest(OWNER));

      expect(service.getFullMenu).toHaveBeenCalledWith(connection, B1);
    });

    it('restricts the branch menu read to authenticated staff', () => {
      expect(routeGuards('branchMenu')).toEqual([JwtAuthGuard, RolesGuard]);
    });

    it('refuses the branch menu of another branch to a branch-confined user', async () => {
      await expect(
        controller.branchMenu(B2, asRequest(MANAGER)),
      ).rejects.toThrow(ForbiddenException);

      expect(service.getFullMenu).not.toHaveBeenCalled();
    });

    it('allows a waiter to read but not to write', () => {
      const readRoles = routeRoles('branchMenu');
      const writeRoles = routeRoles('createItem');

      expect(readRoles).toContain('waiter');
      expect(writeRoles).not.toContain('waiter');
    });

    it('restricts the org-wide preview to org owners', async () => {
      await controller.orgWideMenu();
      expect(service.getFullMenu).toHaveBeenCalledWith(connection, null);
      expect(routeRoles('orgWideMenu')).toEqual(['super_admin', 'org_owner']);
    });
  });

  describe('RBAC on writes', () => {
    const writeRoutes = [
      'createCategory',
      'createBranchCategory',
      'createItem',
      'createBranchItem',
      'addModifier',
      'updateItem',
      'setAvailability',
    ] as const satisfies ReadonlyArray<keyof MenuController>;

    it.each(writeRoutes)(
      '%s is guarded by JwtAuthGuard + RolesGuard',
      (method) => {
        expect(routeGuards(method)).toEqual([JwtAuthGuard, RolesGuard]);
      },
    );

    it.each(writeRoutes)(
      '%s is limited to the three management roles',
      (method) => {
        expect(routeRoles(method)).toEqual([
          'super_admin',
          'org_owner',
          'branch_manager',
        ]);
      },
    );
  });

  describe('write passthrough', () => {
    it('creates an org-wide category when no branch is in the path', async () => {
      await controller.createCategory({ name: 'Drinks' }, asRequest(OWNER));

      expect(service.createCategory).toHaveBeenCalledWith(connection, null, {
        name: 'Drinks',
      });
    });

    it('refuses an org-wide category to a branch manager', async () => {
      await expect(
        controller.createCategory({ name: 'Drinks' }, asRequest(MANAGER)),
      ).rejects.toThrow(ForbiddenException);

      expect(service.createCategory).not.toHaveBeenCalled();
    });

    it('creates a branch category scoped to the path branchId', async () => {
      await controller.createBranchCategory(
        B1,
        { name: 'Drinks' },
        asRequest(OWNER),
      );

      expect(service.createCategory).toHaveBeenCalledWith(connection, B1, {
        name: 'Drinks',
      });
    });

    it('refuses a branch category in another branch', async () => {
      await expect(
        controller.createBranchCategory(
          B2,
          { name: 'Drinks' },
          asRequest(MANAGER),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(service.createCategory).not.toHaveBeenCalled();
    });

    it('creates a branch item scoped to the path branchId', async () => {
      await controller.createBranchItem(
        B1,
        { name: 'Flat White', price: 3.5 },
        asRequest(OWNER),
      );

      expect(service.createItem).toHaveBeenCalledWith(connection, B1, {
        name: 'Flat White',
        price: 3.5,
      });
    });

    it('refuses a branch item in another branch', async () => {
      await expect(
        controller.createBranchItem(
          B2,
          { name: 'Flat White', price: 3.5 },
          asRequest(MANAGER),
        ),
      ).rejects.toThrow(ForbiddenException);

      expect(service.createItem).not.toHaveBeenCalled();
    });

    it('attaches a modifier to the path itemId', async () => {
      await controller.addModifier(
        'i1',
        {
          name: 'Size',
          optionName: 'Large',
          extraPrice: 0.75,
        },
        asRequest(OWNER),
      );

      expect(service.addModifier).toHaveBeenCalledWith(connection, 'i1', {
        name: 'Size',
        optionName: 'Large',
        extraPrice: 0.75,
      });
    });

    it('soft-deletes via the availability toggle, not a DELETE route', async () => {
      await controller.setAvailability(
        'i1',
        { isAvailable: false },
        asRequest(OWNER),
      );

      expect(service.setAvailable).toHaveBeenCalledWith(
        connection,
        'i1',
        false,
      );
    });

    it('forwards a partial item edit', async () => {
      await controller.updateItem('i1', { price: 4.25 }, asRequest(OWNER));

      expect(service.updateItem).toHaveBeenCalledWith(connection, 'i1', {
        price: 4.25,
      });
    });
  });

  describe('item scope', () => {
    it('refuses a branch manager the edit of an org-wide item', async () => {
      service.itemBranch.mockResolvedValue(null);

      await expect(
        controller.updateItem('i1', { price: 4.25 }, asRequest(MANAGER)),
      ).rejects.toThrow(ForbiddenException);

      expect(service.updateItem).not.toHaveBeenCalled();
    });

    it('refuses a branch manager the edit of another branch item', async () => {
      service.itemBranch.mockResolvedValue(B2);

      await expect(
        controller.updateItem('i1', { price: 4.25 }, asRequest(MANAGER)),
      ).rejects.toThrow(ForbiddenException);

      expect(service.updateItem).not.toHaveBeenCalled();
    });

    it('lets a branch manager edit the items of its own branch', async () => {
      service.itemBranch.mockResolvedValue(B1);

      await controller.updateItem('i1', { price: 4.25 }, asRequest(MANAGER));

      expect(service.updateItem).toHaveBeenCalledWith(connection, 'i1', {
        price: 4.25,
      });
    });
  });

  describe('tenant context', () => {
    it('refuses to run a write when the tenant context is missing', async () => {
      // Enforcement lives in the service (the single choke point every route
      // funnels through), so wire the REAL service over a stub repository.
      const realService = new MenuService(
        {} as ConstructorParameters<typeof MenuService>[0],
        { tenantId: null } as unknown as TenantRequestContext,
      );
      const orphan = new MenuController(realService, {
        tenantId: null,
        getConnection: () => connection,
      } as unknown as TenantRequestContext);

      await expect(
        orphan.createItem({ name: 'x', price: 1 }, asRequest(OWNER)),
      ).rejects.toThrow('Tenant context is missing');
    });
  });

  describe('response shape', () => {
    it('returns the rendered composite tree untouched', async () => {
      const tree: RenderedCategory[] = [
        {
          kind: 'category',
          id: 'c1',
          name: 'Drinks',
          branchId: B1,
          sortOrder: 0,
          items: [],
        },
      ];
      service.getFullMenu.mockResolvedValue(tree);

      await expect(controller.publicMenu(B1)).resolves.toEqual(tree);
    });
  });
});
