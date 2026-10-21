import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
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
  providers: [AppService],
})
export class AppModule {}
