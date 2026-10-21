import { randomUUID } from 'node:crypto';
import { PaymentProviderRequestException } from '../exceptions/payment.exceptions';
import { round2 } from '../money';
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
  hmacBase64,
  hmacHex,
  numberField,
  requireConfigObject,
  requireConfigString,
  responseObject,
  signaturesMatch,
  stringField,
} from './provider-support';

/**
 * # EsewaProvider
 *
 * Strategy + Adapter for eSewa (Nepal).
 *
 * ## The adapter part
 *
 * eSewa's ePay v2 flow is form/redirect-shaped and its QR product returns its
 * own field names (`qr_image`, `qr_code`, `transaction_code`, …) depending on
 * the product version. This class is the one place that knows those names; the
 * rest of the module sees `QrPayload` and `PaymentResult`.
 *
 * ## Native QR
 *
 * eSewa generates the QR itself, so `generateQr` calls its QR endpoint rather
 * than encoding a URL locally. The adapter still returns a uniform `QrPayload`
 * — `data` is the image URL (or QR string) and `format` says which.
 *
 * ## Signature scheme
 *
 * eSewa signs request fields with an HMAC, and its webhook products differ on
 * whether they sign at all. This adapter requires a shared webhook secret and
 * verifies `x-esewa-signature` as HMAC-SHA256 hex over the raw body — the
 * strongest option available across its products. A tenant whose eSewa plan
 * cannot sign webhooks must not run unattended: configure the webhook secret
 * and keep the endpoint authenticated at the network edge.
 */
export class EsewaProvider implements PaymentProvider {
  readonly name: PaymentProviderName = 'esewa';

  private readonly merchantCode: string;
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;
  private readonly currency: string;

  constructor(
    rawConfig: ProviderConfig,
    private readonly http: PaymentHttpClient,
  ) {
    const config = requireConfigObject('esewa', rawConfig);
    this.merchantCode = requireConfigString('esewa', config, 'merchantCode');
    this.secretKey = requireConfigString('esewa', config, 'secretKey');
    this.webhookSecret = requireConfigString('esewa', config, 'webhookSecret');
    this.baseUrl =
      typeof config.baseUrl === 'string' && config.baseUrl.length > 0
        ? config.baseUrl.replace(/\/+$/, '')
        : 'https://rc-epay.esewa.com.np';
    this.currency =
      typeof config.currency === 'string' && config.currency.length > 0
        ? config.currency.toUpperCase()
        : 'NPR';
  }

  // ------------------------------------------------------------------ charge

  async charge(amount: number, orderId: string): Promise<PaymentResult> {
    assertPositiveAmount(amount);
    const reference = `esewa_${randomUUID()}`;
    const amountText = round2(amount).toFixed(2);

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/epay/charge`,
      headers: this.headers(),
      body: {
        merchant_code: this.merchantCode,
        product_code: this.merchantCode,
        amount: amountText,
        transaction_uuid: reference,
        order_id: orderId,
        signature: this.signFields(amountText, reference),
      },
    });

    ensureSuccess('esewa', response);
    const body = responseObject('esewa', response);
    const transactionCode =
      stringField(body, 'transaction_code') ??
      stringField(body, 'transactionCode') ??
      reference;

    return {
      provider: 'esewa',
      providerReference: transactionCode,
      status: mapEsewaStatus(stringField(body, 'status')),
      amount,
    };
  }

  // ------------------------------------------------------------------ refund

  async refund(paymentId: string): Promise<RefundResult> {
    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/epay/refund`,
      headers: this.headers(),
      body: {
        merchant_code: this.merchantCode,
        product_code: this.merchantCode,
        transaction_uuid: paymentId,
        signature: hmacBase64(
          this.secretKey,
          `merchant_code=${this.merchantCode},transaction_uuid=${paymentId}`,
        ),
      },
    });

    ensureSuccess('esewa', response);
    const body = responseObject('esewa', response);
    const refundId =
      stringField(body, 'refund_id') ??
      stringField(body, 'refundId') ??
      stringField(body, 'refund_code') ??
      paymentId;
    const amount = numberField(body, 'refund_amount');

    return {
      provider: 'esewa',
      providerReference: paymentId,
      refundReference: refundId,
      status: mapEsewaRefundStatus(stringField(body, 'status')),
      amount: amount === null ? null : round2(amount),
    };
  }

  // --------------------------------------------------------------------- QR

  async generateQr(orderId: string, amount: number): Promise<QrPayload> {
    assertPositiveAmount(amount);
    const reference = `esewa_${randomUUID()}`;
    const amountText = round2(amount).toFixed(2);

    const response = await this.http.request({
      method: 'POST',
      url: `${this.baseUrl}/api/qr/generate`,
      headers: this.headers(),
      body: {
        merchant_code: this.merchantCode,
        product_code: this.merchantCode,
        amount: amountText,
        transaction_uuid: reference,
        order_id: orderId,
        signature: this.signFields(amountText, reference),
      },
    });

    ensureSuccess('esewa', response);
    const body = responseObject('esewa', response);

    const image =
      stringField(body, 'qr_image_url') ??
      stringField(body, 'qrImageUrl') ??
      stringField(body, 'qr_image') ??
      stringField(body, 'image_url');
    const text =
      stringField(body, 'qr_data') ??
      stringField(body, 'qrData') ??
      stringField(body, 'qr_code') ??
      stringField(body, 'qrCode') ??
      stringField(body, 'qr_string');

    const data = image ?? text;
    if (!data) {
      throw new PaymentProviderRequestException(
        'esewa',
        response.status,
        'the QR response contained no image or QR data',
      );
    }

    const expiresAt =
      stringField(body, 'expires_at') ??
      stringField(body, 'expiresAt') ??
      stringField(body, 'valid_until');

    return {
      provider: 'esewa',
      orderId,
      amount,
      format: image ? 'image' : data.startsWith('http') ? 'url' : 'text',
      data,
      providerReference: reference,
      expiresAt: expiresAt ?? null,
    };
  }

  // --------------------------------------------------------------- webhooks

  verifyWebhookSignature(
    payload: string | Buffer,
    headers: Record<string, string | undefined>,
  ): boolean {
    const provided = headerValue(headers, 'x-esewa-signature');
    if (!provided) {
      return false;
    }
    const expected = hmacHex(this.webhookSecret, payload);
    return signaturesMatch(expected, provided);
  }

  // ---------------------------------------------------------------- helpers

  private headers(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-esewa-merchant': this.merchantCode,
    };
  }

  /** eSewa's documented field signature: amount, transaction and product. */
  private signFields(amountText: string, reference: string): string {
    return hmacBase64(
      this.secretKey,
      `total_amount=${amountText},transaction_uuid=${reference},` +
        `product_code=${this.merchantCode}`,
    );
  }
}

function mapEsewaStatus(status: string | null): PaymentOutcome {
  const value = status?.toUpperCase();
  if (value === 'COMPLETE' || value === 'SUCCESS' || value === 'SUCCEEDED') {
    return 'succeeded';
  }
  if (value === 'FAILED' || value === 'CANCELED' || value === 'CANCELLED') {
    return 'failed';
  }
  return 'pending';
}

function mapEsewaRefundStatus(
  status: string | null,
): 'succeeded' | 'pending' | 'failed' {
  const value = status?.toUpperCase();
  if (value === 'COMPLETE' || value === 'SUCCESS' || value === 'SUCCEEDED') {
    return 'succeeded';
  }
  if (value === 'PENDING' || value === 'PROCESSING') {
    return 'pending';
  }
  return 'failed';
}
