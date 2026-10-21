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
 * `fullName`, `email` and `dateOfBirth` are optional and are only used when the
 * customer is created. A lookup of an existing phone never overwrites what is
 * already stored: two staff members entering the same regular must not fight
 * over the spelling of their name. `PATCH /customers/:id` is the deliberate way
 * to fill in a birthday later.
 */
export interface CustomerLookupDto {
  phone: string;
  fullName?: string | null;
  email?: string | null;
  /** Calendar day, `YYYY-MM-DD`; not an instant. Null means "unknown". */
  dateOfBirth?: string | null;
}

/**
 * A partial customer change.
 *
 * Only `dateOfBirth` is editable today. It is separate from the lookup payload
 * so "the customer said their birthday" is an explicit action rather than a
 * side effect of typing a phone number at the counter. `null` clears a
 * previously stored day.
 */
export interface UpdateCustomerDto {
  dateOfBirth?: string | null;
}

/**
 * The audience for a promotion announcement.
 *
 * Omitted or `null` means every customer in the tenant. An explicit list is
 * checked for unknown ids before any event is published, so a typo cannot
 * silently send to a smaller audience. An empty list is rejected: "nobody" is
 * not an announcement, it is a mistake.
 */
export interface AnnouncePromotionDto {
  customerIds?: string[] | null;
}

/**
 * The day whose birthdays should be greeted.
 *
 * Omitted uses "today" in UTC. Supplied as `YYYY-MM-DD` so an operator (or a
 * later scheduler) can choose the tenant's local calendar day, which the schema
 * cannot derive until tenants have a timezone.
 */
export interface AnnounceBirthdaysDto {
  date?: string | null;
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
