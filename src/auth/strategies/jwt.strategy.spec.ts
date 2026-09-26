import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import type { JwtAccessPayload } from '../interfaces/auth.interface';

describe('JwtStrategy', () => {
  let strategy: JwtStrategy;

  beforeEach(() => {
    strategy = new JwtStrategy();
  });

  it('maps an access-token payload onto the authenticated user', () => {
    const payload: JwtAccessPayload = {
      sub: '11111111-1111-4111-8111-111111111111',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      branchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      role: 'kitchen_staff',
      email: 'k@cafe.test',
      fullName: 'Kai',
      type: 'access',
    };

    expect(strategy.validate(payload)).toEqual({
      userId: payload.sub,
      tenantId: payload.tenantId,
      branchId: payload.branchId,
      role: payload.role,
      email: payload.email,
      fullName: payload.fullName,
    });
  });

  it('keeps a null branchId for platform-level users', () => {
    const payload: JwtAccessPayload = {
      sub: '11111111-1111-4111-8111-111111111111',
      tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      branchId: null,
      role: 'super_admin',
      email: 'root@saas.test',
      fullName: 'Root',
      type: 'access',
    };

    expect(strategy.validate(payload).branchId).toBeNull();
  });

  it('rejects a token that is not an access token', () => {
    const payload = {
      sub: 'u1',
      tenantId: 't1',
      branchId: null,
      role: 'customer',
      email: 'e@cafe.test',
      fullName: 'E',
      type: 'refresh',
    } as unknown as JwtAccessPayload;

    expect(() => strategy.validate(payload)).toThrow(UnauthorizedException);
  });
});
