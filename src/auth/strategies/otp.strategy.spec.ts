import { UnauthorizedException } from '@nestjs/common';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import { AuthService } from '../auth.service';
import { OtpStrategy } from './otp.strategy';
import type { AuthenticatedUser } from '../interfaces/auth.interface';

describe('OtpStrategy (stub)', () => {
  let strategy: OtpStrategy;
  let authService: { validateOtp: jest.Mock };
  let connection: TenantScopedConnection;
  let request: RequestWithTenant;

  beforeEach(() => {
    connection = {} as unknown as TenantScopedConnection;
    request = {
      tenantId: 't1',
      tenantConnection: connection,
    } as RequestWithTenant;
    authService = { validateOtp: jest.fn() };
    strategy = new OtpStrategy(authService as unknown as AuthService);
  });

  it('delegates to AuthService.validateOtp', async () => {
    authService.validateOtp.mockResolvedValue(null);
    await expect(
      strategy.validate(request, 'someone@cafe.test', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(authService.validateOtp).toHaveBeenCalledWith(
      connection,
      't1',
      'someone@cafe.test',
      '123456',
    );
  });

  it('returns the authenticated user when validation succeeds', async () => {
    const user: AuthenticatedUser = {
      userId: 'u1',
      tenantId: 't1',
      branchId: null,
      role: 'customer',
      email: 'someone@cafe.test',
      fullName: 'Sam',
    };
    authService.validateOtp.mockResolvedValue(user);

    await expect(
      strategy.validate(request, 'someone@cafe.test', '123456'),
    ).resolves.toEqual(user);
  });

  it('rejects when no tenant context is present', async () => {
    request = {} as RequestWithTenant;
    await expect(
      strategy.validate(request, 'someone@cafe.test', '123456'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
