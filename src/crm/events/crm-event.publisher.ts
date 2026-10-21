import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { TenantScopedConnection } from '../../tenant/connection/tenant-scoped-connection';
import { parseCalendarDay, utcCalendarDay } from '../calendar';
import { CRM_CLOCK, type CrmClock } from '../clock';
import { CrmRepository, isUuid } from '../crm.repository';
import type {
  BirthdayAnnouncement,
  CustomerAnnouncementTarget,
  PromotionAnnouncement,
} from '../crm.types';
import type {
  AnnounceBirthdaysDto,
  AnnouncePromotionDto,
} from '../dto/crm.dto';
import { InvalidCampaignException } from '../exceptions/crm.exceptions';
import {
  CRM_EVENTS,
  type CrmBirthdayEvent,
  type CrmPromotionEvent,
} from './crm-events';
import { PromotionService } from '../promotions/promotion.service';

/**
 * # CrmEventPublisher
 *
 * Turns an operator's "announce this" request into the per-customer events the
 * Notification module consumes.
 *
 * ## One event per customer
 *
 * The contract in `crm-events.ts` is deliberate: a broadcast is not one event
 * that "happened to the tenant", it is N facts, one per person. Notification
 * then applies opt-out and channel choice once per customer. A batched event
 * would force every subscriber to expand the audience and they would disagree
 * about who is eligible.
 *
 * ## Publishing is synchronous with the request
 *
 * These endpoints only READ (the promotion and the audience); there is no write
 * to commit first. `emitAsync` is awaited so the response reports how many
 * events were handed to the bus, and so the caller sees a genuine failure
 * instead of a 200 followed by an unhandled rejection. The notification
 * listeners enqueue jobs; they never send inline, so this stays fast even
 * though nothing is delivered by the time the response returns.
 *
 * ## What this is not
 *
 * There is no scheduler and no segment builder. The operator supplies either an
 * explicit customer list or "everyone", and a birthday run is for one explicit
 * calendar day. A cron that picks the local day and calls
 * `announceBirthdays` is the next layer, not something hidden here.
 */
@Injectable()
export class CrmEventPublisher {
  constructor(
    private readonly repository: CrmRepository,
    private readonly promotions: PromotionService,
    @Inject(CRM_CLOCK) private readonly clock: CrmClock,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * Publishes `crm.promotion` for each target customer.
   *
   * The promotion must be usable NOW, by the same predicate checkout uses.
   * Announcing a code that is inactive, not started, or expired would send
   * every customer to a till that refuses them.
   *
   * When `customerIds` is supplied, every id must resolve in this tenant before
   * the first event is published. Partial success would make a typo look like a
   * successful campaign to a smaller audience. Ids are deduplicated so a
   * repeated id does not inflate the response or emit twice.
   */
  async announcePromotion(
    connection: TenantScopedConnection,
    promotionId: string,
    dto: AnnouncePromotionDto = {},
  ): Promise<PromotionAnnouncement> {
    const customerIds = this.normaliseCustomerIds(dto.customerIds);
    const promotion = await this.promotions.get(connection, promotionId);
    this.promotions.assertUsable(promotion, this.clock.now());

    const targets = await this.repository.listAnnouncementTargets(
      connection,
      customerIds,
    );
    if (customerIds) {
      this.assertAudienceExists(customerIds, targets);
    }

    const occurredAt = this.clock.now().toISOString();
    const tenantId = this.tenantId(connection);

    for (const target of targets) {
      const event: CrmPromotionEvent = {
        event: CRM_EVENTS.promotion,
        tenantId,
        customerId: target.id,
        promotionId: promotion.id,
        code: promotion.code,
        description: promotion.description,
        occurredAt,
      };
      await this.events.emitAsync(CRM_EVENTS.promotion, event);
    }

    return {
      promotionId: promotion.id,
      code: promotion.code,
      published: targets.length,
    };
  }

  /**
   * Publishes `crm.birthday` for every customer whose birthday is `dto.date`.
   *
   * Omitted date means today in UTC. The explicit form exists because the tenant
   * timezone is not in the schema: a scheduler running at 00:05 Kathmandu time
   * would otherwise greet the wrong day for most of its run.
   *
   * The notification dedupe key includes the year, so calling this twice on the
   * same day does not send two greetings; the queue drops the duplicate.
   */
  async announceBirthdays(
    connection: TenantScopedConnection,
    dto: AnnounceBirthdaysDto = {},
  ): Promise<BirthdayAnnouncement> {
    const date = this.normaliseDate(dto.date);
    const targets = await this.repository.listBirthdayTargets(connection, date);
    const occurredAt = this.clock.now().toISOString();
    const tenantId = this.tenantId(connection);

    for (const target of targets) {
      const event: CrmBirthdayEvent = {
        event: CRM_EVENTS.birthday,
        tenantId,
        customerId: target.id,
        customerName: target.full_name,
        occurredAt,
      };
      await this.events.emitAsync(CRM_EVENTS.birthday, event);
    }

    return { date, published: targets.length };
  }

  private normaliseCustomerIds(value: unknown): string[] | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      throw new InvalidCampaignException(
        'customerIds must be an array of customer ids or omitted',
      );
    }
    if (value.length === 0) {
      throw new InvalidCampaignException(
        'customerIds was empty; omit it to announce to every customer',
      );
    }

    const unique: string[] = [];
    const seen = new Set<string>();
    for (const id of value) {
      if (typeof id !== 'string' || !isUuid(id)) {
        throw new InvalidCampaignException(
          `'${String(id)}' is not a customer id`,
        );
      }
      if (!seen.has(id)) {
        seen.add(id);
        unique.push(id);
      }
    }
    return unique;
  }

  private assertAudienceExists(
    requested: readonly string[],
    found: readonly CustomerAnnouncementTarget[],
  ): void {
    if (found.length === requested.length) {
      return;
    }
    const foundIds = new Set(found.map((target) => target.id));
    const missing = requested.find((id) => !foundIds.has(id));
    throw new InvalidCampaignException(
      `customer ${missing} was not found for this tenant; no events were published`,
    );
  }

  private normaliseDate(value: unknown): string {
    if (value === undefined || value === null) {
      return utcCalendarDay(this.clock.now());
    }
    if (typeof value !== 'string') {
      throw new InvalidCampaignException(
        'date must be a YYYY-MM-DD string or omitted',
      );
    }
    const date = parseCalendarDay(value.trim());
    if (!date) {
      throw new InvalidCampaignException(
        `date '${value}' must be a real calendar day in YYYY-MM-DD form`,
      );
    }
    return date;
  }

  private tenantId(connection: TenantScopedConnection): string {
    if (connection.tenantId === null) {
      throw new Error(
        'CRM campaign publishing requires a tenant-scoped connection.',
      );
    }
    return connection.tenantId;
  }
}
