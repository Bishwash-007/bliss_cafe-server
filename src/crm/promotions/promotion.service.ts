import { Inject, Injectable } from '@nestjs/common';
import { CRM_CLOCK, type CrmClock } from '../clock';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import {
  CrmRepository,
  isUniqueViolation,
  type CreatePromotionInput,
  type PromotionPatch,
} from '../crm.repository';
import type {
  ApplyPromotionDto,
  CreatePromotionDto,
  PromotionQueryDto,
  UpdatePromotionDto,
} from '../dto/crm.dto';
import {
  DuplicatePromotionCodeException,
  InvalidPromotionException,
  InvalidSubtotalException,
  PromotionExpiredException,
  PromotionIdNotFoundException,
  PromotionInactiveException,
  PromotionNotFoundException,
  PromotionNotStartedException,
  UnsupportedDiscountTypeException,
} from '../exceptions/crm.exceptions';
import { parseIsoInstant } from '../instants';
import { money, round2 } from '../money';
import type { PromotionApplication, PromotionRow } from '../crm.types';
import type { DiscountStrategy } from './discount.strategy';
import { FlatDiscountStrategy } from './flat-discount.strategy';
import { PercentageDiscountStrategy } from './percentage-discount.strategy';

/** The most promotions one list request returns. */
const MAX_LISTED_PROMOTIONS = 200;

const MAX_CODE_LENGTH = 50;

/** `NUMERIC(10,2)` cannot hold more than this. */
const MAX_DISCOUNT_VALUE = 99_999_999.99;

/** A code a human can read off a flyer: letters, digits, dash and underscore. */
const CODE_RE = /^[A-Z0-9][A-Z0-9_-]*$/;

type DiscountFactory = (value: number) => DiscountStrategy;

/**
 * # PromotionService
 *
 * Creates promotions and applies them to a subtotal.
 *
 * ## The strategy lookup
 *
 * `getStrategyFor` is a MAP from `discount_type` to a factory, not an
 * `if (type === 'percentage') … else …`. Adding `buy_one_get_one` is one entry
 * in the map and one class; nothing in `apply` changes. An unknown type throws
 * rather than defaulting, because applying a flat discount to a promotion the
 * tenant configured as a percentage is a receipt nobody can explain.
 *
 * The factory receives the PARSED `discount_value`. The strategy itself knows
 * only "this many percent" or "this much money" — it never reads the database
 * or the type column, so its arithmetic is testable in isolation and the
 * type-check lives in exactly one place.
 *
 * ## Validity is checked at APPLY time
 *
 * A promotion can be created for next month, switched off, or simply outlive
 * its `ends_at`. Checking at apply time — not at creation, and not in the
 * database — is what makes "the customer tries to use the expired flyer" a
 * clear 422 instead of a stale discount on a receipt. The clock is injected,
 * so the boundary is testable to the millisecond.
 */
@Injectable()
export class PromotionService {
  private readonly factories = new Map<string, DiscountFactory>([
    ['percentage', (value) => new PercentageDiscountStrategy(value)],
    ['flat', (value) => new FlatDiscountStrategy(value)],
  ]);

  constructor(
    private readonly repository: CrmRepository,
    @Inject(CRM_CLOCK) private readonly clock: CrmClock,
  ) {}

  /**
   * The strategy for a promotion, chosen purely from `discount_type`.
   *
   * Exposed (rather than private) because the selection rule is the acceptance
   * criterion: a test can ask the service which strategy it would use without
   * having to apply a discount and infer it from the number.
   */
  getStrategyFor(
    promotion: Pick<PromotionRow, 'discount_type' | 'discount_value'>,
  ): DiscountStrategy {
    const factory = this.factories.get(promotion.discount_type);
    if (!factory) {
      throw new UnsupportedDiscountTypeException(promotion.discount_type, [
        ...this.factories.keys(),
      ]);
    }
    return factory(money(promotion.discount_value));
  }

  async create(
    connection: TenantScopedConnection,
    dto: CreatePromotionDto,
  ): Promise<PromotionRow> {
    const code = this.normaliseCode(dto.code);
    const discountType = this.normaliseDiscountType(dto.discountType);
    const discountValue = this.normaliseDiscountValue(
      discountType,
      dto.discountValue,
    );
    const startsAt = this.parseOptionalInstant(dto.startsAt, 'startsAt');
    const endsAt = this.parseOptionalInstant(dto.endsAt, 'endsAt');
    this.assertWindow(startsAt, endsAt);
    const isActive = this.normaliseActive(dto.isActive);

    const input: CreatePromotionInput = {
      code,
      description: this.normaliseDescription(dto.description),
      discountType,
      discountValue,
      startsAt,
      endsAt,
      isActive,
    };

    try {
      return await this.repository.insertPromotion(connection, input);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicatePromotionCodeException(code);
      }
      throw error;
    }
  }

  async list(
    connection: TenantScopedConnection,
    query: PromotionQueryDto,
  ): Promise<PromotionRow[]> {
    const activeOnly =
      query.activeOnly === true ||
      (typeof query.activeOnly === 'string' &&
        query.activeOnly.toLowerCase() === 'true');

    return this.repository.listPromotions(connection, {
      activeOnly,
      limit: MAX_LISTED_PROMOTIONS,
    });
  }

  async get(
    connection: TenantScopedConnection,
    promotionId: string,
  ): Promise<PromotionRow> {
    const promotion = await this.repository.findPromotionById(
      connection,
      promotionId,
    );
    if (!promotion) {
      throw new PromotionIdNotFoundException(promotionId);
    }
    return promotion;
  }

  async update(
    connection: TenantScopedConnection,
    promotionId: string,
    dto: UpdatePromotionDto,
  ): Promise<PromotionRow> {
    const existing = await this.repository.findPromotionById(
      connection,
      promotionId,
    );
    if (!existing) {
      throw new PromotionIdNotFoundException(promotionId);
    }

    const patch: PromotionPatch = {};
    let code: string | undefined;

    if (dto.code !== undefined) {
      code = this.normaliseCode(dto.code);
      patch.code = code;
    }
    if (dto.description !== undefined) {
      patch.description = this.normaliseDescription(dto.description);
    }

    // Validate the discount against the type it will have AFTER the patch: a
    // change from `percentage` to `flat` must not be checked against the old
    // type's rule, and vice versa.
    const discountType =
      dto.discountType !== undefined
        ? this.normaliseDiscountType(dto.discountType)
        : existing.discount_type;
    if (dto.discountType !== undefined) {
      patch.discountType = discountType;
    }
    if (dto.discountValue !== undefined) {
      patch.discountValue = this.normaliseDiscountValue(
        discountType,
        dto.discountValue,
      );
    }

    const startsAt =
      dto.startsAt !== undefined
        ? this.parseOptionalInstant(dto.startsAt, 'startsAt')
        : existing.starts_at;
    const endsAt =
      dto.endsAt !== undefined
        ? this.parseOptionalInstant(dto.endsAt, 'endsAt')
        : existing.ends_at;
    this.assertWindow(startsAt, endsAt);
    if (dto.startsAt !== undefined) {
      patch.startsAt = startsAt;
    }
    if (dto.endsAt !== undefined) {
      patch.endsAt = endsAt;
    }
    if (dto.isActive !== undefined) {
      patch.isActive = this.normaliseActive(dto.isActive);
    }

    try {
      const updated = await this.repository.updatePromotion(
        connection,
        promotionId,
        patch,
      );
      if (!updated) {
        throw new PromotionIdNotFoundException(promotionId);
      }
      return updated;
    } catch (error) {
      if (isUniqueViolation(error) && code !== undefined) {
        throw new DuplicatePromotionCodeException(code);
      }
      throw error;
    }
  }

  /**
   * Applies a promotion to a subtotal, refusing one that is not currently
   * usable.
   *
   * The subtotal is the amount BEFORE tax and before any other discount. The
   * result names both the discount and the resulting total, so a receipt can
   * print either without re-doing the arithmetic.
   */
  async apply(
    connection: TenantScopedConnection,
    dto: ApplyPromotionDto,
  ): Promise<PromotionApplication> {
    const code = this.normaliseCode(dto.code);
    const subtotal = this.normaliseSubtotal(dto.subtotal);

    const promotion = await this.repository.findPromotionByCode(
      connection,
      code,
    );
    if (!promotion) {
      throw new PromotionNotFoundException(code);
    }

    const now = this.clock.now();
    this.assertUsable(promotion, now);

    const strategy = this.getStrategyFor(promotion);
    const discountAmount = strategy.apply(subtotal);

    return {
      promotionId: promotion.id,
      code: promotion.code,
      discountType: promotion.discount_type,
      subtotal,
      discountAmount,
      total: round2(subtotal - discountAmount),
    };
  }

  // -------------------------------------------------------------- validity

  /**
   * Refuses a promotion outside its active window.
   *
   * Public because a campaign announcement must obey exactly the same rule as a
   * till application: telling every customer about a code that cannot be
   * applied is worse than not announcing it. Keeping one predicate means the
   * announcement and the checkout can never disagree about whether a promotion
   * is live.
   */
  assertUsable(promotion: PromotionRow, now: Date): void {
    if (!promotion.is_active) {
      throw new PromotionInactiveException(promotion.code);
    }
    if (promotion.starts_at && now.getTime() < promotion.starts_at.getTime()) {
      throw new PromotionNotStartedException(
        promotion.code,
        promotion.starts_at,
        now,
      );
    }
    // `ends_at` is EXCLUSIVE: a promotion that ends at 17:00 is no longer valid
    // at 17:00:00.000. That is the half-open window every other date range in
    // this codebase uses, and it means a promotion cannot be "live" at the
    // exact instant the next one starts.
    if (promotion.ends_at && now.getTime() >= promotion.ends_at.getTime()) {
      throw new PromotionExpiredException(
        promotion.code,
        promotion.ends_at,
        now,
      );
    }
  }

  // ------------------------------------------------------------ validation

  private normaliseCode(value: unknown): string {
    if (typeof value !== 'string') {
      throw new InvalidPromotionException('code must be a string');
    }
    const code = value.trim().toUpperCase();
    if (code.length === 0) {
      throw new InvalidPromotionException('code is empty');
    }
    if (code.length > MAX_CODE_LENGTH) {
      throw new InvalidPromotionException(
        `code is longer than ${MAX_CODE_LENGTH} characters`,
      );
    }
    if (!CODE_RE.test(code)) {
      throw new InvalidPromotionException(
        `code '${code}' may contain only letters, digits, '-' and '_'`,
      );
    }
    return code;
  }

  private normaliseDiscountType(value: unknown): string {
    if (typeof value !== 'string' || !this.factories.has(value)) {
      throw new UnsupportedDiscountTypeException(String(value), [
        ...this.factories.keys(),
      ]);
    }
    return value;
  }

  private normaliseDiscountValue(discountType: string, value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidPromotionException(
        'discountValue must be a finite number',
      );
    }
    if (value <= 0) {
      throw new InvalidPromotionException('discountValue must be positive');
    }
    if (value > MAX_DISCOUNT_VALUE) {
      throw new InvalidPromotionException(
        `discountValue is larger than the column can hold (${MAX_DISCOUNT_VALUE})`,
      );
    }
    if (discountType === 'percentage' && value > 100) {
      throw new InvalidPromotionException(
        'a percentage discountValue cannot be greater than 100',
      );
    }
    return round2(value);
  }

  private normaliseDescription(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidPromotionException(
        'description must be a string or null',
      );
    }
    const description = value.trim();
    return description.length === 0 ? null : description;
  }

  private normaliseActive(value: unknown): boolean {
    if (value === undefined) {
      return true;
    }
    if (typeof value !== 'boolean') {
      throw new InvalidPromotionException('isActive must be a boolean');
    }
    return value;
  }

  private parseOptionalInstant(value: unknown, label: string): Date | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidPromotionException(
        `${label} must be an ISO-8601 string or null`,
      );
    }
    return parseIsoInstant(value, label);
  }

  private assertWindow(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
      throw new InvalidPromotionException(
        `startsAt (${startsAt.toISOString()}) must be before endsAt ` +
          `(${endsAt.toISOString()})`,
      );
    }
  }

  private normaliseSubtotal(value: unknown): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new InvalidSubtotalException('it must be a finite number');
    }
    if (value < 0) {
      throw new InvalidSubtotalException('it cannot be negative');
    }
    if (value > MAX_DISCOUNT_VALUE) {
      throw new InvalidSubtotalException(
        `it is larger than the money column can hold (${MAX_DISCOUNT_VALUE})`,
      );
    }
    return money(value);
  }
}
