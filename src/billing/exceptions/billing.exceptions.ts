import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { BillingPlan } from '../billing.types';
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

/**
 * A downgrade that the tenant's own usage does not fit into.
 *
 * A plan's `max_branches`/`max_staff` are ceilings, and a ceiling the tenant
 * is already above is not a ceiling: downgrading to it would keep every
 * resource of the plan the tenant just left. The tenant has to reduce its
 * footprint first, or move to a plan that fits.
 */
export class PlanDowngradeExceedsLimitsException extends ConflictException {
  constructor(
    readonly usage: { branches: number; staff: number },
    readonly plan: BillingPlan,
  ) {
    super(
      `Cannot downgrade to plan '${plan.id}': this organisation has ` +
        `${usage.branches} active branch(es) and ${usage.staff} staff member(s), ` +
        `but the plan allows ${plan.maxBranches} and ${plan.maxStaff}.`,
    );
  }
}

/** A provider or plan configuration problem that prevented a charge. */
export class BillingConfigurationException extends BadRequestException {
  constructor(reason: string) {
    super(`Billing is not configured correctly: ${reason}`);
  }
}

/**
 * The tenant's subscription is `past_due` and the request tried to WRITE.
 *
 * 402 rather than 403: the tenant is not forbidden, it is owed money. The
 * billing routes stay open so the owner can settle the invoice, and reads stay
 * open so the owner can see what is owed.
 */
export class SubscriptionPastDueException extends HttpException {
  constructor() {
    super(
      'This subscription is past due. Settle the outstanding invoice under ' +
        '/billing before the café can change anything.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * The tenant's subscription was cancelled.
 *
 * `cancelled` is terminal: the tenant may read its data and may open a new
 * subscription, but it may not operate the café any more.
 */
export class SubscriptionCancelledException extends HttpException {
  constructor() {
    super(
      'This subscription is cancelled. The café is read-only until a new ' +
        'subscription is started.',
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
