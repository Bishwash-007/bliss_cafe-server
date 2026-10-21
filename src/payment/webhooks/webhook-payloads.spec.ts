import { InvalidWebhookPayloadException } from '../exceptions/payment.exceptions';
import {
  parseEsewaWebhook,
  parseRazorpayWebhook,
  parseStripeWebhook,
} from './webhook-payloads';

describe('webhook payload parsers', () => {
  describe('Stripe', () => {
    it('reads a succeeded Payment Intent', () => {
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1', status: 'succeeded' } },
      });

      expect(parseStripeWebhook(raw)).toEqual({
        kind: 'succeeded',
        providerReference: 'pi_1',
      });
    });

    it('reads a failed Payment Intent', () => {
      const raw = JSON.stringify({
        type: 'payment_intent.payment_failed',
        data: { object: { id: 'pi_2', status: 'requires_payment_method' } },
      });

      expect(parseStripeWebhook(raw)).toEqual({
        kind: 'failed',
        providerReference: 'pi_2',
      });
    });

    it('ignores unrelated events instead of failing them', () => {
      const raw = JSON.stringify({
        type: 'payment_intent.created',
        data: { object: { id: 'pi_3' } },
      });

      expect(parseStripeWebhook(raw)).toEqual({
        kind: 'ignored',
        reason: 'payment_intent.created',
      });
    });

    it('rejects a body with no payment reference', () => {
      const raw = JSON.stringify({
        type: 'payment_intent.succeeded',
        data: { object: {} },
      });

      expect(() => parseStripeWebhook(raw)).toThrow(
        InvalidWebhookPayloadException,
      );
    });
  });

  describe('eSewa', () => {
    it('reads a completed transaction', () => {
      const raw = JSON.stringify({
        transaction_uuid: 'esewa_ref_1',
        status: 'COMPLETE',
      });

      expect(parseEsewaWebhook(raw)).toEqual({
        kind: 'succeeded',
        providerReference: 'esewa_ref_1',
      });
    });

    it('reads a wrapped payload', () => {
      const raw = JSON.stringify({
        data: { transactionUuid: 'esewa_ref_2', status: 'FAILED' },
      });

      expect(parseEsewaWebhook(raw)).toEqual({
        kind: 'failed',
        providerReference: 'esewa_ref_2',
      });
    });

    it('ignores an unknown status', () => {
      const raw = JSON.stringify({
        transaction_uuid: 'esewa_ref_3',
        status: 'PENDING',
      });

      expect(parseEsewaWebhook(raw)).toEqual({
        kind: 'ignored',
        reason: 'PENDING',
      });
    });

    it('rejects invalid JSON', () => {
      expect(() => parseEsewaWebhook('not json')).toThrow(
        InvalidWebhookPayloadException,
      );
    });
  });

  describe('Razorpay', () => {
    it('reads a credited UPI QR', () => {
      const raw = JSON.stringify({
        event: 'qr_code.credited',
        payload: {
          qr_code: { entity: { id: 'qr_1' } },
          payment: { entity: { id: 'pay_1', status: 'captured' } },
        },
      });

      expect(parseRazorpayWebhook(raw)).toEqual({
        kind: 'succeeded',
        providerReference: 'qr_1',
      });
    });

    it('reads a captured direct payment by gateway order id', () => {
      const raw = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: { entity: { id: 'pay_2', order_id: 'order_1' } },
        },
      });

      expect(parseRazorpayWebhook(raw)).toEqual({
        kind: 'succeeded',
        providerReference: 'order_1',
      });
    });

    it('reads a failed payment', () => {
      const raw = JSON.stringify({
        event: 'payment.failed',
        payload: {
          payment: { entity: { id: 'pay_3', order_id: 'order_3' } },
        },
      });

      expect(parseRazorpayWebhook(raw)).toEqual({
        kind: 'failed',
        providerReference: 'order_3',
      });
    });

    it('ignores unrelated events', () => {
      const raw = JSON.stringify({
        event: 'refund.created',
        payload: { payment: { entity: { id: 'pay_4' } } },
      });

      expect(parseRazorpayWebhook(raw)).toEqual({
        kind: 'ignored',
        reason: 'refund.created',
      });
    });

    it('rejects an event with no usable reference', () => {
      const raw = JSON.stringify({ event: 'payment.failed', payload: {} });

      expect(() => parseRazorpayWebhook(raw)).toThrow(
        InvalidWebhookPayloadException,
      );
    });
  });
});
