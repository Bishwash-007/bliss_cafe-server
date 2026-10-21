import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  PaymentConfigDecryptionException,
  PaymentConfigKeyException,
} from '../exceptions/payment.exceptions';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Encrypts tenant gateway credentials before they reach
 * `tenant_payment_configs.config_encrypted`.
 *
 * ## Why AES-256-GCM
 *
 * The column stores API secret keys and webhook signing secrets — the most
 * valuable rows in the database. GCM is authenticated: a modified ciphertext or
 * a wrong key fails to decrypt instead of yielding garbage that might be sent
 * to a gateway as a credential. A per-encryption random IV means two tenants
 * with the same Stripe key do not produce the same ciphertext.
 *
 * ## Storage format
 *
 * `v1:<iv b64url>:<tag b64url>:<ciphertext b64url>`
 *
 * The version prefix is what lets a future key rotation or algorithm change
 * read old rows instead of silently failing every configured tenant.
 *
 * ## The key
 *
 * `PAYMENT_CONFIG_ENCRYPTION_KEY`, exactly 32 bytes, accepted as 64 hex
 * characters, base64 for 32 bytes, or 32 raw characters. This class is read
 * lazily rather than at boot: a deployment that does not use payments can still
 * start, but the first attempt to configure or read a provider fails loudly.
 * There is deliberately NO development fallback — a fallback key would make
 * every local database decrypt with a key that is in the source tree.
 */
@Injectable()
export class PaymentConfigCipher {
  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key(), iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      ciphertext.toString('base64url'),
    ].join(':');
  }

  /**
   * Decrypts a stored config.
   *
   * `provider` is only used in the error message; the ciphertext carries no
   * provider identity. A failure is a 500, not a 400: the request is fine, the
   * server's key or stored value is not.
   */
  decrypt(ciphertext: string, provider: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== VERSION) {
      throw new PaymentConfigDecryptionException(provider);
    }

    const [, ivPart, tagPart, dataPart] = parts;
    const iv = Buffer.from(ivPart, 'base64url');
    const tag = Buffer.from(tagPart, 'base64url');

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new PaymentConfigDecryptionException(provider);
    }

    try {
      const decipher = createDecipheriv(ALGORITHM, this.key(), iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([
        decipher.update(Buffer.from(dataPart, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      // Deliberately loses the underlying error: a crypto failure message can
      // distinguish "wrong key" from "bad ciphertext", which is more than a
      // caller needs. The exception text names the likely cause.
      throw new PaymentConfigDecryptionException(provider);
    }
  }

  /** Resolves and validates the key. Exposed for a direct key-material check. */
  private key(): Buffer {
    const raw = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY?.trim();
    if (!raw) {
      throw new PaymentConfigKeyException(
        'PAYMENT_CONFIG_ENCRYPTION_KEY is not set',
      );
    }

    if (/^[0-9a-f]{64}$/i.test(raw)) {
      return Buffer.from(raw, 'hex');
    }

    const base64 = Buffer.from(raw, 'base64');
    if (base64.length === KEY_BYTES) {
      return base64;
    }

    const rawBytes = Buffer.from(raw, 'utf8');
    if (rawBytes.length === KEY_BYTES) {
      return rawBytes;
    }

    throw new PaymentConfigKeyException(
      `PAYMENT_CONFIG_ENCRYPTION_KEY must be ${KEY_BYTES} bytes ` +
        `(${KEY_BYTES * 2} hex characters, base64 for ${KEY_BYTES} bytes, ` +
        `or ${KEY_BYTES} raw characters); got ${raw.length} characters`,
    );
  }
}
