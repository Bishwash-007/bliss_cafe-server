import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AUTH_CONFIG } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { RolesGuard } from './guards/roles.guard';
import { SessionService } from './session.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { LocalStrategy } from './strategies/local.strategy';
import { OtpStrategy } from './strategies/otp.strategy';

/**
 * Auth is global so the JWT + roles guards can protect routes from any other
 * module (checkout, orders, payments...) without importing AuthModule.
 */
@Global()
@Module({
  imports: [
    PassportModule,
    JwtModule.register({
      secret: AUTH_CONFIG.jwtSecret,
      signOptions: { expiresIn: AUTH_CONFIG.accessTtl as never },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    LocalStrategy,
    JwtStrategy,
    OtpStrategy,
    JwtAuthGuard,
    LocalAuthGuard,
    RolesGuard,
  ],
  exports: [
    AuthService,
    SessionService,
    JwtAuthGuard,
    LocalAuthGuard,
    RolesGuard,
    // Exported so anything that must verify a token itself — the KDS WebSocket
    // gateway authenticates its own handshake — reuses THIS registration instead
    // of calling `JwtModule.register` again. A second registration is a second
    // copy of the secret and expiry config to keep in sync, and the day they
    // drift, sockets reject tokens the HTTP API accepts.
    JwtModule,
  ],
})
export class AuthModule {}
