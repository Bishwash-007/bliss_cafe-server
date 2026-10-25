import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { BranchModule } from './branch/branch.module';
import { CheckoutModule } from './checkout/checkout.module';
import { CrmModule } from './crm/crm.module';
import { MenuModule } from './menu/menu.module';
import { NotificationModule } from './notification/notification.module';
import { OrderModule } from './order/order.module';
import { PaymentModule } from './payment/payment.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrgModule } from './org/org.module';
import { PlatformModule } from './platform/platform.module';
import { ReportingModule } from './reporting/reporting.module';
import { StaffModule } from './staff/staff.module';
import { TenantModule } from './tenant/tenant.module';
import { DEFAULT_LIMIT } from './rate-limits';

/**
 * `EventEmitterModule.forRoot()` is registered GLOBALLY and here, in the root,
 * because the event bus is infrastructure owned by no single feature: Order
 * publishes onto it, and Inventory / CRM / Notification subscribe. Registering
 * it inside `OrderModule` would hand every one of those modules a private
 * emitter and silently drop their handlers.
 *
 * `wildcard: false` is the safe default: only explicitly named events
 * (`order.placed`, …) are dispatched, so a typo'd event name is a no-op instead
 * of a handler firing on every publish.
 */
@Module({
  imports: [
    EventEmitterModule.forRoot({ wildcard: false }),
    // One scheduler for the whole application. Billing registers the daily
    // renewal job on it; a per-module `forRoot()` would create separate
    // explorers and make "is the job scheduled?" depend on import order.
    ScheduleModule.forRoot(),
    // Rate limiting. The defaults are deliberately generous; the routes that
    // matter (login, onboarding, webhooks) tighten them with `@Throttle`.
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60_000, limit: DEFAULT_LIMIT }],
    }),
    TenantModule,
    PlatformModule,
    ReportingModule,
    AuthModule,
    BillingModule,
    OrgModule,
    BranchModule,
    CheckoutModule,
    MenuModule,
    OrderModule,
    InventoryModule,
    StaffModule,
    CrmModule,
    PaymentModule,
    NotificationModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      /**
       * The validation pipe is registered as a provider rather than in
       * `main.ts`, because `main.ts` only runs in production: a test harness
       * that built the app itself would otherwise skip validation entirely and
       * a suite could pass while the deployed service rejected the same body.
       *
       * `whitelist` stays off on purpose. Turning it on strips any property
       * without a decorator, which silently changes the request contract of
       * every DTO that is not fully decorated yet. `forbidUnknownValues` is
       * off for the same reason: a DTO class that has no decorators at all
       * would otherwise fail every request with "unknown value" instead of
       * being passed through untouched.
       */
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: false,
        forbidUnknownValues: false,
        transformOptions: { enableImplicitConversion: false },
      }),
    },
    {
      /**
       * The rate limiter is GLOBAL, so every route inherits the default limit
       * and the routes that need a tighter one tighten it with `@Throttle`.
       *
       * It used to be applied per controller, which left every route that was
       * not `auth` or `onboarding` completely unlimited — the documented
       * "300 a minute everywhere" was in fact "300 a minute in two places and
       * no limit anywhere else".
       *
       * The bucket key is the route plus the client address, so a limit is
       * per route and per client, not per client in total.
       */
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
export class AppModule {}
