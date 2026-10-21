/**
 * # The CRM event bus — the CONTRACT for downstream modules
 *
 * CRM is a publisher here and Notification (10) is the subscriber. There is no
 * second event system: these names travel on the SAME global `EventEmitter2`
 * that carries `order.*` and `inventory.low_stock`, so a listener is one
 * `@OnEvent` decorator away and a publisher never imports `NotificationModule`.
 *
 * ## What is published today
 *
 * `CrmEventPublisher` publishes both events from the operator endpoints:
 *
 *  - `POST /promotions/:id/announce` — one `crm.promotion` per target customer;
 *  - `POST /customers/birthdays/announce` — one `crm.birthday` per customer
 *    whose birthday is the chosen day.
 *
 * There is no scheduler yet: the owner supplies the audience/day, or a cron can
 * call the publisher directly with the tenant's local day.
 *
 * ## Publishing rules
 *
 *  - One event per CUSTOMER, not one per campaign. A promotion broadcast is not
 *    an event that "happened to the tenant"; the thing that happened is that a
 *    specific customer should be told. Batch semantics would force every
 *    subscriber to expand the audience, and two subscribers would disagree
 *    about who is opted out.
 *  - Announcement endpoints only read, so there is no write to wait for. Any
 *    future publisher that changes a row first must publish after commit, using
 *    the same `TenantScopedConnection.onCommit` pattern as the order events.
 *  - `occurredAt` is the dedupe axis for an occasion: a birthday fires once per
 *    year, not once per scheduler tick. The queue key includes the year.
 */

export const CRM_EVENTS = {
  /** A customer is eligible for a promotion. */
  promotion: 'crm.promotion',
  /** A customer's birthday is today (per the tenant's local calendar). */
  birthday: 'crm.birthday',
} as const;

export type CrmEventName = (typeof CRM_EVENTS)[keyof typeof CRM_EVENTS];

interface CrmCustomerEventBase {
  /** Discriminator matching the emitted event name. */
  readonly event: CrmEventName;
  readonly tenantId: string;
  readonly customerId: string;
  /** ISO-8601, stamped once by the publisher. */
  readonly occurredAt: string;
}

/** `crm.promotion` — tell this customer about a promotion. */
export interface CrmPromotionEvent extends CrmCustomerEventBase {
  readonly event: typeof CRM_EVENTS.promotion;
  readonly promotionId: string;
  readonly code: string;
  readonly description: string | null;
}

/** `crm.birthday` — today is this customer's birthday. */
export interface CrmBirthdayEvent extends CrmCustomerEventBase {
  readonly event: typeof CRM_EVENTS.birthday;
  /** The name as CRM knows it; may be null when the customer was phone-only. */
  readonly customerName: string | null;
}

export type CrmCustomerEvent = CrmPromotionEvent | CrmBirthdayEvent;
