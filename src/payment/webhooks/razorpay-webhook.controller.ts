import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { TenantNotFoundException } from '../../tenant/exceptions/tenant-not-found.exception';
import { TenantRequestContext } from '../../tenant/connection/tenant-request-context';
import { headerMap, rawPayload } from './webhook-request';
import { parseRazorpayWebhook } from './webhook-payloads';
import { WebhookService } from './webhook.service';

/** Public Razorpay webhook endpoint. See `StripeWebhookController` for tenancy. */
@Controller('webhooks')
export class RazorpayWebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Post('razorpay')
  @HttpCode(HttpStatus.OK)
  handle(@Req() request: RawBodyRequest<Request>) {
    return this.webhooks.handle(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      'razorpay',
      rawPayload(request),
      headerMap(request),
      parseRazorpayWebhook,
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
