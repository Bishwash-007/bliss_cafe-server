import { Injectable } from '@nestjs/common';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import { PaymentConfigCipher } from './payment-config.cipher';
import { PaymentConfigurationException } from '../exceptions/payment.exceptions';
import { PaymentRepository } from '../payment.repository';
import { PaymentProviderFactory } from '../providers/payment-provider.factory';

export interface PublicPaymentConfig {
  provider: string;
  is_active: boolean;
}

export interface SavePaymentConfigResult extends PublicPaymentConfig {
  /** True when this save activated the provider and deactivated every other. */
  activated: boolean;
}

/**
 * Reads and writes tenant gateway configuration.
 *
 * The only values returned to a client are `provider` and `is_active`.
 * `config_encrypted` never leaves the database unencrypted except inside the
 * factory, which hands the plaintext straight to a provider constructor.
 */
@Injectable()
export class PaymentConfigService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly cipher: PaymentConfigCipher,
    private readonly factory: PaymentProviderFactory,
  ) {}

  async list(
    connection: TenantScopedConnection,
    tenantId: string,
  ): Promise<PublicPaymentConfig[]> {
    const rows = await this.repository.listConfigs(connection, tenantId);
    return rows.map((row) => ({
      provider: row.provider,
      is_active: row.is_active,
    }));
  }

  async save(
    connection: TenantScopedConnection,
    tenantId: string,
    provider: string,
    config: unknown,
    isActive: boolean,
  ): Promise<SavePaymentConfigResult> {
    if (
      typeof config !== 'object' ||
      config === null ||
      Array.isArray(config)
    ) {
      throw new PaymentConfigurationException(
        provider,
        'the request body must be `{ "config": { ... }, "isActive": true }`',
      );
    }

    // Constructing the adapter validates the required keys without making a
    // network call, so a misspelled secret is rejected at save time.
    this.factory.validateConfiguration(
      provider,
      config as Record<string, unknown>,
    );

    if (isActive) {
      await this.repository.deactivateOtherProviders(
        connection,
        tenantId,
        provider,
      );
    }

    const encrypted = this.cipher.encrypt(JSON.stringify(config));
    const row = await this.repository.upsertConfig(
      connection,
      tenantId,
      provider,
      encrypted,
      isActive,
    );

    return {
      provider: row.provider,
      is_active: row.is_active,
      activated: isActive,
    };
  }
}
