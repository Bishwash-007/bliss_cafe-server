import { createHmac } from 'node:crypto';
import { PaymentConfigurationException } from '../exceptions/payment.exceptions';
import type {
  PaymentHttpClient,
  PaymentHttpRequest,
  PaymentHttpResponse,
} from './payment-http';
import type {
  PaymentProvider,
  PaymentProviderName,
  ProviderConfig,
} from './payment-provider.types';
import { EsewaProvider } from './esewa.provider';
import { RazorpayProvider } from './razorpay.provider';
import { StripeProvider } from './stripe.provider';

/**
 * The shared contract every gateway adapter must satisfy.
 *
 * This is the payoff of the Adapter pattern: one suite runs against all three
 * implementations and asserts the SAME shapes. A new provider is correct when
 * this suite passes for it, without adding a provider-specific test file.
 */

class ScriptedHttp implements PaymentHttpClient {
  readonly requests: PaymentHttpRequest[] = [];

  constructor(
    private readonly handler: (
      request: PaymentHttpRequest,
    ) => PaymentHttpResponse,
  ) {}

  request(request: PaymentHttpRequest): Promise<PaymentHttpResponse> {
    this.requests.push(request);
    return Promise.resolve(this.handler(request));
  }
}

function hmac(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

interface ProviderCase {
  name: PaymentProviderName;
  config: ProviderConfig;
  create: (config: ProviderConfig, http: PaymentHttpClient) => PaymentProvider;
  expectedFormat: 'url' | 'image' | 'text';
  sign: (raw: string) => Record<string, string>;
}

const WEBHOOK_SECRET = 'whsec_contract';

function scriptedGateway(): ScriptedHttp {
  let counter = 0;
  return new ScriptedHttp((request) => {
    const url = request.url;
    counter += 1;

    if (url.includes('/v1/refunds')) {
      return {
        status: 200,
        body: { id: 're_1', status: 'succeeded', amount: 25050 },
      };
    }
    if (url.includes('/v1/payment_intents')) {
      return {
        status: 200,
        body: {
          id: `pi_${counter}`,
          client_secret: `cs_${counter}`,
          status: 'requires_payment_method',
        },
      };
    }
    if (url.includes('/api/epay/refund')) {
      return {
        status: 200,
        body: {
          refund_id: 'es_ref_1',
          status: 'COMPLETE',
          refund_amount: 250.5,
        },
      };
    }
    if (url.includes('/api/epay/charge')) {
      return {
        status: 200,
        body: { transaction_code: 'es_txn_1', status: 'COMPLETE' },
      };
    }
    if (url.includes('/api/qr/generate')) {
      return {
        status: 200,
        body: {
          qr_image_url: 'https://esewa.test/qr.png',
          expires_at: '2030-01-01T00:00:00.000Z',
        },
      };
    }
    if (url.includes('/v1/payments/qr_codes')) {
      return {
        status: 200,
        body: {
          id: 'qr_1',
          image_url: 'https://razorpay.test/qr.png',
          close_by: Math.floor(Date.now() / 1000) + 900,
        },
      };
    }
    if (url.includes('/v1/orders')) {
      return { status: 200, body: { id: 'order_1', status: 'created' } };
    }
    if (/\/v1\/payments\/[^/]+\/refund$/.test(url)) {
      return {
        status: 200,
        body: { id: 'rfnd_1', status: 'processed', amount: 25050 },
      };
    }
    return { status: 404, body: { error: `unscripted ${url}` } };
  });
}

const CASES: ProviderCase[] = [
  {
    name: 'stripe',
    config: {
      secretKey: 'sk_test',
      webhookSecret: WEBHOOK_SECRET,
      paymentMethod: 'pm_card_visa',
      baseUrl: 'https://stripe.test',
      checkoutBaseUrl: 'https://pay.stripe.test',
    },
    create: (config, http) => new StripeProvider(config, http),
    expectedFormat: 'url',
    sign: (raw) => {
      const timestamp = Math.floor(Date.now() / 1000);
      return {
        'stripe-signature': `t=${timestamp},v1=${hmac(
          WEBHOOK_SECRET,
          `${timestamp}.${raw}`,
        )}`,
      };
    },
  },
  {
    name: 'esewa',
    config: {
      merchantCode: 'EPAYTEST',
      secretKey: 'esewa-secret',
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: 'https://esewa.test',
    },
    create: (config, http) => new EsewaProvider(config, http),
    expectedFormat: 'image',
    sign: (raw) => ({
      'x-esewa-signature': hmac(WEBHOOK_SECRET, raw),
    }),
  },
  {
    name: 'razorpay',
    config: {
      keyId: 'rzp_test_key',
      keySecret: 'rzp_test_secret',
      webhookSecret: WEBHOOK_SECRET,
      baseUrl: 'https://razorpay.test',
    },
    create: (config, http) => new RazorpayProvider(config, http),
    expectedFormat: 'image',
    sign: (raw) => ({
      'x-razorpay-signature': hmac(WEBHOOK_SECRET, raw),
    }),
  },
];

describe.each(CASES)('$name adapter contract', (providerCase) => {
  function provider(): PaymentProvider {
    return providerCase.create(providerCase.config, scriptedGateway());
  }

  it('reports its provider name', () => {
    expect(provider().name).toBe(providerCase.name);
  });

  it('charge returns the common PaymentResult shape', async () => {
    const result = await provider().charge(250.5, 'order-1');

    expect(Object.keys(result).sort()).toEqual([
      'amount',
      'provider',
      'providerReference',
      'status',
    ]);
    expect(result.provider).toBe(providerCase.name);
    expect(result.amount).toBe(250.5);
    expect(result.providerReference).toEqual(expect.any(String));
    expect(['pending', 'succeeded', 'failed']).toContain(result.status);
  });

  it('generateQr returns the identical QrPayload shape for every provider', async () => {
    const qr = await provider().generateQr('order-1', 250.5);

    expect(Object.keys(qr).sort()).toEqual([
      'amount',
      'data',
      'expiresAt',
      'format',
      'orderId',
      'provider',
      'providerReference',
    ]);
    expect(qr.provider).toBe(providerCase.name);
    expect(qr.orderId).toBe('order-1');
    expect(qr.amount).toBe(250.5);
    expect(qr.format).toBe(providerCase.expectedFormat);
    expect(qr.data.length).toBeGreaterThan(0);
    expect(qr.providerReference.length).toBeGreaterThan(0);
    expect(qr.expiresAt === null || typeof qr.expiresAt === 'string').toBe(
      true,
    );
  });

  it('refund returns the common RefundResult shape', async () => {
    const result = await provider().refund('gateway_ref_1');

    expect(Object.keys(result).sort()).toEqual([
      'amount',
      'provider',
      'providerReference',
      'refundReference',
      'status',
    ]);
    expect(result.provider).toBe(providerCase.name);
    expect(result.providerReference).toBe('gateway_ref_1');
    expect(['succeeded', 'pending', 'failed']).toContain(result.status);
  });

  it('accepts a correctly signed webhook', () => {
    const raw = '{"event":"test"}';
    const headers = providerCase.sign(raw);

    expect(provider().verifyWebhookSignature(raw, headers)).toBe(true);
  });

  it('rejects a wrong signature and a missing header', () => {
    const raw = '{"event":"test"}';

    const wrong = Object.fromEntries(
      Object.keys(providerCase.sign(raw)).map((key) => [key, 'deadbeef']),
    );
    expect(provider().verifyWebhookSignature(raw, wrong)).toBe(false);
    expect(provider().verifyWebhookSignature(raw, {})).toBe(false);
  });

  it('rejects a configuration without the required secrets', () => {
    expect(() => providerCase.create({}, scriptedGateway())).toThrow(
      PaymentConfigurationException,
    );
  });
});

describe('Stripe webhook replay protection', () => {
  const provider = new StripeProvider(CASES[0].config, scriptedGateway());
  const raw = '{"event":"test"}';

  it('rejects a correctly signed delivery older than the tolerance', () => {
    const oldTimestamp = Math.floor(Date.now() / 1000) - 3600;

    expect(
      provider.verifyWebhookSignature(raw, {
        'stripe-signature': `t=${oldTimestamp},v1=${hmac(
          WEBHOOK_SECRET,
          `${oldTimestamp}.${raw}`,
        )}`,
      }),
    ).toBe(false);
  });

  it('rejects a malformed signature header', () => {
    expect(
      provider.verifyWebhookSignature(raw, { 'stripe-signature': 'nonsense' }),
    ).toBe(false);
  });
});
