import { UnknownOrderStatusException } from '../exceptions/order.exceptions';
import { AwaitingPaymentState } from './awaiting-payment.state';
import { CancelledState } from './cancelled.state';
import { CompletedState } from './completed.state';
import { ConfirmedState } from './confirmed.state';
import { ORDER_STATUSES, type OrderStatus } from './order-state';
import { orderStateFor } from './order-state.factory';
import { PaidState } from './paid.state';
import { PlacedState } from './placed.state';
import { PreparingState } from './preparing.state';
import { ReadyState } from './ready.state';
import { ServedState } from './served.state';

/**
 * The transition table, written out as data.
 *
 * This is the specification the whole pattern exists to satisfy: every LEGAL
 * edge, and — by the `it.each` over the full 9x9 matrix below — the guarantee
 * that every other pair is illegal. Keeping the expected table beside the state
 * classes is what turns "the code looks right" into a test that fails the
 * moment someone adds an edge they should not have.
 */
const LEGAL: ReadonlyArray<readonly [OrderStatus, OrderStatus]> = [
  ['placed', 'confirmed'],
  ['placed', 'cancelled'],
  ['confirmed', 'preparing'],
  ['confirmed', 'cancelled'],
  ['preparing', 'ready'],
  ['preparing', 'cancelled'],
  ['ready', 'served'],
  ['ready', 'cancelled'],
  ['served', 'awaiting_payment'],
  ['served', 'cancelled'],
  ['awaiting_payment', 'paid'],
  ['awaiting_payment', 'cancelled'],
  ['paid', 'completed'],
];

const LEGAL_SET = new Set(LEGAL.map(([from, to]) => `${from}->${to}`));

describe('order state machine', () => {
  describe('the registry', () => {
    it('resolves every declared status to a state of that status', () => {
      for (const status of ORDER_STATUSES) {
        expect(orderStateFor(status).status).toBe(status);
      }
    });

    it('resolves to the matching concrete class for each status', () => {
      expect(orderStateFor('placed')).toBeInstanceOf(PlacedState);
      expect(orderStateFor('confirmed')).toBeInstanceOf(ConfirmedState);
      expect(orderStateFor('preparing')).toBeInstanceOf(PreparingState);
      expect(orderStateFor('ready')).toBeInstanceOf(ReadyState);
      expect(orderStateFor('served')).toBeInstanceOf(ServedState);
      expect(orderStateFor('awaiting_payment')).toBeInstanceOf(
        AwaitingPaymentState,
      );
      expect(orderStateFor('paid')).toBeInstanceOf(PaidState);
      expect(orderStateFor('completed')).toBeInstanceOf(CompletedState);
      expect(orderStateFor('cancelled')).toBeInstanceOf(CancelledState);
    });

    it('rejects a status outside the known set instead of defaulting', () => {
      expect(() => orderStateFor('refunded')).toThrow(
        UnknownOrderStatusException,
      );
      expect(() => orderStateFor('')).toThrow(UnknownOrderStatusException);
      expect(() => orderStateFor('PLACED')).toThrow(
        UnknownOrderStatusException,
      );
    });

    it('is case-sensitive, so a row cannot be matched loosely', () => {
      // A silently case-insensitive lookup would let `Ready` resolve to
      // `ready` while the stored value stayed `ready` — the transition would
      // then be written against a status the row never had.
      expect(() => orderStateFor('Ready')).toThrow(UnknownOrderStatusException);
    });
  });

  describe('allowedTransitions', () => {
    it.each(LEGAL)('allows %s -> %s', (from, to) => {
      expect(orderStateFor(from).allowedTransitions()).toContain(to);
      expect(orderStateFor(from).canTransitionTo(to)).toBe(true);
    });

    // The matrix: 9 statuses x 9 statuses. Anything not in LEGAL must be absent.
    it.each(
      ORDER_STATUSES.flatMap((from) =>
        ORDER_STATUSES.map((to) => [from, to] as const),
      ),
    )('%s -> %s is %s', (from, to) => {
      const allowed = orderStateFor(from).allowedTransitions();
      const shouldBeAllowed = LEGAL_SET.has(`${from}->${to}`);
      if (shouldBeAllowed) {
        expect(allowed).toContain(to);
      } else {
        expect(allowed).not.toContain(to);
        expect(orderStateFor(from).canTransitionTo(to)).toBe(false);
      }
    });

    it('refuses to go backwards: served -> placed is impossible', () => {
      // The case the module brief calls out by name.
      expect(orderStateFor('served').canTransitionTo('placed')).toBe(false);
    });

    it('refuses to skip the happy path (placed -> ready is not an edge)', () => {
      expect(orderStateFor('placed').canTransitionTo('ready')).toBe(false);
      expect(orderStateFor('confirmed').canTransitionTo('served')).toBe(false);
      expect(orderStateFor('preparing').canTransitionTo('paid')).toBe(false);
    });

    it('refuses self-transitions (an order never re-enters its own status)', () => {
      for (const status of ORDER_STATUSES) {
        expect(orderStateFor(status).canTransitionTo(status)).toBe(false);
      }
    });

    it('refuses to cancel once the money has moved', () => {
      // Cancelling a paid order would be a refund, and a refund must leave an
      // auditable record rather than erase the sale.
      expect(orderStateFor('paid').canTransitionTo('cancelled')).toBe(false);
    });
  });

  describe('terminal states', () => {
    it.each(['completed', 'cancelled'] as const)(
      '%s has no outgoing edges',
      (status) => {
        expect(orderStateFor(status).isTerminal()).toBe(true);
        expect(orderStateFor(status).allowedTransitions()).toEqual([]);
      },
    );

    it.each(
      ORDER_STATUSES.filter((s) => s !== 'completed' && s !== 'cancelled'),
    )('%s is not terminal', (status) => {
      expect(orderStateFor(status).isTerminal()).toBe(false);
    });
  });

  describe('immutability', () => {
    it('hands out a copy, so a caller cannot rewrite the table', () => {
      const state = orderStateFor('placed');
      state.allowedTransitions().push('paid');
      expect(orderStateFor('placed').allowedTransitions()).toEqual([
        'confirmed',
        'cancelled',
      ]);
    });

    it('returns the same instance for the same status (states are stateless)', () => {
      expect(orderStateFor('ready')).toBe(orderStateFor('ready'));
    });
  });
});
