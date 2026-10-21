import { PaymentConfigCipher } from './payment-config.cipher';
import {
  PaymentConfigDecryptionException,
  PaymentConfigKeyException,
} from '../exceptions/payment.exceptions';

const HEX_KEY = '0123456789abcdef'.repeat(4);
const BASE64_KEY = Buffer.alloc(32, 7).toString('base64');
const RAW_KEY = 'k'.repeat(32);

describe('PaymentConfigCipher', () => {
  const cipher = new PaymentConfigCipher();
  let previousKey: string | undefined;

  beforeEach(() => {
    previousKey = process.env.PAYMENT_CONFIG_ENCRYPTION_KEY;
    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = HEX_KEY;
  });

  afterEach(() => {
    if (previousKey === undefined) {
      delete process.env.PAYMENT_CONFIG_ENCRYPTION_KEY;
    } else {
      process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = previousKey;
    }
  });

  it('round-trips a provider config', () => {
    const plaintext = JSON.stringify({
      secretKey: 'sk_live_123',
      webhookSecret: 'whsec_456',
    });

    const encrypted = cipher.encrypt(plaintext);

    expect(encrypted).not.toContain('sk_live_123');
    expect(encrypted.startsWith('v1:')).toBe(true);
    expect(cipher.decrypt(encrypted, 'stripe')).toBe(plaintext);
  });

  it('uses a fresh IV so equal secrets do not produce equal ciphertext', () => {
    const plaintext = '{"secretKey":"same"}';

    expect(cipher.encrypt(plaintext)).not.toBe(cipher.encrypt(plaintext));
  });

  it('rejects tampered ciphertext instead of returning garbage', () => {
    const encrypted = cipher.encrypt('{"secretKey":"sk"}');
    const parts = encrypted.split(':');
    const data = Buffer.from(parts[3], 'base64url');
    data[0] ^= 0xff;
    parts[3] = data.toString('base64url');

    expect(() => cipher.decrypt(parts.join(':'), 'stripe')).toThrow(
      PaymentConfigDecryptionException,
    );
  });

  it('rejects a ciphertext encrypted with a different key', () => {
    const encrypted = cipher.encrypt('{"secretKey":"sk"}');
    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = 'f'.repeat(64);

    expect(() => cipher.decrypt(encrypted, 'stripe')).toThrow(
      PaymentConfigDecryptionException,
    );
  });

  it('rejects an unknown envelope version', () => {
    expect(() => cipher.decrypt('v2:a:b:c', 'stripe')).toThrow(
      PaymentConfigDecryptionException,
    );
  });

  it('accepts base64 and raw 32-byte keys', () => {
    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = BASE64_KEY;
    const fromBase64 = cipher.encrypt('base64');
    expect(cipher.decrypt(fromBase64, 'stripe')).toBe('base64');

    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = RAW_KEY;
    const fromRaw = cipher.encrypt('raw');
    expect(cipher.decrypt(fromRaw, 'stripe')).toBe('raw');
  });

  it('refuses to encrypt without a key rather than storing plaintext', () => {
    delete process.env.PAYMENT_CONFIG_ENCRYPTION_KEY;

    expect(() => cipher.encrypt('{}')).toThrow(PaymentConfigKeyException);
  });

  it('refuses a malformed key', () => {
    process.env.PAYMENT_CONFIG_ENCRYPTION_KEY = 'too-short';

    expect(() => cipher.encrypt('{}')).toThrow(PaymentConfigKeyException);
  });
});
