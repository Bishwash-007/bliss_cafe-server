import { PaymentConfigCipher } from '../config/payment-config.cipher';
import {
  AmbiguousPaymentProviderException,
  PaymentProviderNotConfiguredException,
  PaymentProviderNotConfiguredForException,
  UnsupportedPaymentProviderException,
  PaymentConfigurationException,
} from '../exceptions/payment.exceptions';
import type { TenantConnectionService } from '../../tenant/connection/tenant-connection.service';
import type { PaymentRepository } from '../payment.repository';
import type { PaymentConfigRow } from '../payment.types';
import { PaymentProviderFactory } from './payment-provider.factory';
import { EsewaProvider } from './esewa.provider';
import { RazorpayProvider } from './razorpay.provider';
import { StripeProvider } from './stripe.provider';

function configRow(provider: string, config: object): PaymentConfigRow {
  return {
    id: `config-${provider}`,
    tenant_id: 'tenant-1',
    provider,
    config_encrypted: JSON.stringify(config),
    is_active: true,
  };
}

describe('PaymentProviderFactory', () => {
  const connection: { release: jest.Mock } = {
    release: jest.fn().mockResolvedValue(undefined),
  };

  let repository: {
    findActiveConfigs: jest.Mock;
    findConfigByProvider: jest.Mock;
  };
  let connections: { acquireScoped: jest.Mock };
  let cipher: { decrypt: jest.Mock };
  let http: { request: jest.Mock };
  let factory: PaymentProviderFactory;

  beforeEach(() => {
    jest.clearAllMocks();
    repository = {
      findActiveConfigs: jest.fn(),
      findConfigByProvider: jest.fn(),
    };
    connections = {
      acquireScoped: jest.fn().mockResolvedValue(connection),
    };
    cipher = {
      // The row helper stores JSON in `config_encrypted`, so echoing it is
      // equivalent to a successful decrypt for these tests.
      decrypt: jest.fn((value: string) => value),
    };
    http = { request: jest.fn() };
    factory = new PaymentProviderFactory(
      repository as unknown as PaymentRepository,
      connections as unknown as TenantConnectionService,
      cipher as unknown as PaymentConfigCipher,
      http,
    );
  });

  it('builds the concrete adapter named by the active config', async () => {
    repository.findActiveConfigs.mockResolvedValue([
      configRow('stripe', {
        secretKey: 'sk',
        webhookSecret: 'whsec',
      }),
    ]);

    const provider = await factory.getProvider('tenant-1');

    expect(provider).toBeInstanceOf(StripeProvider);
    expect(connections.acquireScoped).toHaveBeenCalledWith('tenant-1');
    expect(connection.release).toHaveBeenCalled();
  });

  it.each([
    [
      'esewa',
      { merchantCode: 'EPAYTEST', secretKey: 'sk', webhookSecret: 'whsec' },
      EsewaProvider,
    ],
    [
      'razorpay',
      { keyId: 'key', keySecret: 'secret', webhookSecret: 'whsec' },
      RazorpayProvider,
    ],
  ])('builds %s', async (name, config, expected) => {
    repository.findActiveConfigs.mockResolvedValue([configRow(name, config)]);

    await expect(factory.getProvider('tenant-1')).resolves.toBeInstanceOf(
      expected,
    );
  });

  it('fails when the tenant has no active provider', async () => {
    repository.findActiveConfigs.mockResolvedValue([]);

    await expect(factory.getProvider('tenant-1')).rejects.toBeInstanceOf(
      PaymentProviderNotConfiguredException,
    );
  });

  it('fails rather than guessing when two providers are active', async () => {
    repository.findActiveConfigs.mockResolvedValue([
      configRow('stripe', {}),
      configRow('esewa', {}),
    ]);

    await expect(factory.getProvider('tenant-1')).rejects.toBeInstanceOf(
      AmbiguousPaymentProviderException,
    );
  });

  it('resolves a named provider even when it is not the active one', async () => {
    repository.findConfigByProvider.mockResolvedValue({
      ...configRow('stripe', { secretKey: 'sk', webhookSecret: 'whsec' }),
      is_active: false,
    });

    const provider = await factory.getProviderByName('tenant-1', 'stripe');

    expect(provider).toBeInstanceOf(StripeProvider);
    expect(repository.findConfigByProvider).toHaveBeenCalledWith(
      connection,
      'tenant-1',
      'stripe',
    );
  });

  it('rejects an unknown provider name before touching the database', async () => {
    await expect(
      factory.getProviderByName('tenant-1', 'paypal'),
    ).rejects.toBeInstanceOf(UnsupportedPaymentProviderException);
    expect(connections.acquireScoped).not.toHaveBeenCalled();
  });

  it('reports a named provider that is not configured', async () => {
    repository.findConfigByProvider.mockResolvedValue(null);

    await expect(
      factory.getProviderByName('tenant-1', 'stripe'),
    ).rejects.toBeInstanceOf(PaymentProviderNotConfiguredForException);
  });

  it('rejects a row naming a provider this build does not implement', async () => {
    repository.findActiveConfigs.mockResolvedValue([configRow('paypal', {})]);

    await expect(factory.getProvider('tenant-1')).rejects.toBeInstanceOf(
      UnsupportedPaymentProviderException,
    );
  });

  it('decrypts the stored config with the row provider', async () => {
    const row = configRow('stripe', {
      secretKey: 'sk',
      webhookSecret: 'whsec',
    });
    repository.findActiveConfigs.mockResolvedValue([row]);
    cipher.decrypt.mockReturnValue(
      JSON.stringify({ secretKey: 'sk', webhookSecret: 'whsec' }),
    );

    await factory.getProvider('tenant-1');

    expect(cipher.decrypt).toHaveBeenCalledWith(row.config_encrypted, 'stripe');
  });

  it('rejects a stored config that is not JSON', async () => {
    repository.findActiveConfigs.mockResolvedValue([configRow('stripe', {})]);
    cipher.decrypt.mockReturnValue('not json');

    await expect(factory.getProvider('tenant-1')).rejects.toBeInstanceOf(
      PaymentConfigurationException,
    );
  });

  it('validates a config without calling the gateway', () => {
    expect(() =>
      factory.validateConfiguration('stripe', {
        secretKey: 'sk',
        webhookSecret: 'whsec',
      }),
    ).not.toThrow();

    expect(() => factory.validateConfiguration('stripe', {})).toThrow(
      PaymentConfigurationException,
    );
    expect(() => factory.validateConfiguration('paypal', {})).toThrow(
      UnsupportedPaymentProviderException,
    );
    expect(http.request).not.toHaveBeenCalled();
  });
});
