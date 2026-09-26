import { UnauthorizedException } from '@nestjs/common';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import { AuthService } from '../auth.service';
import { LocalStrategy } from './local.strategy';
import type { AuthenticatedUser } from '../interfaces/auth.interface';

describe('LocalStrategy', () => {
  let strategy: LocalStrategy;
  let authService: { validateLocal: jest.Mock };
  let connection: TenantScopedConnection;
  let request: RequestWithTenant;

  beforeEach(() => {
    connection = {} as unknown as TenantScopedConnection;
    request = {
      tenantId: 't1',
      tenantConnection: connection,
    } as RequestWithTenant;
    authService = { validateLocal: jest.fn() };
    strategy = new LocalStrategy(authService as unknown as AuthService);
  });

  it('delegates to AuthService.validateLocal with the request tenant + connection', async () => {
    const expected: AuthenticatedUser = {
      userId: 'u1',
      tenantId: 't1',
      branchId: null,
      role: 'receptionist',
      email: 'mel@cafe.test',
      fullName: 'Mel',
    };
    authService.validateLocal.mockResolvedValue(expected);

    const user = await strategy.validate(request, 'mel@cafe.test', 'password');

    expect(authService.validateLocal).toHaveBeenCalledWith(
      connection,
      't1',
      'mel@cafe.test',
      'password',
    );
    expect(user).toEqual(expected);
  });

  it('rejects when no tenant context is present', async () => {
    request = {} as RequestWithTenant;
    await expect(
      strategy.validate(request, 'mel@cafe.test', 'password'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.validateLocal).not.toHaveBeenCalled();
  });
});
