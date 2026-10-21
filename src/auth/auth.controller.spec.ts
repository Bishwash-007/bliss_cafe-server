import { Test, TestingModule } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import type {
  AuthenticatedUser,
  LoginResult,
} from './interfaces/auth.interface';

describe('AuthController', () => {
  let controller: AuthController;
  let authService: { login: jest.Mock; refresh: jest.Mock; logout: jest.Mock };
  let connection: TenantScopedConnection;
  let getConnection: jest.Mock;

  const user: AuthenticatedUser = {
    userId: 'u1',
    tenantId: 't1',
    branchId: null,
    role: 'receptionist',
    email: 'r@cafe.test',
    fullName: 'Rae',
  };

  beforeEach(async () => {
    connection = {} as unknown as TenantScopedConnection;
    getConnection = jest.fn().mockReturnValue(connection);
    authService = { login: jest.fn(), refresh: jest.fn(), logout: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      imports: [ThrottlerModule.forRoot()],
      providers: [
        { provide: AuthService, useValue: authService },
        {
          provide: TenantRequestContext,
          useValue: {
            tenantId: 't1',
            getConnection,
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('login forwards the authenticated user to AuthService.login', async () => {
    const result: LoginResult = {
      accessToken: 'a.b.c',
      refreshToken: 'rt',
      user,
    };
    authService.login.mockResolvedValue(result);

    await expect(controller.login({ user } as never)).resolves.toEqual(result);
    expect(authService.login).toHaveBeenCalledWith(connection, user);
  });

  it('refresh forwards the tenant + refresh token', async () => {
    const result: LoginResult = {
      accessToken: 'a.b.c',
      refreshToken: 'new-rt',
      user,
    };
    authService.refresh.mockResolvedValue(result);

    await expect(
      controller.refresh({ refreshToken: 'old-rt' }),
    ).resolves.toEqual(result);
    expect(authService.refresh).toHaveBeenCalledWith(
      connection,
      't1',
      'old-rt',
    );
  });

  it('logout revokes the refresh token for the authenticated tenant', async () => {
    authService.logout.mockResolvedValue(undefined);

    await expect(
      controller.logout({ refreshToken: 'rt' }, { user } as never),
    ).resolves.toEqual({ success: true });
    expect(authService.logout).toHaveBeenCalledWith(connection, 't1', 'rt');
  });

  it('me returns the user attached by JwtAuthGuard', () => {
    expect(controller.me({ user } as never)).toEqual(user);
  });
});
