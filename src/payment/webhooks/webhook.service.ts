import { Injectable } from '@nestjs/common';
import { InvalidWebhookSignatureException } from '../exceptions/payment.exceptions';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import type { WebhookOutcome, WebhookResult } from '../payment.types';
import { PaymentService } from '../payment.service';
import type { PaymentProviderName } from '../providers/payment-provider.types';
import { PaymentProviderFactory } from '../providers/payment-provider.factory';

/** A gateway-specific parser: raw body in, normalized outcome out. */
export type WebhookParser = (raw: string) => WebhookOutcome;

/**
 * The shared body of every webhook endpoint.
 *
 * The fixed order is the security property:
 *
 *   1. load the tenant's config for the named provider (read only);
 *   2. verify the signature over the RAW bytes — never `req.body`, which Nest
 *      has already parsed and which would be re-serialised differently;
 *   3. only then parse the payload and touch `payments`/`orders`.
 *
 * A delivery with a bad signature therefore changes no state and cannot be used
 * to probe whether a payment reference exists. The provider-specific controllers
 * supply only the path name and the parser.
 */
@Injectable()
export class WebhookService {
  constructor(
    private readonly factory: PaymentProviderFactory,
    private readonly payments: PaymentService,
  ) {}

  async handle(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: PaymentProviderName,
    rawPayload: string,
    headers: Record<string, string | undefined>,
    parse: WebhookParser,
  ): Promise<WebhookResult> {
    const adapter = await this.factory.getProviderByName(tenantId, provider);

    if (!adapter.verifyWebhookSignature(rawPayload, headers)) {
      throw new InvalidWebhookSignatureException(provider);
    }

    const outcome = parse(rawPayload);
    return this.payments.settleWebhook(connection, tenantId, provider, outcome);
  }
}
