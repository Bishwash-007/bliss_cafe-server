/**
 * Row shapes for the payment module.
 *
 * `NUMERIC` columns arrive from `pg` as strings, matching the rest of the
 * codebase (see `OrderRow`). The API returns rows in their stored snake_case
 * shape; computed results (a QR payload) are camelCase domain objects.
 */

/** Raw row of `tenant_payment_configs`. */
export interface PaymentConfigRow {
  id: string;
  tenant_id: string;
  provider: string;
  config_encrypted: string;
  is_active: boolean;
}

/** Raw row of `payments`, including the columns added in migration 015. */
export interface PaymentRow {
  id: string;
  tenant_id: string;
  order_id: string;
  provider: string;
  provider_reference: string | null;
  method: string;
  amount: string;
  status: string;
  received_by: string | null;
  created_at: Date;
  updated_at: Date;
  paid_at: Date | null;
}

/** What a provider webhook told us, normalized by the provider's controller. */
export type WebhookOutcome =
  | { readonly kind: 'succeeded'; readonly providerReference: string }
  | { readonly kind: 'failed'; readonly providerReference: string }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * The result of applying a webhook.
 *
 * `duplicate` means the payment was already in the reported terminal state, so
 * nothing changed and — importantly — no `order.paid` was published again.
 * `ignored` means the delivery was well-formed and correctly signed but does
 * not describe a settlement (for example a Stripe `payment_intent.created`).
 */
export interface WebhookResult {
  received: true;
  duplicate: boolean;
  ignored: boolean;
  payment: PaymentRow | null;
}

/** What a successful checkout hands back to the counter. */
export interface CheckoutResponse {
  payment: PaymentRow;
  qr: {
    provider: string;
    orderId: string;
    amount: number;
    format: 'url' | 'image' | 'text';
    data: string;
    expiresAt: string | null;
  };
}
