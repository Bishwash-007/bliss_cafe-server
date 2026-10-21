import { PaymentProviderRequestException } from '../exceptions/payment.exceptions';
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

/** How long a single-use Razorpay UPI QR stays collectable. */
const QR_LIFETIME_SECONDS = 15 * 60;

/**
 * # RazorpayProvider
 *
 * Strategy + Adapter for Razorpay (India).
 *
 * ## The adapter part
 *
 * Razorpay splits "create an order" from "capture a payment", and its UPI QR
 * product is a separate entity again. The adapter normalizes all three:
 *
 *   - `generateQr` creates a native `upi_qr` and returns its image;
 *   - `charge` creates a gateway order (status `created` becomes `pending`),
 *     because Razorpay has no server-side "charge this card" call without a
 *     tokenized payment method;
 *   - `refund` refunds a captured payment in full.
 *
 * ## Webhook signing
 *
 * `X-Razorpay-Signature` is an HMAC-SHA256 hex digest of the raw request body,
 * compared in constant time against `webhookSecret`. Razorpay's test and live
 * dashboards both expose the secret; unlike eSewa there is no ambiguity about
 * whether webhooks are signed.
 */
export class RazorpayProvider implements PaymentProvider {
  readonly name: PaymentProviderName = 'razorpay';

  private readonly keyId: string;
  private readonly keySecret: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly currency: string;

  constructor(
    rawConfig: ProviderConfig,
    private readonly http: PaymentHttpClient,
  ) {
    const config = requireConfigObject('razorpay', rawConfig);
    this.keyId = requireConfigString('razorpay', config, 'keyId');
    this.keySecret = requireConfigString('razorpay', config, 'keySecret');
    this.webhookSecret = requireConfigString(
      'razorpay',
      config,
      'webhookSecret',
    );
    this.baseUrl =
      typeof config.baseUrl === 'string' && config.baseUrl.length > 0
        ? config.baseUrl.replace(/\/+$/, '')
        : 'https://api.razorpay.com';
    this.currency =
      typeof config.currency === 'string' && config.currency.length > 0
        ? config.currency.toUpperCase()
        : 'INR';
  }

  // ------------------------------------------------------------------ charge

  async charge(amount: number, orderId: string): Promise<PaymentResult> {
    assertPositiveAmount(amount);

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/orders`,
      headers: this.headers(),
      body: {
        amount: toMinorUnits(amount),
        currency: this.currency,
        receipt: orderId,
        notes: { order_id: orderId },
      },
    });

    ensureSuccess('razorpay', response);
    const body = responseObject('razorpay', response);
    const reference = stringField(body, 'id');
    if (!reference) {
      throw new PaymentProviderRequestException(
        'razorpay',
        response.status,
        'the order response did not contain an id',
      );
    }

    return {
      provider: 'razorpay',
      providerReference: reference,
      // `created`/`attempted` are Razorpay's pre-capture states.
      status: mapOrderStatus(stringField(body, 'status')),
      amount,
    };
  }

  // ------------------------------------------------------------------ refund

  async refund(paymentId: string): Promise<RefundResult> {
    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/payments/${encodeURIComponent(paymentId)}/refund`,
      headers: this.headers(),
      // No `amount` in the body means a full refund of the captured payment.
      body: {},
    });

    ensureSuccess('razorpay', response);
    const body = responseObject('razorpay', response);
    const refundId = stringField(body, 'id');
    if (!refundId) {
      throw new PaymentProviderRequestException(
        'razorpay',
        response.status,
        'the refund response did not contain an id',
      );
    }

    const amountMinor = numberField(body, 'amount');
    const status = stringField(body, 'status');

    return {
      provider: 'razorpay',
      providerReference: paymentId,
      refundReference: refundId,
      status:
        status === 'processed'
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
    const closeBy = Math.floor(Date.now() / 1000) + QR_LIFETIME_SECONDS;

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/v1/payments/qr_codes`,
      headers: this.headers(),
      body: {
        type: 'upi_qr',
        name: `Order ${orderId}`,
        usage: 'single_use',
        fixed_amount: true,
        payment_amount: toMinorUnits(amount),
        description: `Order ${orderId}`,
        close_by: closeBy,
        notes: { order_id: orderId },
      },
    });

    ensureSuccess('razorpay', response);
    const body = responseObject('razorpay', response);
    const reference = stringField(body, 'id');
    const image = stringField(body, 'image_url');
    const qrString = stringField(body, 'qr_code');

    if (!reference || (!image && !qrString)) {
      throw new PaymentProviderRequestException(
        'razorpay',
        response.status,
        'the QR response did not contain an id and an image or QR string',
      );
    }

    const closeByValue = numberField(body, 'close_by');

    return {
      provider: 'razorpay',
      orderId,
      amount,
      format: image ? 'image' : 'text',
      data: (image ?? qrString) as string,
      providerReference: reference,
      expiresAt: new Date((closeByValue ?? closeBy) * 1000).toISOString(),
    };
  }

  // --------------------------------------------------------------- webhooks

  verifyWebhookSignature(
    payload: string | Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const provided = headerValue(headers, 'x-razorpay-signature');
    if (!provided) {
      return false;
    }
    const expected = hmacHex(this.webhookSecret, payload);
    return signaturesMatch(expected, provided);
  }

  // ---------------------------------------------------------------- helpers

  private headers(): Record<string, string> {
    const credentials = Buffer.from(
      `${this.keyId}:${this.keySecret}`,
      'utf8',
    ).toString('base64');
    return {
      authorization: `Basic ${credentials}`,
      'content-type': 'application/json',
    };
  }
}

function mapOrderStatus(status: string | null): PaymentOutcome {
  if (status === 'paid') {
    return 'succeeded';
  }
  if (status === 'cancelled' || status === 'expired') {
    return 'failed';
  }
  return 'pending';
}
