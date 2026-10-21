import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantConnectionService } from '../../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import { PaymentConfigCipher } from '../config/payment-config.cipher';
import {
  AmbiguousPaymentProviderException,
  PaymentConfigurationException,
  PaymentProviderNotConfiguredException,
  PaymentProviderNotConfiguredForException,
  UnsupportedPaymentProviderException,
} from '../exceptions/payment.exceptions';
import { PaymentRepository } from '../payment.repository';
import type { PaymentConfigRow } from '../payment.types';
import { EsewaProvider } from './esewa.provider';
import { PAYMENT_HTTP } from './payment-http';
import type { PaymentHttpClient } from './payment-http';
import {
  PAYMENT_PROVIDERS,
  isPaymentProviderName,
} from './payment-provider.types';
import type {
  PaymentProvider,
  PaymentProviderName,
  ProviderConfig,
} from './payment-provider.types';
import { RazorpayProvider } from './razorpay.provider';
import { StripeProvider } from './stripe.provider';

/** Constructs one adapter around one tenant's decrypted config. */
type ProviderBuilder = (
  config: ProviderConfig,
  http: PaymentHttpClient,
) => PaymentProvider;

/**
 * # PaymentProviderFactory
 *
 * The **only** place that knows which gateway implementations exist.
 *
 * Callers ask for "the tenant's provider" and receive a `PaymentProvider`.
 * They never import `StripeProvider`, never switch on a provider string, and
 * adding a fourth gateway means one entry in `builders` plus a class — no
 * changes to checkout, refunds, or webhooks.
 *
 * ## One provider per tenant
 *
 * `tenant_payment_configs` allows a row per provider, but a checkout has to
 * know which gateway to charge. `getProvider` therefore requires exactly one
 * `is_active` row: none is a configuration error, two is an ambiguity that must
 * be fixed rather than guessed. The config endpoint enforces the same
 * invariant when it activates a provider.
 *
 * ## Why reads get their own connection
 *
 * The signature is `getProvider(tenantId)` — deliberately not
 * `getProvider(connection, tenantId)`. Config is committed state that changes
 * rarely, and hiding the acquisition here keeps provider construction out of
 * the caller's transaction. A checkout may be mid-transaction on its own
 * connection; reading config on a second one cannot see uncommitted writes, but
 * no code path writes config and reads it in the same request.
 */
@Injectable()
export class PaymentProviderFactory {
  private readonly logger = new Logger(PaymentProviderFactory.name);

  /**
   * The registry. `Record<PaymentProviderName, …>` makes the compiler reject a
   * `PAYMENT_PROVIDERS` entry without a builder.
   */
  private readonly builders: Record<PaymentProviderName, ProviderBuilder> = {
    stripe: (config, http) => new StripeProvider(config, http),
    esewa: (config, http) => new EsewaProvider(config, http),
    razorpay: (config, http) => new RazorpayProvider(config, http),
  };

  constructor(
    private readonly repository: PaymentRepository,
    private readonly connections: TenantConnectionService,
    private readonly cipher: PaymentConfigCipher,
    @Inject(PAYMENT_HTTP) private readonly http: PaymentHttpClient,
  ) {}

  /** The tenant's single active gateway. */
  async getProvider(tenantId: string): Promise<PaymentProvider> {
    const rows = await this.withConnection(tenantId, (connection) =>
      this.repository.findActiveConfigs(connection, tenantId),
    );

    if (rows.length === 0) {
      throw new PaymentProviderNotConfiguredException(tenantId);
    }
    if (rows.length > 1) {
      throw new AmbiguousPaymentProviderException(
        tenantId,
        rows.map((row) => row.provider),
      );
    }

    return this.instantiate(rows[0]);
  }

  /**
   * A specific provider, active or not.
   *
   * Webhooks and refunds name their provider in the URL, and must keep working
   * for a gateway that was deactivated after the payment was taken. Signature
   * verification needs the same secret whether the provider is still the
   * default or not.
   */
  async getProviderByName(
    tenantId: string,
    provider: string,
  ): Promise<PaymentProvider> {
    if (!isPaymentProviderName(provider)) {
      throw new UnsupportedPaymentProviderException(
        provider,
        PAYMENT_PROVIDERS,
      );
    }

    const row = await this.withConnection(tenantId, (connection) =>
      this.repository.findConfigByProvider(connection, tenantId, provider),
    );
    if (!row) {
      throw new PaymentProviderNotConfiguredForException(tenantId, provider);
    }
    return this.instantiate(row);
  }

  /**
   * Builds an adapter only to validate a config, discarding it.
   *
   * Used by the config endpoint so a typo (`secretkey` instead of `secretKey`)
   * is rejected when it is saved, not at the first checkout. Constructors do no
   * network I/O, so this is safe.
   */
  validateConfiguration(provider: string, config: ProviderConfig): void {
    if (!isPaymentProviderName(provider)) {
      throw new UnsupportedPaymentProviderException(
        provider,
        PAYMENT_PROVIDERS,
      );
    }
    this.builders[provider](config, this.http);
  }

  // ---------------------------------------------------------------- internal

  private instantiate(row: PaymentConfigRow): PaymentProvider {
    if (!isPaymentProviderName(row.provider)) {
      throw new UnsupportedPaymentProviderException(
        row.provider,
        PAYMENT_PROVIDERS,
      );
    }

    const plaintext = this.cipher.decrypt(row.config_encrypted, row.provider);
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext) as unknown;
    } catch {
      throw new PaymentConfigurationException(
        row.provider,
        'the stored configuration is not valid JSON',
      );
    }

    return this.builders[row.provider](parsed as ProviderConfig, this.http);
  }

  private async withConnection<T>(
    tenantId: string,
    work: (connection: TenantScopedConnection) => Promise<T>,
  ): Promise<T> {
    const connection = await this.connections.acquireScoped(tenantId);
    try {
      return await work(connection);
    } finally {
      try {
        await connection.release();
      } catch (error) {
        // A read-only connection failing to COMMIT has no effect on the data;
        // logging keeps the pool healthy without masking the original error.
        this.logger.warn(
          `Releasing payment config connection failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
