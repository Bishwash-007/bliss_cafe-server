/**
 * Public barrel for the CRM module.
 *
 * ## What is implemented
 *
 *  - **Customers** — lookup or creation by phone, tenant-scoped. `POST
 *    /customers` returns the existing row (`created: false`) or a new one
 *    (`created: true`), and every customer gets a loyalty account.
 *  - **Loyalty** — points credited from `order.paid` by an Observer listener,
 *    exactly once per order, using a `LoyaltyAccrualStrategy`. The balance is
 *    readable at `GET /customers/:id/loyalty`.
 *  - **Promotions** — a tenant-wide catalogue (`percentage` / `flat`) and
 *    `POST /promotions/apply`, which prices a subtotal and refuses a promotion
 *    that is inactive, not yet started, or expired.
 *  - **Campaign publishing** — `POST /promotions/:id/announce` and
 *    `POST /customers/birthdays/announce` publish one `crm.promotion` /
 *    `crm.birthday` event per customer on the shared event bus. Notification
 *    owns opt-out, channel choice and delivery.
 *
 * ## How checkout attaches a customer
 *
 * `OrderModule` already accepts `customerId` on `POST /orders`. The intended
 * flow is:
 *
 * ```text
 * POST /customers { "phone": "9800000000", "fullName": "Asha" }
 *   -> { customer: { id }, created: true, loyalty: {...} }
 * POST /orders { "branchId": "...", "customerId": "<id>", ... }
 * ```
 *
 * The second request is unchanged: CRM does not inject itself into the order
 * transaction, and `OrderModule` does not import `CrmModule`. That is
 * deliberate. Attaching the customer is a lookup, not a discount, and making
 * checkout depend on CRM would turn a loyalty outage into a checkout outage.
 * When the order is later paid, `order.paid` credits the points.
 *
 * ## What is deliberately NOT implemented
 *
 * ### Redemption
 *
 * Points accrue and are readable; they cannot be spent. Spending them is a
 * pricing operation (how many points is a free coffee?) that the schema does
 * not define — `loyalty_accounts` has a balance and a tier, but no redemption
 * rate, no expiry and no ledger of debits. A `POST /customers/:id/loyalty/redeem`
 * endpoint without those rules would let a caller drain a balance for an
 * arbitrary discount, so it is left out rather than guessed.
 *
 * ### Tiers and expiry
 *
 * The `tier` column exists and defaults to `standard`. Nothing promotes a
 * customer to a different tier and no balance expires, because both are
 * marketing rules the tenant has not stated. The column is carried through
 * reads so a future rule has somewhere to write.
 *
 * ### Per-visit accrual
 *
 * `PointsPerCurrencyStrategy` is the only rule bound today. `PointsPerVisitStrategy`
 * is a class and a module binding away, which is the point of the interface;
 * the schema has no column that says which rule a tenant uses, so adding one
 * would mean inventing a tenant-settings table in this module.
 *
 * ### Discounts inside checkout
 *
 * `POST /promotions/apply` returns a priced discount, but `CreateOrderDto`
 * still accepts a free-form `discountAmount` (see the note in
 * `src/order/dto/order.dto.ts`). Wiring the two together means deciding where
 * tax is calculated and how a discount is audited on the order row; neither is
 * defined yet. Until then the endpoint is callable by the POS and the order
 * field remains the order module's business.
 *
 * ### Customer editing and history
 *
 * There is no update or delete. `fullName`/`email` are creation-only, so two
 * staff members cannot overwrite each other's spelling of a regular's name.
 * The `loyalty_credits` ledger is written but not exposed as a history
 * endpoint.
 *
 * ### Campaign scheduling and segments
 *
 * Publishing is implemented, but choosing an audience is deliberately manual:
 * an owner supplies an explicit customer list or asks for the whole tenant, and
 * a birthday run is for one explicit calendar day (default UTC today). There is
 * no segment builder, no recurring cron, and no tenant timezone yet. A scheduler
 * can call `CrmEventPublisher.announceBirthdays` with the tenant's local day
 * without changing the event contract or the notification listener.
 *
 * Promotion announcements require the promotion to be usable at announce time,
 * by the same predicate checkout applies. Announcing a future code ahead of its
 * `starts_at` is therefore not supported yet.
 */

export { CrmModule } from './crm.module';
export { CrmService } from './crm.service';
export { CustomerController } from './customer.controller';
export { PromotionController } from './promotion.controller';
export { CrmEventPublisher } from './events/crm-event.publisher';
export { PromotionService } from './promotions/promotion.service';

export {
  CRM_EVENTS,
  type CrmBirthdayEvent,
  type CrmCustomerEvent,
  type CrmEventName,
  type CrmPromotionEvent,
} from './events/crm-events';

export { parseCalendarDay, utcCalendarDay } from './calendar';
export { CRM_CLOCK, SystemClock, type CrmClock } from './clock';
export {
  LOYALTY_ACCRUAL_STRATEGY,
  type LoyaltyAccrualStrategy,
} from './loyalty/loyalty-accrual.strategy';
export { PointsPerCurrencyStrategy } from './loyalty/points-per-currency.strategy';
export {
  DISCOUNT_TYPES,
  isDiscountType,
  type DiscountStrategy,
  type DiscountType,
} from './promotions/discount.strategy';
export { FlatDiscountStrategy } from './promotions/flat-discount.strategy';
export { PercentageDiscountStrategy } from './promotions/percentage-discount.strategy';

export { CrmRepository } from './crm.repository';
export type {
  BirthdayAnnouncement,
  CustomerAnnouncementTarget,
  CustomerLookupResult,
  CustomerProfile,
  CustomerRow,
  LoyaltyAccountRow,
  LoyaltyAccrualOutcome,
  LoyaltyCreditRow,
  PromotionAnnouncement,
  PromotionApplication,
  PromotionRow,
} from './crm.types';
export type {
  AnnounceBirthdaysDto,
  AnnouncePromotionDto,
  ApplyPromotionDto,
  CreatePromotionDto,
  CustomerLookupDto,
  CustomerQueryDto,
  PromotionQueryDto,
  UpdateCustomerDto,
  UpdatePromotionDto,
} from './dto/crm.dto';
export {
  CustomerNotFoundException,
  DuplicatePromotionCodeException,
  InvalidCampaignException,
  InvalidCustomerException,
  InvalidInstantException,
  InvalidPhoneException,
  InvalidPromotionException,
  InvalidSubtotalException,
  PromotionExpiredException,
  PromotionIdNotFoundException,
  PromotionInactiveException,
  PromotionNotFoundException,
  PromotionNotStartedException,
  UnsupportedDiscountTypeException,
} from './exceptions/crm.exceptions';
export { parseIsoInstant } from './instants';
export { fromCents, money, round2, toCents } from './money';
