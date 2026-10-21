import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  InvalidPaymentAmountException,
  PaymentConfigurationException,
  PaymentProviderRequestException,
} from '../exceptions/payment.exceptions';
import type { PaymentHttpResponse } from './payment-http';
import type { PaymentProviderName } from './payment-provider.types';

/**
 * Shared plumbing for the gateway adapters.
 *
 * This file is where "three REST APIs shaped differently" is reduced to a small
 * number of common operations: pull a config string, decide whether a response
 * was successful, read a case-insensitive header, and compare an HMAC in
 * constant time. The adapters keep only what is genuinely gateway-specific.
 */

/** A required non-empty string from a tenant's decrypted config. */
export function requireConfigString(
  provider: PaymentProviderName,
  config: Record<string, unknown>,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PaymentConfigurationException(
      provider,
      `'${key}' is required and must be a non-empty string`,
    );
  }
  return value.trim();
}

/** An optional non-empty string from a tenant's decrypted config. */
export function optionalConfigString(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

/** A required config object (the decrypted JSON must itself be an object). */
export function requireConfigObject(
  provider: PaymentProviderName,
  config: unknown,
): Record<string, unknown> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    throw new PaymentConfigurationException(
      provider,
      'configuration must be a JSON object',
    );
  }
  return config as Record<string, unknown>;
}

/** Asserts a positive money amount before it is handed to a gateway. */
export function assertPositiveAmount(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new InvalidPaymentAmountException(amount);
  }
}

/** Asserts a 2xx response, otherwise raises a sanitized 502. */
export function ensureSuccess(
  provider: PaymentProviderName,
  response: PaymentHttpResponse,
): void {
  if (response.status >= 200 && response.status < 300) {
    return;
  }

  const detail =
    typeof response.body === 'string'
      ? response.body
      : JSON.stringify(response.body ?? null);
  throw new PaymentProviderRequestException(
    provider,
    response.status,
    (detail ?? '').slice(0, 300),
  );
}

/** Treats a gateway's JSON body as an object, or fails. */
export function responseObject(
  provider: PaymentProviderName,
  response: PaymentHttpResponse,
): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null) {
    throw new PaymentProviderRequestException(
      provider,
      response.status,
      'expected a JSON object in the response',
    );
  }
  return response.body as Record<string, unknown>;
}

/** A header value by case-insensitive name. */
export function headerValue(
  headers: Record<string, string | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) {
      return value;
    }
  }
  return undefined;
}

/** HMAC-SHA256 as lowercase hex. */
export function hmacHex(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** HMAC-SHA256 as base64 (eSewa signs request fields this way). */
export function hmacBase64(secret: string, payload: string | Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64');
}

/**
 * Constant-time comparison of two hex signatures.
 *
 * Length is compared first because `timingSafeEqual` throws on different-length
 * buffers; the length itself is not secret (it is fixed by SHA-256).
 */
export function signaturesMatch(
  expectedHex: string,
  providedHex: string,
): boolean {
  if (typeof providedHex !== 'string') {
    return false;
  }
  const expected = Buffer.from(expectedHex, 'utf8');
  const provided = Buffer.from(providedHex.trim().toLowerCase(), 'utf8');
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(expected, provided);
}

/**
 * Reads a string field from a gateway object without trusting its type.
 */
export function stringField(
  source: Record<string, unknown>,
  key: string,
): string | null {
  const value = source[key];
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

/** Reads a number field, accepting a numeric string. */
export function numberField(
  source: Record<string, unknown>,
  key: string,
): number | null {
  const value = source[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Reads a nested object field. */
export function objectField(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | null {
  const value = source[key];
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}
