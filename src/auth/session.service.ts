import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { AUTH_CONFIG } from './auth.constants';
import type { UserSessionRow } from './interfaces/auth.interface';

export interface CreatedSession {
  sessionId: string;
  familyId: string;
  expiresAt: Date;
}

export interface RotatedSession {
  userId: string;
  familyId: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface CreateSessionParams {
  tenantId: string;
  userId: string;
  familyId: string;
  refreshToken: string;
  rotatedFrom?: string;
}

/**
 * Owns the `user_sessions` table. Refresh tokens are stored as SHA-256 hashes
 * only. Rotation invalidates the presented token and mints a new one in the
 * same `family_id`; presenting an already-rotated (revoked) token is treated
 * as a leak and revokes the whole family.
 */
@Injectable()
export class SessionService {
  hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  generateToken(): string {
    return randomBytes(48).toString('hex');
  }

  async create(
    connection: TenantScopedConnection,
    params: CreateSessionParams,
  ): Promise<CreatedSession> {
    const result = await connection.query<{
      id: string;
      family_id: string;
      expires_at: Date;
    }>(
      `INSERT INTO user_sessions
         (tenant_id, user_id, family_id, refresh_token_hash, expires_at, rotated_from, last_used_at)
       VALUES
         ($1, $2, $3, $4, now() + make_interval(days => $5), $6, now())
       RETURNING id, family_id, expires_at`,
      [
        params.tenantId,
        params.userId,
        params.familyId,
        this.hashToken(params.refreshToken),
        AUTH_CONFIG.refreshTtlDays,
        params.rotatedFrom ?? null,
      ],
    );

    const row = result.rows[0];
    if (!row) {
      throw new Error('user_sessions insert returned no row');
    }
    return {
      sessionId: row.id,
      familyId: row.family_id,
      expiresAt: row.expires_at,
    };
  }

  async findByHash(
    connection: TenantScopedConnection,
    tenantId: string,
    refreshToken: string,
  ): Promise<UserSessionRow | null> {
    const result = await connection.query<UserSessionRow>(
      `SELECT id, tenant_id, user_id, family_id, refresh_token_hash,
              expires_at, revoked_at, rotated_from, created_at, last_used_at
         FROM user_sessions
        WHERE tenant_id = $1 AND refresh_token_hash = $2`,
      [tenantId, this.hashToken(refreshToken)],
    );

    return result.rows[0] ?? null;
  }

  async revokeById(
    connection: TenantScopedConnection,
    tenantId: string,
    sessionId: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE id = $1 AND tenant_id = $2`,
      [sessionId, tenantId],
    );
  }

  async revokeByToken(
    connection: TenantScopedConnection,
    tenantId: string,
    refreshToken: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE tenant_id = $1 AND refresh_token_hash = $2`,
      [tenantId, this.hashToken(refreshToken)],
    );
  }

  async revokeFamily(
    connection: TenantScopedConnection,
    tenantId: string,
    familyId: string,
  ): Promise<void> {
    await connection.query(
      `UPDATE user_sessions
          SET revoked_at = COALESCE(revoked_at, now())
        WHERE tenant_id = $1 AND family_id = $2`,
      [tenantId, familyId],
    );
  }

  /**
   * Rotates a refresh token. Order of checks:
   *  1. unknown token          -> 401;
   *  2. revoked (reuse) token  -> revoke the whole family, then 401;
   *  3. expired token          -> revoke it, then 401;
   *  4. healthy token          -> revoke it, mint a new one in the same family.
   */
  async rotate(
    connection: TenantScopedConnection,
    tenantId: string,
    refreshToken: string,
  ): Promise<RotatedSession> {
    const session = await this.findByHash(connection, tenantId, refreshToken);

    if (!session) {
      throw new UnauthorizedException('Invalid refresh token');
    }
    if (session.revoked_at) {
      await this.revokeFamily(connection, tenantId, session.family_id);
      throw new UnauthorizedException(
        'Refresh token reuse detected; the session family was revoked',
      );
    }
    if (session.expires_at.getTime() <= Date.now()) {
      await this.revokeById(connection, tenantId, session.id);
      throw new UnauthorizedException('Refresh token has expired');
    }

    const newToken = this.generateToken();
    const created = await this.create(connection, {
      tenantId,
      userId: session.user_id,
      familyId: session.family_id,
      refreshToken: newToken,
      rotatedFrom: session.id,
    });
    await this.revokeById(connection, tenantId, session.id);

    return {
      userId: session.user_id,
      familyId: session.family_id,
      refreshToken: newToken,
      expiresAt: created.expiresAt,
    };
  }
}
