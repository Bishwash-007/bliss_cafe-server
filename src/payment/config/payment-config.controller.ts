import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { TenantRequestContext } from '../../tenant/connection/tenant-request-context';
import { TenantNotFoundException } from '../../tenant/exceptions/tenant-not-found.exception';
import { PaymentConfigService } from './payment-config.service';

export interface SavePaymentConfigDto {
  /** The provider's config object, e.g. `{ secretKey, webhookSecret }`. */
  config?: unknown;
  /** Defaults to true. Activating one provider deactivates the others. */
  isActive?: boolean;
}

/**
 * Tenant gateway credentials.
 *
 * Owner-only: these secrets let the holder charge customers and forge
 * webhooks. The GET deliberately returns no part of the stored config — not
 * even a masked suffix, which is still a useful hint to an attacker and cannot
 * be safely echoed back by every provider shape.
 */
@Controller('payments/config')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentConfigController {
  constructor(
    private readonly configs: PaymentConfigService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Get()
  @Roles('super_admin', 'org_owner')
  list() {
    return this.configs.list(
      this.tenantContext.getConnection(),
      this.requireTenant(),
    );
  }

  @Put(':provider')
  @Roles('super_admin', 'org_owner')
  save(
    @Param('provider') provider: string,
    @Body() body: SavePaymentConfigDto,
  ) {
    if (body?.isActive !== undefined && typeof body.isActive !== 'boolean') {
      throw new BadRequestException('`isActive` must be a boolean');
    }

    return this.configs.save(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      provider,
      body?.config,
      body?.isActive ?? true,
    );
  }

  private requireTenant(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new TenantNotFoundException();
    }
    return tenantId;
  }
}
