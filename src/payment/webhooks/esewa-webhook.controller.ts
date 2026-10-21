import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { TenantNotFoundException } from '../../tenant/exceptions/tenant-not-found.exception';
import { TenantRequestContext } from '../../tenant/connection/tenant-request-context';
import { headerMap, rawPayload } from './webhook-request';
import { parseEsewaWebhook } from './webhook-payloads';
import { WebhookService } from './webhook.service';

/** Public eSewa webhook endpoint. See `StripeWebhookController` for tenancy. */
@Controller('webhooks')
export class EsewaWebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Post('esewa')
  @HttpCode(HttpStatus.OK)
  handle(@Req() request: RawBodyRequest<Request>) {
    return this.webhooks.handle(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      'esewa',
      rawPayload(request),
      headerMap(request),
      parseEsewaWebhook,
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
