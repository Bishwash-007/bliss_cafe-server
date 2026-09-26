/** User identity attached to `request.user` after a strategy validates a user. */
export interface AuthenticatedUser {
  userId: string;
  tenantId: string;
  branchId: string | null;
  role: string;
  email: string;
  fullName: string;
}

/** Claims embedded in the signed access token. */
export interface JwtAccessPayload {
  sub: string;
  tenantId: string;
  branchId: string | null;
  role: string;
  email: string;
  fullName: string;
  type: 'access';
}

/** Shape returned by every success path that mints a fresh pair of tokens. */
export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: AuthenticatedUser;
}

/** Raw row of `user_sessions`. */
export interface UserSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  family_id: string;
  refresh_token_hash: string;
  expires_at: Date;
  revoked_at: Date | null;
  rotated_from: string | null;
  created_at: Date;
  last_used_at: Date | null;
}
