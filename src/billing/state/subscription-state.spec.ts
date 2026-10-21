import { UnknownSubscriptionStatusException } from '../exceptions/billing.exceptions';
import { ActiveState } from './active.state';
import { CancelledState } from './cancelled.state';
import { PastDueState } from './past-due.state';
import {
  SUBSCRIPTION_STATUSES,
  type SubscriptionStatus,
} from './subscription-state';
import { subscriptionStateFor } from './subscription-state.factory';
import { TrialingState } from './trialing.state';

const EXPECTED_ACTIONS: Record<SubscriptionStatus, readonly string[]> = {
  trialing: ['upgrade', 'downgrade', 'renew', 'cancel'],
  active: ['upgrade', 'downgrade', 'renew', 'cancel'],
  past_due: ['retry_payment', 'cancel'],
  cancelled: [],
};

describe('subscription state machine', () => {
  describe('the registry', () => {
    it('resolves every status to a matching concrete class', () => {
      expect(subscriptionStateFor('trialing')).toBeInstanceOf(TrialingState);
      expect(subscriptionStateFor('active')).toBeInstanceOf(ActiveState);
      expect(subscriptionStateFor('past_due')).toBeInstanceOf(PastDueState);
      expect(subscriptionStateFor('cancelled')).toBeInstanceOf(CancelledState);
    });

    it('rejects an unknown stored status instead of defaulting', () => {
      expect(() => subscriptionStateFor('refunded')).toThrow(
        UnknownSubscriptionStatusException,
      );
      expect(() => subscriptionStateFor('ACTIVE')).toThrow(
        UnknownSubscriptionStatusException,
      );
    });
  });

  it.each(SUBSCRIPTION_STATUSES)(
    '%s exposes exactly the documented actions',
    (status) => {
      expect(subscriptionStateFor(status).allowedActions()).toEqual(
        EXPECTED_ACTIONS[status],
      );
    },
  );

  describe('the acceptance rules', () => {
    it('refuses an upgrade while past_due', () => {
      const state = subscriptionStateFor('past_due');

      expect(state.allowedActions()).toEqual(['retry_payment', 'cancel']);
      expect(state.allowedActions()).not.toContain('upgrade');
      expect(state.allowedActions()).not.toContain('downgrade');
      expect(state.can('upgrade')).toBe(false);
      expect(state.can('retry_payment')).toBe(true);
    });

    it('allows a plan change and renewal only while current', () => {
      for (const status of ['trialing', 'active'] as const) {
        const state = subscriptionStateFor(status);
        expect(state.can('upgrade')).toBe(true);
        expect(state.can('downgrade')).toBe(true);
        expect(state.can('renew')).toBe(true);
        expect(state.can('cancel')).toBe(true);
        expect(state.can('retry_payment')).toBe(false);
      }
    });

    it('treats cancelled as terminal', () => {
      const state = subscriptionStateFor('cancelled');
      expect(state.allowedActions()).toEqual([]);
      for (const action of [
        'upgrade',
        'downgrade',
        'renew',
        'retry_payment',
        'cancel',
      ]) {
        expect(state.can(action)).toBe(false);
      }
    });

    it('returns a copy so a caller cannot mutate the transition table', () => {
      const state = subscriptionStateFor('active');
      state.allowedActions().push('retry_payment');
      expect(state.allowedActions()).not.toContain('retry_payment');
    });
  });
});
