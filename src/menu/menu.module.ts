import { Module } from '@nestjs/common';
import { MenuController } from './menu.controller';
import { MenuRepository } from './menu.repository';
import { MenuService } from './menu.service';

/**
 * The menu module is a plain feature module: it needs no extra imports because
 * `TenantModule` is global and already exports `TenantRequestContext` (the
 * per-request tenant-scoped connection every controller pulls from), and the
 * auth guards/decorators are global too.
 *
 * `MenuRepository` is exported (not just `MenuService`) for exactly one caller:
 * `OrderModule` prices tickets server-side through `resolveItemsForBranch`, and
 * doing that by re-declaring the org/branch merge rule in the order module would
 * guarantee the two copies drift apart.
 */
@Module({
  controllers: [MenuController],
  providers: [MenuService, MenuRepository],
  exports: [MenuService, MenuRepository],
})
export class MenuModule {}
