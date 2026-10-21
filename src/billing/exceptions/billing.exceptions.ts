import {
  BadRequestException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { SubscriptionAction } from '../state/subscription-state';

/**
 * Billing-domain failures, each a distinct class so callers and tests can
 * branch on the reason without matching message text.
 */

/** No subscription row exists for the tenant. */
export class SubscriptionNotFoundException extends NotFoundException {
  constructor(tenantId: string) {
    super(
      `Tenant ${tenantId} has no subscription. Complete onboarding with a plan ` +
        `before using billing.`,
    );
  }
}

/** A status value outside the four the state machine understands. */
export class UnknownSubscriptionStatusException extends BadRequestException {
  constructor(status: string) {
    super(`'${status}' is not a recognised subscription status`);
  }
}

/**
 * The core State-pattern rejection: the current status does not permit this
 * action. The message names what IS allowed, because that is the first thing a
 * client developer needs after the refusal.
 */
export class InvalidSubscriptionActionException extends BadRequestException {
  constructor(
    readonly action: string,
    readonly currentStatus: string,
    readonly allowed: readonly SubscriptionAction[],
  ) {
    super(
      `A subscription in status '${currentStatus}' cannot perform '${action}'. ` +
        (allowed.length > 0
          ? `Allowed actions: ${allowed.join(', ')}.`
          : `'${currentStatus}' is a terminal state.`),
    );
  }
}

/** The target plan does not exist. */
export class PlanNotFoundException extends NotFoundException {
  constructor(planId: string) {
    super(`Plan '${planId}' does not exist`);
  }
}

/**
 * An upgrade asked for a plan that is not more expensive (or a downgrade asked
 * for one that is not cheaper). Direction is derived from the plans' prices so
 * a client cannot label a downgrade as an upgrade to avoid the credit rule.
 */
export class InvalidPlanChangeException extends BadRequestException {
  constructor(
    action: 'upgrade' | 'downgrade',
    current: string,
    target: string,
  ) {
    super(
      `Cannot '${action}' from plan '${current}' to '${target}': the target ` +
        `plan is not ${action === 'upgrade' ? 'more' : 'less'} expensive.`,
    );
  }
}

/** An upgrade/downgrade request did not name a target plan. */
export class MissingPlanChangeTargetException extends BadRequestException {
  constructor(action: string) {
    super(`Action '${action}' requires a 'planId'`);
  }
}

/**
 * The gateway did not settle the charge.
 *
 * 402 rather than 500: the provider may have declined the card, or returned a
 * still-pending state. The subscription's own status (not this exception) is
 * the durable record of what happened; the renewal path commits `past_due`
 * before throwing.
 */
export class SubscriptionChargeFailedException extends HttpException {
  constructor(
    readonly tenantId: string,
    readonly reason: string,
  ) {
    super(
      `Billing charge for tenant ${tenantId} did not succeed: ${reason}`,
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/** A provider or plan configuration problem that prevented a charge. */
export class BillingConfigurationException extends BadRequestException {
  constructor(reason: string) {
    super(`Billing is not configured correctly: ${reason}`);
  }
}
