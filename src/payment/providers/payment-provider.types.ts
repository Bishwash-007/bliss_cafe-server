/**
 * A payment provider's name as stored in `tenant_payment_configs.provider` and
 * `payments.provider`.
 *
 * This is the closed vocabulary the database column documents. Adding a
 * provider means adding a name here, a class in `providers/`, and one entry in
 * `PaymentProviderFactory` — nowhere else branches on the value.
 */
export const PAYMENT_PROVIDERS = ['stripe', 'esewa', 'razorpay'] as const;

export type PaymentProviderName = (typeof PAYMENT_PROVIDERS)[number];

export function isPaymentProviderName(
  value: unknown,
): value is PaymentProviderName {
  return (
    typeof value === 'string' &&
    (PAYMENT_PROVIDERS as readonly string[]).includes(value)
  );
}

/** The provider-neutral outcomes the rest of the system cares about. */
export type PaymentOutcome = 'pending' | 'succeeded' | 'failed';

/**
 * The common result of a charge attempt.
 *
 * Deliberately narrow: no `client_secret`, no `next_action`, no raw SDK
 * response. Those are gateway-shaped, useful only to the adapter, and leaking
 * them would make every caller handle three shapes. A caller that needs more
 * detail re-reads the persisted `payments` row.
 */
export interface PaymentResult {
  readonly provider: PaymentProviderName;
  /** The gateway's transaction/order id, persisted as `provider_reference`. */
  readonly providerReference: string;
  readonly status: PaymentOutcome;
  /** The amount charged, as money. */
  readonly amount: number;
}

/** The common result of a refund. */
export interface RefundResult {
  readonly provider: PaymentProviderName;
  /** The transaction being refunded (the payment's `provider_reference`). */
  readonly providerReference: string;
  /** The gateway's refund id. */
  readonly refundReference: string;
  /**
   * `pending` is real: Stripe and Razorpay can accept a refund and settle it
   * later. Reporting a pending refund as `failed` would invite a second refund
   * for money that is already on its way back.
   */
  readonly status: 'succeeded' | 'pending' | 'failed';
  /** Amount refunded, when the gateway reports it. */
  readonly amount: number | null;
}

/**
 * What a checkout client renders as a QR code.
 *
 * The shape is identical for every provider even though the source differs:
 * Stripe returns a hosted-checkout URL (encode it as a QR), eSewa returns a
 * native QR image/string, Razorpay returns a QR image URL. `format` says how
 * to read `data`; `data` is always a string so a client can put it in an
 * `<img>`, a `QRCode` component, or a redirect without branching on provider.
 */
export interface QrPayload {
  readonly provider: PaymentProviderName;
  readonly orderId: string;
  /** The amount the QR is for, as money (not minor units). */
  readonly amount: number;
  readonly format: 'url' | 'image' | 'text';
  /** The URL, image URL, or QR string to encode/show. */
  readonly data: string;
  /** The gateway reference to persist on the pending `payments` row. */
  readonly providerReference: string;
  /** ISO-8601 instant after which the QR should not be shown, when known. */
  readonly expiresAt: string | null;
}

/** A provider's opaque configuration, as stored (encrypted) in the database. */
export type ProviderConfig = Record<string, unknown>;

/**
 * The contract every gateway adapter implements.
 *
 * The same four methods, the same result shapes, regardless of what the
 * underlying SDK returns. `PaymentProviderFactory` is the only code that
 * constructs a concrete implementation; every caller sees this interface.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;

  /** Charges `amount` for `orderId`. */
  charge(amount: number, orderId: string): Promise<PaymentResult>;

  /**
   * Fully refunds a gateway transaction.
   *
   * `paymentId` is the gateway's transaction reference (the value stored in
   * `payments.provider_reference`), not the internal `payments.id`. The adapter
   * never needs to know about our database.
   */
  refund(paymentId: string): Promise<RefundResult>;

  /** Creates a dynamic QR / hosted checkout for `orderId` at `amount`. */
  generateQr(orderId: string, amount: number): Promise<QrPayload>;

  /**
   * True when `payload` really was signed by the gateway.
   *
   * Implementations must compare signatures in constant time and must not
   * mutate anything. The caller verifies BEFORE parsing or touching the
   * database, so an invalid delivery changes no state.
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    headers: Record<string, string | undefined>,
  ): boolean;
}
