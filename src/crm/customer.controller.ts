import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { CrmService } from './crm.service';
import type { CustomerLookupDto, CustomerQueryDto } from './dto/crm.dto';

/**
 * Who may read or create a customer.
 *
 * Everyone who serves a customer at the counter. A `kitchen_staff` member does
 * not, and a `customer` token certainly does not: this endpoint can list every
 * customer in the tenant by name and phone, which is the guest list, not a
 * public directory.
 */
const CUSTOMER_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
];

/**
 * Customer profiles and loyalty balances.
 *
 * ## Why these routes are tenant-wide
 *
 * The `customers` table has no `branch_id` (migration 006), because a regular
 * who visits two branches is one person with one loyalty balance — splitting
 * them by branch would mean a customer's points depend on which door they came
 * through. Promotions are tenant-wide for the same reason: a code printed on a
 * flyer is not branch-specific.
 *
 * That does mean a branch manager can look up a customer from another branch.
 * That is the tenant's own data and the schema's shape; confusing a customer
 * who moved from branch A to B would be worse. It is NOT a cross-tenant leak:
 * RLS and every query's `tenant_id` predicate enforce that boundary.
 */
@Controller('customers')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomerController {
  constructor(
    private readonly crm: CrmService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  /**
   * Finds a customer by phone, creating one when the phone is new.
   *
   * `200`, not the POST default `201`: the common case is a lookup of somebody
   * who already exists, and answering `201 Created` for a row that was already
   * there would be a lie a client could act on. The `created` flag in the body
   * says which happened.
   */
  @Post()
  @HttpCode(200)
  @Roles(...CUSTOMER_ROLES)
  lookupOrCreate(@Body() body: CustomerLookupDto) {
    return this.crm.lookupOrCreateByPhone(this.connection(), body);
  }

  /**
   * Lists the tenant's customers, or — with `?phone=` — looks one up.
   */
  @Get()
  @Roles(...CUSTOMER_ROLES)
  list(@Query() query: CustomerQueryDto) {
    return this.crm.listCustomers(this.connection(), query);
  }

  @Get(':id')
  @Roles(...CUSTOMER_ROLES)
  get(@Param('id') id: string) {
    return this.crm.getCustomer(this.connection(), id);
  }

  @Get(':id/loyalty')
  @Roles(...CUSTOMER_ROLES)
  loyalty(@Param('id') id: string) {
    return this.crm.getLoyalty(this.connection(), id);
  }
}
