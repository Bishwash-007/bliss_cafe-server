import {
  Global,
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PG_POOL, TENANT_RESOLVERS } from './tenant.constants';
import { pgPoolProvider } from './connection/pg-pool.provider';
import { TenantConnectionService } from './connection/tenant-connection.service';
import { TenantRequestContext } from './connection/tenant-request-context';
import { SubdomainTenantResolver } from './resolvers/subdomain-tenant.resolver';
import { HeaderTenantResolver } from './resolvers/header-tenant.resolver';
import { JwtClaimTenantResolver } from './resolvers/jwt-claim-tenant.resolver';
import { TenantChainResolver } from './resolvers/tenant-chain.resolver';
import { TenantContextMiddleware } from './middleware/tenant-context.middleware';
import { TenantCommitInterceptor } from './interceptors/tenant-commit.interceptor';

/**
 * Foundation module: resolves the tenant for every request and guarantees
 * every database call runs inside that tenant's RLS context.
 *
 * Exported globally so later modules (Menu, Orders, ...) can inject the pool
 * or the request-scoped `TenantRequestContext` without importing TenantModule.
 */
@Global()
@Module({
  providers: [
    pgPoolProvider,
    TenantConnectionService,
    TenantRequestContext,
    // Chain of Responsibility: resolvers run in this order (subdomain first).
    SubdomainTenantResolver,
    HeaderTenantResolver,
    JwtClaimTenantResolver,
    TenantChainResolver,
    {
      provide: TENANT_RESOLVERS,
      inject: [
        SubdomainTenantResolver,
        HeaderTenantResolver,
        JwtClaimTenantResolver,
      ],
      useFactory: (
        subdomain: SubdomainTenantResolver,
        header: HeaderTenantResolver,
        jwt: JwtClaimTenantResolver,
      ) => [subdomain, header, jwt],
    },
    // Registered here rather than in `main.ts` so it also applies to the e2e
    // suites, which build the Nest application themselves. A test harness that
    // silently skipped the commit ordering would hide the very race it exists to
    // catch.
    {
      provide: APP_INTERCEPTOR,
      useClass: TenantCommitInterceptor,
    },
  ],
  exports: [
    PG_POOL,
    TenantConnectionService,
    TenantRequestContext,
    TenantChainResolver,
  ],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes({
      path: '*',
      method: RequestMethod.ALL,
    });
  }
}
