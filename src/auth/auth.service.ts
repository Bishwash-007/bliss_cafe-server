import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  AuthenticatedUser,
  JwtAccessPayload,
  LoginResult,
} from './interfaces/auth.interface';
import { SessionService } from './session.service';

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

/**
 * Auth flows. Every method takes the tenant-scoped connection explicitly so
 * the strategies and the controller can stay strategy-agnostic — the tenant is
 * always the one the TenantContextMiddleware pinned for the request.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly sessionService: SessionService,
    private readonly jwtService: JwtService,
  ) {}

  async validateLocal(
    connection: TenantScopedConnection,
    tenantId: string,
    email: string,
    password: string,
  ): Promise<AuthenticatedUser> {
    const user = await this.findUser(connection, tenantId, email);

    const valid =
      user !== null &&
      user.is_active &&
      (await compare(password, user.password_hash));

    if (!valid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.toAuthenticatedUser(user);
  }

  validateOtp(
    connection: TenantScopedConnection,
    tenantId: string,
    identifier: string,
    code: string,
  ): Promise<AuthenticatedUser | null> {
    // Stub: return a validated user once an OTP provider is wired in.
    void [connection, tenantId, identifier, code];
    return Promise.resolve(null);
  }

  async login(
    connection: TenantScopedConnection,
    user: AuthenticatedUser,
  ): Promise<LoginResult> {
    const refreshToken = this.sessionService.generateToken();
    await this.sessionService.create(connection, {
      tenantId: user.tenantId,
      userId: user.userId,
      familyId: randomUUID(),
      refreshToken,
    });

    const accessToken = await this.signAccessToken(user);
    return { accessToken, refreshToken, user };
  }

  async refresh(
    connection: TenantScopedConnection,
    tenantId: string,
    refreshToken: string,
  ): Promise<LoginResult> {
    const rotated = await this.sessionService.rotate(
      connection,
      tenantId,
      refreshToken,
    );

    const user = await this.findUserById(connection, tenantId, rotated.userId);
    if (!user) {
      throw new UnauthorizedException('User no longer exists');
    }

    const authenticated = this.toAuthenticatedUser(user);
    const accessToken = await this.signAccessToken(authenticated);
    return {
      accessToken,
      refreshToken: rotated.refreshToken,
      user: authenticated,
    };
  }

  async logout(
    connection: TenantScopedConnection,
    tenantId: string,
    refreshToken: string,
  ): Promise<void> {
    await this.sessionService.revokeByToken(connection, tenantId, refreshToken);
  }

  private async signAccessToken(user: AuthenticatedUser): Promise<string> {
    const payload: JwtAccessPayload = {
      sub: user.userId,
      tenantId: user.tenantId,
      branchId: user.branchId,
      role: user.role,
      email: user.email,
      fullName: user.fullName,
      type: 'access',
    };
    return this.jwtService.signAsync(payload);
  }

  private async findUser(
    connection: TenantScopedConnection,
    tenantId: string,
    email: string,
  ): Promise<UserRow | null> {
    const result = await connection.query<UserRow>(
      `SELECT u.id, u.tenant_id, u.branch_id, u.full_name, u.email,
              u.password_hash, u.is_active, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND lower(u.email) = lower($2)`,
      [tenantId, email],
    );
    return result.rows[0] ?? null;
  }

  private async findUserById(
    connection: TenantScopedConnection,
    tenantId: string,
    userId: string,
  ): Promise<UserRow | null> {
    const result = await connection.query<UserRow>(
      `SELECT u.id, u.tenant_id, u.branch_id, u.full_name, u.email,
              u.password_hash, u.is_active, r.name AS role
         FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    );
    return result.rows[0] ?? null;
  }

  private toAuthenticatedUser(user: UserRow): AuthenticatedUser {
    return {
      userId: user.id,
      tenantId: user.tenant_id,
      branchId: user.branch_id,
      role: user.role,
      email: user.email,
      fullName: user.full_name,
    };
  }
}
