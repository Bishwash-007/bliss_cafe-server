import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { TenantNotFoundException } from '../../tenant/exceptions/tenant-not-found.exception';
import { TenantRequestContext } from '../../tenant/connection/tenant-request-context';
import { headerMap, rawPayload } from './webhook-request';
import { parseStripeWebhook } from './webhook-payloads';
import { WebhookService } from './webhook.service';

/**
 * Public Stripe webhook endpoint.
 *
 * No `JwtAuthGuard`: Stripe cannot present a staff token. The tenant is
 * resolved by the normal middleware chain (subdomain, then `X-Tenant-Id`), so
 * each tenant registers `https://<tenant>.api.example.com/webhooks/stripe` in
 * its Stripe dashboard and the request lands in the right RLS scope. The
 * signature — not the URL — is what proves the sender.
 */
@Controller('webhooks')
export class StripeWebhookController {
  constructor(
    private readonly webhooks: WebhookService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Post('stripe')
  @HttpCode(HttpStatus.OK)
  handle(@Req() request: RawBodyRequest<Request>) {
    return this.webhooks.handle(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      'stripe',
      rawPayload(request),
      headerMap(request),
      parseStripeWebhook,
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
