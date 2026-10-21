import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  AnnouncePromotionDto,
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionQueryDto,
  UpdatePromotionDto,
} from './dto/crm.dto';
import { CrmEventPublisher } from './events/crm-event.publisher';
import { PromotionService } from './promotions/promotion.service';

/** Who may apply a promotion at the till. */
const PROMOTION_APPLY_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
];

/**
 * Who may read the promotion catalogue.
 *
 * The same set as apply: you cannot apply a code you are not allowed to see.
 */
const PROMOTION_READ_ROLES = PROMOTION_APPLY_ROLES;

/**
 * Who may create or change a promotion.
 *
 * A discount is a pricing decision. A waiter applying a code is one thing; a
 * waiter inventing a 100% code for a friend is another.
 */
const PROMOTION_WRITE_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Who may announce a promotion to customers.
 *
 * Narrower than `PROMOTION_WRITE_ROLES`: a branch manager may invent a code,
 * but a tenant-wide SMS/email/push broadcast is an owner action. See the same
 * split in `CustomerController`.
 */
const PROMOTION_ANNOUNCE_ROLES = ['super_admin', 'org_owner'];

/**
 * Promotions and discount application.
 *
 * `POST /promotions/apply` is a POST even though it changes nothing: the
 * operation takes a code and a subtotal and returns a priced result, and that
 * result must not be cached the way a GET could be. It is also the one route
 * here a checkout screen calls on every ticket, which is why it takes the
 * subtotal in the body rather than requiring the client to create a promotion
 * first.
 */
@Controller('promotions')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PromotionController {
  constructor(
    private readonly promotions: PromotionService,
    private readonly publisher: CrmEventPublisher,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  @Post()
  @Roles(...PROMOTION_WRITE_ROLES)
  create(@Body() body: CreatePromotionDto) {
    return this.promotions.create(this.connection(), body);
  }

  @Get()
  @Roles(...PROMOTION_READ_ROLES)
  list(@Query() query: PromotionQueryDto) {
    return this.promotions.list(this.connection(), query);
  }

  /**
   * Priced BEFORE `GET :id`, and it is a POST, so it cannot be shadowed by the
   * parameterised route: `apply` is never a promotion id.
   */
  @Post('apply')
  @HttpCode(200)
  @Roles(...PROMOTION_APPLY_ROLES)
  apply(@Body() body: ApplyPromotionDto) {
    return this.promotions.apply(this.connection(), body);
  }

  /**
   * Announces an active promotion to a customer audience.
   *
   * `customerIds` omitted means every customer in the tenant. Promotions are
   * tenant-wide (see `PromotionController`/`CustomerController` notes), so
   * there is no branch segment to apply. The publisher validates the whole
   * audience before emitting, and the notification queue deduplicates a repeat
   * of the same promotion/customer pair.
   */
  @Post(':id/announce')
  @HttpCode(200)
  @Roles(...PROMOTION_ANNOUNCE_ROLES)
  announce(@Param('id') id: string, @Body() body: AnnouncePromotionDto) {
    return this.publisher.announcePromotion(this.connection(), id, body);
  }

  @Get(':id')
  @Roles(...PROMOTION_READ_ROLES)
  get(@Param('id') id: string) {
    return this.promotions.get(this.connection(), id);
  }

  @Patch(':id')
  @Roles(...PROMOTION_WRITE_ROLES)
  update(@Param('id') id: string, @Body() body: UpdatePromotionDto) {
    return this.promotions.update(this.connection(), id, body);
  }
}
