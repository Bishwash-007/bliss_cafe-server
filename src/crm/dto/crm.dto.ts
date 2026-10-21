import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

const isPresent = (_object: unknown, value: unknown): boolean =>
  value !== undefined;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * CRM HTTP payloads.
 *
 * The decorators reject malformed JSON; the CRM service still owns the
 * *business* rules (is this discount type registered? is this promotion
 * already running?) because those are testable without HTTP.
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
export class CustomerLookupDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(30)
  phone!: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  fullName?: string | null;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  /** Calendar day, `YYYY-MM-DD`; not an instant. Null means "unknown". */
  @IsOptional()
  @Matches(DATE_ONLY)
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
export class UpdateCustomerDto {
  @IsOptional()
  @Matches(DATE_ONLY)
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
export class AnnouncePromotionDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  customerIds?: string[] | null;
}

/**
 * The day whose birthdays should be greeted.
 *
 * Omitted uses "today" in UTC. Supplied as `YYYY-MM-DD` so an operator (or a
 * later scheduler) can choose the tenant's local calendar day, which the schema
 * cannot derive until tenants have a timezone.
 */
export class AnnounceBirthdaysDto {
  @IsOptional()
  @Matches(DATE_ONLY)
  date?: string | null;
}

/** Query for `GET /customers`. */
export class CustomerQueryDto {
  /**
   * Exact phone number to look up. When present, the response is that one
   * customer (or 404); when absent, the tenant's customers are listed.
   */
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;
}

/**
 * A promotion to create.
 *
 * `discountType` names a registered strategy (`percentage` or `flat`);
 * `discountValue` is the percentage (`12.5`) or the money amount (`5.00`),
 * matching the meaning of the `discount_type` column.
 */
export class CreatePromotionDto {
  /** Case-insensitive identifier, stored uppercase. `SPRING10`. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  discountType!: string;

  @IsNumber()
  @Min(0)
  @Max(1000000)
  discountValue!: number;

  /** ISO-8601 instant with an offset. Omit for "no start bound". */
  @IsOptional()
  @IsString()
  startsAt?: string | null;

  /** ISO-8601 instant with an offset. Omit for "no end bound". */
  @IsOptional()
  @IsString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * A partial promotion change.
 *
 * An absent field is left alone. `null` is meaningful for `startsAt`/`endsAt`
 * and `description` (remove the bound/description); for the fields that define
 * the promotion (`code`, `discountType`, `discountValue`) `null` is rejected.
 */
export class UpdatePromotionDto {
  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @ValidateIf(isPresent)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  discountType?: string;

  @ValidateIf(isPresent)
  @IsNumber()
  @Min(0)
  @Max(1000000)
  discountValue?: number;

  @IsOptional()
  @IsString()
  startsAt?: string | null;

  @IsOptional()
  @IsString()
  endsAt?: string | null;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Query for `GET /promotions`. */
export class PromotionQueryDto {
  /** `true` to list only active promotions. Anything else lists all. */
  @IsOptional()
  @IsString()
  activeOnly?: string | boolean;
}

/** A promotion being applied to a subtotal. */
export class ApplyPromotionDto {
  /** The promotion code, case-insensitive. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  code!: string;

  /** The pre-discount amount. A non-negative money amount. */
  @IsNumber()
  @Min(0)
  subtotal!: number;
}
