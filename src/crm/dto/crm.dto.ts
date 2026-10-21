/**
 * CRM HTTP payloads.
 *
 * Plain interfaces, matching the rest of the project: no `class-validator`
 * pipe is installed, so the service validates and the DTO documents.
 */

/**
 * A customer lookup or creation.
 *
 * `phone` is the identity. It is required because the module's whole point is
 * "the person at the counter gives a phone number", and a customer with no
 * phone cannot be looked up again — which makes the loyalty account attached
 * to them unreachable.
 *
 * `fullName` and `email` are optional and are only used when the customer is
 * created. A lookup of an existing phone never overwrites what is already
 * stored: two staff members entering the same regular must not fight over the
 * spelling of their name.
 */
export interface CustomerLookupDto {
  phone: string;
  fullName?: string | null;
  email?: string | null;
}

/** Query for `GET /customers`. */
export interface CustomerQueryDto {
  /**
   * Exact phone number to look up. When present, the response is that one
   * customer (or 404); when absent, the tenant's customers are listed.
   */
  phone?: string;
}

/**
 * A promotion to create.
 *
 * `discountType` names a registered strategy (`percentage` or `flat`);
 * `discountValue` is the percentage (`12.5`) or the money amount (`5.00`),
 * matching the meaning of the `discount_type` column.
 */
export interface CreatePromotionDto {
  /** Case-insensitive identifier, stored uppercase. `SPRING10`. */
  code: string;
  description?: string | null;
  discountType: string;
  discountValue: number;
  /** ISO-8601 instant with an offset. Omit for "no start bound". */
  startsAt?: string | null;
  /** ISO-8601 instant with an offset. Omit for "no end bound". */
  endsAt?: string | null;
  isActive?: boolean;
}

/**
 * A partial promotion change.
 *
 * An absent field is left alone. `null` is meaningful for `startsAt`/`endsAt`
 * and `description` (remove the bound/description); for the fields that define
 * the promotion (`code`, `discountType`, `discountValue`) `null` is rejected.
 */
export interface UpdatePromotionDto {
  code?: string;
  description?: string | null;
  discountType?: string;
  discountValue?: number;
  startsAt?: string | null;
  endsAt?: string | null;
  isActive?: boolean;
}

/** Query for `GET /promotions`. */
export interface PromotionQueryDto {
  /** `true` to list only active promotions. Anything else lists all. */
  activeOnly?: string | boolean;
}

/** A promotion being applied to a subtotal. */
export interface ApplyPromotionDto {
  /** The promotion code, case-insensitive. */
  code: string;
  /** The pre-discount amount. A non-negative money amount. */
  subtotal: number;
}
