import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { LOGIN_LIMIT, MINUTE, REFRESH_LIMIT } from '../rate-limits';
import type { RequestWithTenant } from '../tenant/interfaces/tenant-request.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { AuthService } from './auth.service';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import type {
  AuthenticatedUser,
  LoginResult,
} from './interfaces/auth.interface';

type AuthenticatedRequest = RequestWithTenant & { user?: AuthenticatedUser };

@Controller('auth')
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @UseGuards(LocalAuthGuard)
  @Throttle({ default: { limit: LOGIN_LIMIT, ttl: MINUTE } })
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Req() req: AuthenticatedRequest): Promise<LoginResult> {
    const user = req.user;
    if (!user) {
      throw new Error('LocalAuthGuard did not attach a user');
    }
    return this.authService.login(this.tenantContext.getConnection(), user);
  }

  @Throttle({ default: { limit: REFRESH_LIMIT, ttl: MINUTE } })
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(@Body() body: RefreshTokenDto): Promise<LoginResult> {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is missing');
    }
    return this.authService.refresh(
      this.tenantContext.getConnection(),
      tenantId,
      body.refreshToken,
    );
  }

  @UseGuards(JwtAuthGuard)
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Body() body: RefreshTokenDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{ success: true }> {
    const user = req.user;
    if (!user) {
      throw new Error('JwtAuthGuard did not attach a user');
    }
    await this.authService.logout(
      this.tenantContext.getConnection(),
      user.tenantId,
      body.refreshToken,
    );
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: AuthenticatedRequest): AuthenticatedUser {
    const user = req.user;
    if (!user) {
      throw new Error('JwtAuthGuard did not attach a user');
    }
    return user;
  }
}
