import { UnauthorizedException } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { SessionService } from './session.service';
import type { UserSessionRow } from './interfaces/auth.interface';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const U1 = '11111111-1111-4111-8111-111111111111';
const HASH_LENGTH = 64;
const TOKEN_LENGTH = 96;

function sessionRow(overrides: Partial<UserSessionRow> = {}): UserSessionRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenant_id: T1,
    user_id: U1,
    family_id: 'fam-1',
    refresh_token_hash: 'hash',
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    rotated_from: null,
    created_at: new Date(),
    last_used_at: new Date(),
    ...overrides,
  };
}

describe('SessionService', () => {
  let service: SessionService;
  let query: jest.Mock;
  let connection: TenantScopedConnection;

  beforeEach(() => {
    service = new SessionService();
    query = jest.fn();
    connection = { query } as unknown as TenantScopedConnection;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('tokens', () => {
    it('hashes a token to a stable sha256 hex digest', () => {
      const hash = service.hashToken('refresh-me');
      expect(hash).toHaveLength(HASH_LENGTH);
      expect(service.hashToken('refresh-me')).toBe(hash);
      expect(service.hashToken('something-else')).not.toBe(hash);
    });

    it('never returns the raw token in the hash lookup value', () => {
      query.mockResolvedValueOnce({ rows: [sessionRow()] });
      void service.findByHash(connection, T1, 'raw-token-value');
      const [, values] = query.mock.calls[0] as [string, unknown[]];
      expect(values[1]).not.toBe('raw-token-value');
      expect(values[1]).toHaveLength(HASH_LENGTH);
    });

    it('generates strong random tokens', () => {
      const a = service.generateToken();
      const b = service.generateToken();
      expect(a).toHaveLength(TOKEN_LENGTH);
      expect(a).not.toBe(b);
    });
  });

  describe('rotate', () => {
    it('revokes the old session and opens a new one in the same family', async () => {
      const old = sessionRow();
      query
        .mockResolvedValueOnce({ rows: [old] })
        .mockResolvedValueOnce({
          rows: [
            {
              id: 'new-session',
              family_id: old.family_id,
              expires_at: new Date(Date.now() + 30 * 86_400_000),
            },
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      const result = await service.rotate(connection, T1, 'old-token');

      expect(result.familyId).toBe(old.family_id);
      expect(result.userId).toBe(U1);
      expect(result.refreshToken).not.toBe('old-token');
      expect(result.refreshToken).toHaveLength(TOKEN_LENGTH);

      // third call is revokeById on the old session
      const revoke = query.mock.calls[2] as [string, unknown[]];
      expect(revoke[0]).toContain('UPDATE user_sessions');
      expect(revoke[1]).toContain(old.id);
    });

    it('throws UnauthorizedException for an unknown token', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await expect(
        service.rotate(connection, T1, 'missing-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('revokes the whole family when a rotated token is reused', async () => {
      query
        .mockResolvedValueOnce({
          rows: [
            sessionRow({ revoked_at: new Date(), family_id: 'fam-leaked' }),
          ],
        })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.rotate(connection, T1, 'reused-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const familyRevoke = query.mock.calls[1] as [string, unknown[]];
      expect(familyRevoke[0]).toContain('family_id = $');
      expect(familyRevoke[1]).toContain('fam-leaked');
    });

    it('revokes an expired token and rejects it', async () => {
      query
        .mockResolvedValueOnce({
          rows: [sessionRow({ expires_at: new Date(Date.now() - 1000) })],
        })
        .mockResolvedValueOnce({ rows: [] });

      await expect(
        service.rotate(connection, T1, 'expired-token'),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      const revoke = query.mock.calls[1] as [string, unknown[]];
      expect(revoke[0]).toContain('UPDATE user_sessions');
    });
  });

  describe('revokeByToken', () => {
    it('marks revoked_at instead of deleting the row', async () => {
      query.mockResolvedValueOnce({ rows: [] });

      await service.revokeByToken(connection, T1, 'token');

      const [statement] = query.mock.calls[0] as [string, unknown[]];
      expect(statement).toContain(
        'SET revoked_at = COALESCE(revoked_at, now())',
      );
    });
  });
});
