import { JwtModule } from '@nestjs/jwt';
import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { hashSync } from 'bcryptjs';
import { createHash } from 'node:crypto';
import { decode } from 'jsonwebtoken';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { AuthService } from './auth.service';
import { SessionService } from './session.service';
import type { AuthenticatedUser } from './interfaces/auth.interface';

interface UserRow {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  full_name: string;
  email: string;
  password_hash: string;
  is_active: boolean;
  role: string;
}

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PASSWORD = 'SuperSecret123!';

function userRow(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: T1,
    branch_id: null,
    full_name: 'Jane Staff',
    email: 'jane@cafe.test',
    password_hash: hashSync(PASSWORD, 8),
    is_active: true,
    role: 'branch_manager',
    ...overrides,
  };
}

describe('AuthService', () => {
  let service: AuthService;
  let query: jest.Mock;
  let connection: TenantScopedConnection;

  beforeEach(async () => {
    query = jest.fn();
    connection = { query } as unknown as TenantScopedConnection;

    const module: TestingModule = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'unit-test-secret' })],
      providers: [AuthService, SessionService],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('validateLocal', () => {
    it('returns the authenticated user for valid credentials', async () => {
      query.mockResolvedValueOnce({ rows: [userRow()] });

      const user = await service.validateLocal(
        connection,
        T1,
        'jane@cafe.test',
        PASSWORD,
      );

      expect(user).toMatchObject({
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: T1,
        role: 'branch_manager',
        email: 'jane@cafe.test',
        fullName: 'Jane Staff',
      });
    });

    it('rejects an unknown email', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.validateLocal(connection, T1, 'missing@cafe.test', PASSWORD),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a wrong password', async () => {
      query.mockResolvedValueOnce({ rows: [userRow()] });

      await expect(
        service.validateLocal(
          connection,
          T1,
          'jane@cafe.test',
          'wrong-password',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects an inactive user', async () => {
      query.mockResolvedValueOnce({
        rows: [userRow({ is_active: false })],
      });

      await expect(
        service.validateLocal(connection, T1, 'jane@cafe.test', PASSWORD),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('scopes the lookup to the tenant (email alone never matches)', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.validateLocal(connection, T1, 'jane@cafe.test', PASSWORD),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('tenant_id = $1'),
        [T1, 'jane@cafe.test'],
      );
    });
  });

  describe('validateOtp (stub)', () => {
    it('returns null until a provider is wired in', async () => {
      await expect(
        service.validateOtp(connection, T1, 'someone@cafe.test', '123456'),
      ).resolves.toBeNull();
    });
  });

  describe('login', () => {
    it('returns accessToken, refreshToken and the user', async () => {
      query.mockResolvedValueOnce({
        rows: [
          {
            id: 'sess-1',
            family_id: 'fam-1',
            expires_at: new Date(Date.now() + 30 * 86_400_000),
          },
        ],
      });

      const user: AuthenticatedUser = {
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: T1,
        branchId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        role: 'receptionist',
        email: 'jane@cafe.test',
        fullName: 'Jane Staff',
      };

      const result = await service.login(connection, user);

      expect(result.user).toEqual(user);
      expect(typeof result.accessToken).toBe('string');
      expect(typeof result.refreshToken).toBe('string');
      expect(result.refreshToken).not.toBe(result.accessToken);

      const payload = decode(result.accessToken) as Record<string, unknown>;
      expect(payload).toMatchObject({
        sub: user.userId,
        tenantId: T1,
        branchId: user.branchId,
        role: 'receptionist',
        email: 'jane@cafe.test',
        fullName: 'Jane Staff',
        type: 'access',
      });
    });

    it('stores the refresh token only as a hash', async () => {
      query.mockResolvedValueOnce({
        rows: [{ id: 'sess-1', family_id: 'fam-1', expires_at: new Date() }],
      });
      const user: AuthenticatedUser = {
        userId: '11111111-1111-4111-8111-111111111111',
        tenantId: T1,
        branchId: null,
        role: 'super_admin',
        email: 'root@cafe.test',
        fullName: 'Root',
      };

      await service.login(connection, user);

      const [, values] = query.mock.calls[0] as [string, unknown[]];
      const rawToken = values[3];
      expect(typeof rawToken).toBe('string');
      expect(rawToken).toHaveLength(64);
      expect(rawToken).not.toContain(user.email);
    });
  });

  describe('refresh', () => {
    it('mints a new pair and never returns the old refresh token', async () => {
      // SessionService.rotate: findByHash -> create -> revokeById
      query
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'sess-old',
              tenant_id: T1,
              user_id: '11111111-1111-4111-8111-111111111111',
              family_id: 'fam-1',
              refresh_token_hash: 'x',
              expires_at: new Date(Date.now() + 60_000),
              revoked_at: null,
              rotated_from: null,
              created_at: new Date(),
              last_used_at: new Date(),
            },
          ],
        })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'sess-new',
              family_id: 'fam-1',
              expires_at: new Date(Date.now() + 30 * 86_400_000),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [userRow()] });

      const result = await service.refresh(connection, T1, 'rotating-token');

      expect(result.user.role).toBe('branch_manager');
      expect(result.refreshToken).not.toBe('rotating-token');
      const payload = decode(result.accessToken) as Record<string, unknown>;
      expect(payload).toMatchObject({
        sub: '11111111-1111-4111-8111-111111111111',
        role: 'branch_manager',
      });
    });
  });

  describe('logout', () => {
    it('revokes the presented refresh token', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await service.logout(connection, T1, 'my-refresh-token');

      expect(query).toHaveBeenCalledWith(
        expect.stringContaining('revoked_at'),
        expect.arrayContaining([
          T1,
          createHash('sha256').update('my-refresh-token').digest('hex'),
        ]),
      );
    });
  });
});
