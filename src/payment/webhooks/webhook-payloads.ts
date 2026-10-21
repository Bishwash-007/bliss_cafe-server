import { InvalidWebhookPayloadException } from '../exceptions/payment.exceptions';
import type { PaymentProviderName } from '../providers/payment-provider.types';
import { objectField, stringField } from '../providers/provider-support';
import type { WebhookOutcome } from '../payment.types';

/**
 * Turns each gateway's webhook envelope into the module's `WebhookOutcome`.
 *
 * This is the counterpart of the adapters: the provider classes normalize
 * OUTBOUND calls, these functions normalize INBOUND events. They live beside
 * the provider-specific controllers because each one only makes sense for its
 * own gateway — the shared `WebhookService` stays provider-agnostic.
 *
 * All three parsers are pure: no database access, no state. They run only
 * AFTER the signature has been verified.
 */

export function parseStripeWebhook(raw: string): WebhookOutcome {
  const body = parseObject('stripe', raw);
  const type = stringField(body, 'type');
  const data = objectField(body, 'data');
  const object = data ? objectField(data, 'object') : null;
  const reference = object ? stringField(object, 'id') : null;

  if (!type) {
    throw new InvalidWebhookPayloadException('stripe', 'missing `type`');
  }
  if (!reference) {
    throw new InvalidWebhookPayloadException(
      'stripe',
      'missing `data.object.id`',
    );
  }

  if (
    type === 'payment_intent.succeeded' ||
    (object && stringField(object, 'status') === 'succeeded')
  ) {
    return { kind: 'succeeded', providerReference: reference };
  }

  if (
    type === 'payment_intent.payment_failed' ||
    type === 'payment_intent.canceled'
  ) {
    return { kind: 'failed', providerReference: reference };
  }

  // payment_intent.created, .processing, charge.updated, … are real events that
  // this module has nothing to do with. Acknowledging them (200) stops Stripe
  // retrying, while still recording that they were deliberately ignored.
  return { kind: 'ignored', reason: type };
}

export function parseEsewaWebhook(raw: string): WebhookOutcome {
  const body = parseObject('esewa', raw);
  // Some eSewa products wrap the payload in `{ data: ... }`; older ones do not.
  const data = objectField(body, 'data') ?? body;

  const reference =
    stringField(data, 'transaction_uuid') ??
    stringField(data, 'transactionUuid') ??
    stringField(data, 'transaction_code');

  if (!reference) {
    throw new InvalidWebhookPayloadException(
      'esewa',
      'missing `transaction_uuid`',
    );
  }

  const status = (
    stringField(data, 'status') ?? stringField(data, 'transaction_status')
  )?.toUpperCase();

  if (status === 'COMPLETE' || status === 'SUCCESS' || status === 'SUCCEEDED') {
    return { kind: 'succeeded', providerReference: reference };
  }
  if (status === 'FAILED' || status === 'CANCELED' || status === 'CANCELLED') {
    return { kind: 'failed', providerReference: reference };
  }

  return { kind: 'ignored', reason: status ?? 'no status' };
}

export function parseRazorpayWebhook(raw: string): WebhookOutcome {
  const body = parseObject('razorpay', raw);
  const event = stringField(body, 'event');
  if (!event) {
    throw new InvalidWebhookPayloadException('razorpay', 'missing `event`');
  }

  const payload = objectField(body, 'payload');
  const qr = payload
    ? objectField(objectField(payload, 'qr_code') ?? {}, 'entity')
    : null;
  const payment = payload
    ? objectField(objectField(payload, 'payment') ?? {}, 'entity')
    : null;

  // A QR settlement names the QR it paid. A direct payment capture names the
  // gateway order, which is what `charge` stored as its reference.
  const reference =
    (qr ? stringField(qr, 'id') : null) ??
    (payment ? stringField(payment, 'order_id') : null) ??
    (payment ? stringField(payment, 'id') : null);

  if (!reference) {
    throw new InvalidWebhookPayloadException(
      'razorpay',
      'missing `payload.qr_code.entity.id` / `payload.payment.entity.order_id`',
    );
  }

  const paymentStatus = payment ? stringField(payment, 'status') : null;

  if (
    event === 'qr_code.credited' ||
    event === 'payment.captured' ||
    paymentStatus === 'captured'
  ) {
    return { kind: 'succeeded', providerReference: reference };
  }

  if (event === 'payment.failed' || event === 'qr_code.expired') {
    return { kind: 'failed', providerReference: reference };
  }

  return { kind: 'ignored', reason: event };
}

function parseObject(
  provider: PaymentProviderName,
  raw: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new InvalidWebhookPayloadException(
      provider,
      'body is not valid JSON',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidWebhookPayloadException(provider, 'body is not an object');
  }
  return parsed as Record<string, unknown>;
}
