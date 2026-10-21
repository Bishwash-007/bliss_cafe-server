import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * Payment-domain failures, each a distinct class so the HTTP layer (and tests)
 * can branch on the reason without matching message text. Mirrors the staff
 * and CRM exception modules.
 */

/** No payment row with this id/reference is visible for the tenant. */
export class PaymentNotFoundException extends NotFoundException {
  constructor(reference: string) {
    super(`Payment '${reference}' was not found for this tenant`);
  }
}

/** The tenant has no active gateway configuration. */
export class PaymentProviderNotConfiguredException extends UnprocessableEntityException {
  constructor(tenantId: string) {
    super(
      `Tenant ${tenantId} has no active payment provider configured. ` +
        `Set one with PUT /payments/config/:provider before taking a payment.`,
    );
  }
}

/** More than one active provider — the factory cannot choose. */
export class AmbiguousPaymentProviderException extends ConflictException {
  constructor(tenantId: string, providers: readonly string[]) {
    super(
      `Tenant ${tenantId} has more than one active payment provider ` +
        `(${providers.join(', ')}). Activate exactly one; a checkout must ` +
        `know which gateway it is charging through.`,
    );
  }
}

/** The tenant is configured, but not for the provider named in the request. */
export class PaymentProviderNotConfiguredForException extends UnprocessableEntityException {
  constructor(tenantId: string, provider: string) {
    super(
      `Tenant ${tenantId} has no configuration for payment provider '${provider}'.`,
    );
  }
}

/** A provider name that this build does not implement. */
export class UnsupportedPaymentProviderException extends UnprocessableEntityException {
  constructor(provider: string, supported: readonly string[]) {
    super(
      `Payment provider '${provider}' is not supported. ` +
        `Supported providers: ${supported.join(', ')}.`,
    );
  }
}

/**
 * A webhook whose signature did not verify, or whose required signature header
 * is missing.
 *
 * 401 rather than 400: the request claims to come from a gateway and has not
 * proved it. The controller throws this BEFORE parsing the payload or touching
 * the database.
 */
export class InvalidWebhookSignatureException extends UnauthorizedException {
  constructor(provider: string, reason = 'signature mismatch') {
    super(`Rejected ${provider} webhook: ${reason}`);
  }
}

/**
 * A correctly signed webhook whose body this build cannot interpret.
 *
 * The signature proves the sender; it says nothing about the payload shape. A
 * 400 tells the provider the delivery will never succeed, unlike a 500 which
 * invites an infinite retry of a payload we will never understand.
 */
export class InvalidWebhookPayloadException extends BadRequestException {
  constructor(provider: string, reason: string) {
    super(`Cannot interpret ${provider} webhook: ${reason}`);
  }
}

/** A provider config that is missing a required key or has the wrong shape. */ export class PaymentConfigurationException extends BadRequestException {
  constructor(provider: string, reason: string) {
    super(
      `Invalid configuration for payment provider '${provider}': ${reason}`,
    );
  }
}

/** The encryption key is missing/malformed. Never fall back to plaintext. */
export class PaymentConfigKeyException extends InternalServerErrorException {
  constructor(reason: string) {
    super(
      `Payment configuration cannot be encrypted/decrypted: ${reason}. ` +
        `Set PAYMENT_CONFIG_ENCRYPTION_KEY to 32 bytes (64 hex characters).`,
    );
  }
}

/** A stored config could not be decrypted (wrong key or tampered ciphertext). */
export class PaymentConfigDecryptionException extends InternalServerErrorException {
  constructor(provider: string) {
    super(
      `Stored configuration for payment provider '${provider}' could not be ` +
        `decrypted. This usually means PAYMENT_CONFIG_ENCRYPTION_KEY changed.`,
    );
  }
}

/**
 * The gateway refused or failed a request.
 *
 * 502: the failure is upstream. The message carries the provider and HTTP
 * status only — never the request's authorization header or the configured
 * secret.
 */
export class PaymentProviderRequestException extends BadGatewayException {
  constructor(provider: string, status: number, detail: string) {
    super(
      `Payment provider '${provider}' request failed with HTTP ${status}: ${detail}`,
    );
  }
}

/** A refund was requested for a payment that has not succeeded (or is gone). */ export class PaymentNotRefundableException extends ConflictException {
  constructor(paymentId: string, status: string) {
    super(
      `Payment ${paymentId} is '${status}' and cannot be refunded. ` +
        `Only a 'succeeded' payment can be refunded.`,
    );
  }
}

/** A checkout was attempted for an order that is already settled. */
export class OrderAlreadyPaidException extends ConflictException {
  constructor(orderId: string) {
    super(
      `Order ${orderId} is already paid; a second checkout would double-charge.`,
    );
  }
}

/** An amount that is not a positive money value. */
export class InvalidPaymentAmountException extends BadRequestException {
  constructor(amount: number) {
    super(`Payment amount must be a positive finite number, got ${amount}`);
  }
}

/**
 * The gateway returned a transaction reference that is already recorded.
 *
 * The unique index `idx_payments_provider_reference` is the authority; this
 * turns its 23505 into a 409 instead of a 500. It means either the same
 * checkout was submitted twice or the gateway reused a reference, and in both
 * cases creating a second row would make webhook settlement ambiguous.
 */
export class PaymentReferenceConflictException extends ConflictException {
  constructor(provider: string, reference: string) {
    super(
      `A payment for ${provider} reference '${reference}' already exists. ` +
        `If this checkout was retried, re-use the existing payment instead.`,
    );
  }
}
