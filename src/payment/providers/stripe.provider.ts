import {
  PaymentConfigurationException,
  PaymentProviderRequestException,
} from '../exceptions/payment.exceptions';
import { fromMinorUnits, toMinorUnits } from '../money';
import type { PaymentHttpClient } from './payment-http';
import type {
  PaymentOutcome,
  PaymentProvider,
  PaymentProviderName,
  PaymentResult,
  ProviderConfig,
  QrPayload,
  RefundResult,
} from './payment-provider.types';
import {
  assertPositiveAmount,
  ensureSuccess,
  headerValue,
  hmacHex,
  numberField,
  requireConfigObject,
  requireConfigString,
  responseObject,
  signaturesMatch,
  stringField,
} from './provider-support';

/** How old a signed Stripe webhook may be before it is rejected as a replay. */
const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * # StripeProvider
 *
 * Strategy + Adapter for Stripe.
 *
 * ## The adapter part
 *
 * Stripe's API is form-encoded, authenticates with a bearer secret, and returns
 * Payment Intents, Refunds and error envelopes of its own shape. None of that
 * crosses the class boundary: `charge`, `refund` and `generateQr` return the
 * shared `PaymentResult` / `RefundResult` / `QrPayload`.
 *
 * ## Why `generateQr` returns a URL, not an image
 *
 * A Stripe Payment Intent is not a QR code. The adapter creates the intent and
 * hands back the intent's hosted payment page (`checkout.stripe.com/c/pay/…`,
 * the page Stripe.js itself opens from a client secret). The caller encodes
 * that URL as a QR. Making Stripe look like eSewa would mean proxying an image
 * we do not own; returning the URL is the honest normalization.
 *
 * The `client_secret` is therefore present inside `data`. It is a one-intent
 * capability, not the tenant's account key, but it must still be treated as a
 * credential by the client — it is never logged by this class.
 */
export class StripeProvider implements PaymentProvider {
  readonly name: PaymentProviderName = 'stripe';

  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly checkoutUrl: string;
  private readonly currency: string;
  private readonly paymentMethod: string | null;

  constructor(
    rawConfig: ProviderConfig,
    private readonly http: PaymentHttpClient,
  ) {
    const config = requireConfigObject('stripe', rawConfig);
    this.secretKey = requireConfigString('stripe', config, 'secretKey');
    this.webhookSecret = requireConfigString('stripe', config, 'webhookSecret');
    this.baseUrl =
      typeof config.baseUrl === 'string'
        ? config.baseUrl.replace(/\/+$/, '')
        : 'https://api.stripe.com';
    this.checkoutUrl =
      typeof config.checkoutBaseUrl === 'string'
        ? config.checkoutBaseUrl.replace(/\/+$/, '')
        : 'https://checkout.stripe.com';
    this.currency =
      typeof config.currency === 'string' && config.currency.length > 0
        ? config.currency.toLowerCase()
        : 'usd';
    this.paymentMethod =
      typeof config.paymentMethod === 'string' &&
      config.paymentMethod.length > 0
        ? config.paymentMethod
        : null;
  }

  // ------------------------------------------------------------------ charge

  async charge(amount: number, orderId: string): Promise<PaymentResult> {
    assertPositiveAmount(amount);

    if (!this.paymentMethod) {
      throw new PaymentConfigurationException(
        'stripe',
        `'paymentMethod' is required to charge directly. Without a payment ` +
          `method Stripe can only create an intent, which is what generateQr ` +
          `does. Use a Payment Link / QR for a customer-present card.`,
      );
    }

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/payment_intents`,
      headers: this.headers(),
      body: this.intentForm(amount, orderId, {
        confirm: 'true',
        payment_method: this.paymentMethod,
      }),
    });

    ensureSuccess('stripe', response);
    const body = responseObject('stripe', response);
    const reference = stringField(body, 'id');
    if (!reference) {
      throw new PaymentProviderRequestException(
        'stripe',
        response.status,
        'the payment intent response did not contain an id',
      );
    }

    return {
      provider: 'stripe',
      providerReference: reference,
      status: mapIntentStatus(stringField(body, 'status')),
      amount,
    };
  }

  // ------------------------------------------------------------------ refund

  async refund(paymentId: string): Promise<RefundResult> {
    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/refunds`,
      headers: this.headers(),
      body: new URLSearchParams({ payment_intent: paymentId }),
    });

    ensureSuccess('stripe', response);
    const body = responseObject('stripe', response);
    const refundId = stringField(body, 'id');
    if (!refundId) {
      throw new PaymentProviderRequestException(
        'stripe',
        response.status,
        'the refund response did not contain an id',
      );
    }

    const status = stringField(body, 'status');
    const amountMinor = numberField(body, 'amount');

    return {
      provider: 'stripe',
      providerReference: paymentId,
      refundReference: refundId,
      status:
        status === 'succeeded'
          ? 'succeeded'
          : status === 'pending'
            ? 'pending'
            : 'failed',
      amount: amountMinor === null ? null : fromMinorUnits(amountMinor),
    };
  }

  // --------------------------------------------------------------------- QR

  async generateQr(orderId: string, amount: number): Promise<QrPayload> {
    assertPositiveAmount(amount);

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/payment_intents`,
      headers: this.headers(),
      body: this.intentForm(amount, orderId),
    });

    ensureSuccess('stripe', response);
    const body = responseObject('stripe', response);
    const reference = stringField(body, 'id');
    const clientSecret = stringField(body, 'client_secret');

    if (!reference || !clientSecret) {
      throw new PaymentProviderRequestException(
        'stripe',
        response.status,
        'the payment intent response lacked an id or client_secret',
      );
    }

    return {
      provider: 'stripe',
      orderId,
      amount,
      format: 'url',
      data: `${this.checkoutUrl}/c/pay/${clientSecret}`,
      providerReference: reference,
      // Payment Intents do not expire on a schedule; the client should show the
      // QR until the intent is cancelled or paid.
      expiresAt: null,
    };
  }

  // --------------------------------------------------------------- webhooks

  verifyWebhookSignature(
    payload: string | Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const header = headerValue(headers, 'stripe-signature');
    if (!header) {
      return false;
    }

    const timestamp: string[] = [];
    const signatures: string[] = [];

    for (const part of header.split(',')) {
      const [key, value] = part.split('=', 2).map((piece) => piece.trim());
      if (key === 't' && value) {
        timestamp.push(value);
      } else if (key === 'v1' && value) {
        signatures.push(value);
      }
    }

    const timestampValue = timestamp[0];
    if (!timestampValue || signatures.length === 0) {
      return false;
    }

    const seconds = Number(timestampValue);
    if (
      !Number.isFinite(seconds) ||
      Math.abs(Date.now() / 1000 - seconds) > WEBHOOK_TOLERANCE_SECONDS
    ) {
      // A correctly signed but old delivery is still a replay. Stripe's own
      // libraries apply the same default tolerance.
      return false;
    }

    const payloadBuffer = Buffer.isBuffer(payload)
      ? payload
      : Buffer.from(payload, 'utf8');
    const signed = Buffer.concat([
      Buffer.from(`${timestampValue}.`, 'utf8'),
      payloadBuffer,
    ]);
    const expected = hmacHex(this.webhookSecret, signed);

    return signatures.some((signature) => signaturesMatch(expected, signature));
  }

  // ---------------------------------------------------------------- helpers

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.secretKey}`,
      'content-type': 'application/x-www-form-urlencoded',
    };
  }

  private intentForm(
    amount: number,
    orderId: string,
    extra: Record<string, string> = {},
  ): URLSearchParams {
    return new URLSearchParams({
      amount: String(toMinorUnits(amount)),
      currency: this.currency,
      'automatic_payment_methods[enabled]': 'true',
      'metadata[order_id]': orderId,
      ...extra,
    });
  }
}

/** Maps Stripe's intent status vocabulary onto the module's three outcomes. */
function mapIntentStatus(status: string | null): PaymentOutcome {
  if (status === 'succeeded') {
    return 'succeeded';
  }
  if (status === 'canceled') {
    return 'failed';
  }
  return 'pending';
}
