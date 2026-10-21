import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { BranchModule } from './branch/branch.module';
import { CheckoutModule } from './checkout/checkout.module';
import { CrmModule } from './crm/crm.module';
import { MenuModule } from './menu/menu.module';
import { OrderModule } from './order/order.module';
import { InventoryModule } from './inventory/inventory.module';
import { OrgModule } from './org/org.module';
import { PlatformModule } from './platform/platform.module';
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
    TenantModule,
    PlatformModule,
    AuthModule,
    OrgModule,
    BranchModule,
    CheckoutModule,
    MenuModule,
    OrderModule,
    InventoryModule,
    StaffModule,
    CrmModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
