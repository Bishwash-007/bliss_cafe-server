import { Module } from '@nestjs/common';
import { BranchModule } from '../branch/branch.module';
import { MenuModule } from '../menu/menu.module';
import { OrderController } from './order.controller';
import { OrderRepository } from './order.repository';
import { OrderService } from './order.service';
import { KdsGateway } from './realtime/kds.gateway';

/**
 * The order hub, and the owner of the event bus every later module subscribes
 * to.
 *
 * Two cross-module dependencies, both narrow and both deliberate:
 *   - `MenuModule` for `MenuRepository.resolveItemsForBranch`, so a ticket is
 *     priced from the menu (branch merge applied) instead of trusting the
 *     client's arithmetic. Re-declaring the merge rule here would guarantee the
 *     two copies drift.
 *   - `BranchModule` for `BranchService.setTableStatus`, the single write path
 *     for `tables.status`, shared with the receptionist-facing endpoints so the
 *     order flow and the floor view cannot disagree about whether a table is
 *     busy.
 *
 * `EventEmitterModule` is registered globally in `AppModule`, not here: the bus
 * is infrastructure that Inventory/CRM/Notification also publish onto, and a
 * per-module registration would give each of them a private emitter.
 *
 * `KdsGateway` is exported so a future `NotificationModule` can push straight
 * to a customer's socket without re-declaring a gateway.
 */
@Module({
  imports: [MenuModule, BranchModule],
  controllers: [OrderController],
  providers: [OrderService, OrderRepository, KdsGateway],
  exports: [OrderService, OrderRepository, KdsGateway],
})
export class OrderModule {}
