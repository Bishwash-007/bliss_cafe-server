import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

/**
 * CRM-domain failures, each a distinct class so a caller can branch on the
 * exact reason a request was refused instead of matching message text. Mirrors
 * `src/staff/exceptions/staff.exceptions.ts` and
 * `src/inventory/exceptions/inventory.exceptions.ts`.
 */

/** The customer does not exist for this tenant. */
export class CustomerNotFoundException extends NotFoundException {
  constructor(customerId: string) {
    super(`Customer ${customerId} was not found for this tenant`);
  }
}

/** A phone number that is missing, empty, or too long for the column. */
export class InvalidPhoneException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid customer phone number: ${reason}`);
  }
}

/** A customer field that cannot be stored as sent. */
export class InvalidCustomerException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid customer: ${reason}`);
  }
}

/** The promotion code does not exist for this tenant. */
export class PromotionNotFoundException extends NotFoundException {
  constructor(code: string) {
    super(`Promotion '${code}' was not found for this tenant`);
  }
}

/** The promotion id does not exist for this tenant. */
export class PromotionIdNotFoundException extends NotFoundException {
  constructor(promotionId: string) {
    super(`Promotion ${promotionId} was not found for this tenant`);
  }
}

/**
 * A second promotion with the same code.
 *
 * A 409 rather than a 400: the request is well-formed, it conflicts with an
 * existing row. `(tenant_id, code)` is UNIQUE in migration 008, so this is the
 * database's answer, not the service's guess.
 */
export class DuplicatePromotionCodeException extends ConflictException {
  constructor(code: string) {
    super(
      `Promotion code '${code}' already exists for this tenant. Codes are ` +
        `unique because a checkout that applied "the" SPRING10 must apply ` +
        `exactly one of them.`,
    );
  }
}

/**
 * A promotion that is switched off.
 *
 * A 422: the request is well-formed, but the promotion cannot be applied in its
 * current state. Answering 200 with a zero discount would be worse — the
 * customer would believe a promotion was applied when nothing happened, and the
 * error would surface as a support ticket instead of a checkout message.
 */
export class PromotionInactiveException extends UnprocessableEntityException {
  constructor(code: string) {
    super(`Promotion '${code}' is inactive and cannot be applied.`);
  }
}

/** A promotion whose `ends_at` has passed. */
export class PromotionExpiredException extends UnprocessableEntityException {
  constructor(code: string, endsAt: Date, now: Date) {
    super(
      `Promotion '${code}' ended at ${endsAt.toISOString()} and cannot be ` +
        `applied at ${now.toISOString()}.`,
    );
  }
}

/** A promotion whose `starts_at` is still in the future. */
export class PromotionNotStartedException extends UnprocessableEntityException {
  constructor(code: string, startsAt: Date, now: Date) {
    super(
      `Promotion '${code}' does not start until ${startsAt.toISOString()} and ` +
        `cannot be applied at ${now.toISOString()}.`,
    );
  }
}

/**
 * A `discount_type` with no strategy behind it.
 *
 * Thrown rather than falling back to a default, for the same reason the staff
 * module refuses an unknown pay type: a fallback would apply a discount the
 * tenant never configured, and a wrong receipt is worse than a refused one.
 */
export class UnsupportedDiscountTypeException extends UnprocessableEntityException {
  constructor(discountType: string, supported: readonly string[]) {
    super(
      `Discount type '${discountType}' has no calculation strategy. ` +
        `Supported types: ${supported.join(', ')}.`,
    );
  }
}

/** A campaign request whose audience or day cannot be used as sent. */
export class InvalidCampaignException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid campaign: ${reason}`);
  }
}

/** A promotion field that cannot be stored as sent. */
export class InvalidPromotionException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid promotion: ${reason}`);
  }
}

/** A subtotal that is not a non-negative money amount. */
export class InvalidSubtotalException extends BadRequestException {
  constructor(reason: string) {
    super(`Invalid subtotal: ${reason}`);
  }
}

/** A timestamp that is not a real ISO-8601 instant with an offset. */
export class InvalidInstantException extends BadRequestException {
  constructor(reason: string) {
    super(reason);
  }
}
