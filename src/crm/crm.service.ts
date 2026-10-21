import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  CustomerLookupDto,
  CustomerQueryDto,
  UpdateCustomerDto,
} from './dto/crm.dto';
import {
  CustomerNotFoundException,
  InvalidCustomerException,
  InvalidPhoneException,
} from './exceptions/crm.exceptions';
import { CrmRepository, isUniqueViolation } from './crm.repository';
import { parseCalendarDay, utcCalendarDay } from './calendar';
import type {
  CustomerLookupResult,
  CustomerProfile,
  CustomerRow,
  LoyaltyAccountRow,
  LoyaltyAccrualOutcome,
} from './crm.types';
import {
  LOYALTY_ACCRUAL_STRATEGY,
  type LoyaltyAccrualStrategy,
} from './loyalty/loyalty-accrual.strategy';
import { money } from './money';

/**
 * The most customers one list request returns.
 *
 * A cafe accumulates customers without bound; the list is for the counter
 * ("find me the regular who was here yesterday"), not for an export.
 */
const MAX_LISTED_CUSTOMERS = 200;

/** The `customers.full_name` column length. */
const MAX_NAME_LENGTH = 150;

/** The `customers.phone` column length. */
const MAX_PHONE_LENGTH = 30;

/** The `customers.email` column length. */
const MAX_EMAIL_LENGTH = 150;

/**
 * # CrmService
 *
 * Customer profiles and loyalty points.
 *
 * ## Two callers, two shapes
 *
 * HTTP handlers pass the request's tenant-scoped connection; the `order.paid`
 * listener has no request at all and acquires its own. That is why this
 * service does NOT inject `TenantRequestContext` — the same reason the
 * inventory service does not. A request-scoped dependency would make the
 * listener run on an instance built for a request that no longer exists.
 *
 * ## Loyalty is an Observer, not a checkout call
 *
 * Nothing in `OrderModule` calls this service synchronously. A paid order
 * publishes `order.paid`, and `OrderPaidLoyaltyListener` turns it into a credit.
 * Checkout stays unaware that loyalty exists, and a loyalty bug cannot fail a
 * payment that has already been taken.
 */
@Injectable()
export class CrmService {
  private readonly logger = new Logger(CrmService.name);

  constructor(
    private readonly repository: CrmRepository,
    private readonly connections: TenantConnectionService,
    @Inject(LOYALTY_ACCRUAL_STRATEGY)
    private readonly accrual: LoyaltyAccrualStrategy,
  ) {}

  // ---------------------------------------------------------------- customers

  /**
   * Finds the customer with this phone number, or creates one.
   *
   * ## Why the phone is the identity
   *
   * A cafe checkout has a name and a phone number, and only the phone is
   * something a person reliably gives the same way twice ("Sam" is three
   * different regulars). `(tenant_id, phone)` is UNIQUE in the schema, so the
   * database agrees.
   *
   * ## Why the existing row is returned untouched
   *
   * `fullName` and `email` are creation-only. Two staff members looking up the
   * same regular must not overwrite each other's spelling of the name, and a
   * lookup is not an edit. Changing a customer is a deliberate act this module
   * does not offer yet.
   *
   * ## The race
   *
   * Two simultaneous creations both read "no such phone" and both insert; one
   * loses on the unique index. The loser must return the winner's row, not a
   * 500 — which is why the insert runs inside a SAVEPOINT. Without it, the
   * unique violation would abort the enclosing transaction and the recovery
   * SELECT would fail with `25P02`.
   */
  async lookupOrCreateByPhone(
    connection: TenantScopedConnection,
    dto: CustomerLookupDto,
  ): Promise<CustomerLookupResult> {
    const phone = this.normalisePhone(dto.phone);
    const existing = await this.repository.findCustomerByPhone(
      connection,
      phone,
    );
    if (existing) {
      return {
        customer: existing,
        loyalty: await this.repository.findLoyaltyAccount(
          connection,
          existing.id,
        ),
        created: false,
      };
    }

    const fullName = this.normaliseName(dto.fullName);
    const email = this.normaliseEmail(dto.email);
    const dateOfBirth = this.normaliseDateOfBirth(dto.dateOfBirth);

    let created: CustomerRow;
    try {
      created = await this.repository.withSavepoint(connection, () =>
        this.repository.insertCustomer(connection, {
          phone,
          fullName,
          email,
          dateOfBirth,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        // Lost the race: somebody else created this phone between the read and
        // the insert. Return their row, exactly as a plain lookup would.
        const winner = await this.repository.findCustomerByPhone(
          connection,
          phone,
        );
        if (winner) {
          return {
            customer: winner,
            loyalty: await this.repository.findLoyaltyAccount(
              connection,
              winner.id,
            ),
            created: false,
          };
        }
      }
      throw error;
    }

    // Every customer gets an account at creation, so the counter never has to
    // explain why a new regular's loyalty screen is missing. Customers created
    // before this module existed get one lazily — see `getLoyalty`.
    const loyalty = await this.repository.ensureLoyaltyAccount(
      connection,
      created.id,
    );

    return { customer: created, loyalty, created: true };
  }

  async getCustomer(
    connection: TenantScopedConnection,
    customerId: string,
  ): Promise<CustomerProfile> {
    const customer = await this.repository.findCustomerById(
      connection,
      customerId,
    );
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }
    return {
      customer,
      loyalty: await this.repository.findLoyaltyAccount(
        connection,
        customer.id,
      ),
    };
  }

  /**
   * Fills in (or clears) a customer's birthday.
   *
   * This is deliberately the ONLY editable customer field. Correcting a
   * misspelled name remains unsupported, because two staff members can disagree
   * about spelling; a birthday is either known or not, and birthday greetings
   * cannot work until the counter can record one for a customer who predates
   * this feature. `null` clears it.
   *
   * A PATCH with no fields is a successful no-op, matching the "absent means
   * leave alone" rule the promotion update uses.
   */
  async updateCustomer(
    connection: TenantScopedConnection,
    customerId: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerRow> {
    const existing = await this.repository.findCustomerById(
      connection,
      customerId,
    );
    if (!existing) {
      throw new CustomerNotFoundException(customerId);
    }
    if (dto.dateOfBirth === undefined) {
      return existing;
    }

    const dateOfBirth = this.normaliseDateOfBirth(dto.dateOfBirth);
    const updated = await this.repository.updateCustomerDateOfBirth(
      connection,
      customerId,
      dateOfBirth,
    );
    if (!updated) {
      throw new CustomerNotFoundException(customerId);
    }
    return updated;
  }

  /**
   * The tenant's customers, newest first.
   *
   * With `phone`, this is a lookup: the customer is returned alone, or a 404.
   * The phone is the same normalisation the write path uses, so a trailing
   * space cannot turn an existing customer into "not found".
   */
  async listCustomers(
    connection: TenantScopedConnection,
    query: CustomerQueryDto,
  ): Promise<CustomerRow[]> {
    if (query.phone !== undefined) {
      const phone = this.normalisePhone(query.phone);
      const customer = await this.repository.findCustomerByPhone(
        connection,
        phone,
      );
      if (!customer) {
        throw new CustomerNotFoundException(phone);
      }
      return [customer];
    }
    return this.repository.listCustomers(connection, MAX_LISTED_CUSTOMERS);
  }

  /**
   * The customer's loyalty account.
   *
   * Created on read when absent, so a customer who predates this module (or was
   * inserted by an import) has an account the first time the counter asks,
   * rather than a 404 that looks like a bug.
   */
  async getLoyalty(
    connection: TenantScopedConnection,
    customerId: string,
  ): Promise<LoyaltyAccountRow> {
    const customer = await this.repository.findCustomerById(
      connection,
      customerId,
    );
    if (!customer) {
      throw new CustomerNotFoundException(customerId);
    }
    return this.repository.ensureLoyaltyAccount(connection, customer.id);
  }

  // ------------------------------------------------------------------ loyalty

  /**
   * Credits the loyalty points for a paid order, exactly once.
   *
   * Called by `OrderPaidLoyaltyListener` with the tenant and order id from the
   * event. Everything it needs beyond that is read from the durable order row:
   *
   *  - a walk-in order has `customer_id = NULL`; there is nobody to credit;
   *  - the total is read from `orders.total_amount`, not from the payload, so
   *    the credit is auditable against the row it describes.
   *
   * The ledger insert and the balance update are one transaction. A duplicate
   * delivery finds the ledger row already there and changes nothing.
   */
  async awardForPaidOrder(
    tenantId: string,
    orderId: string,
  ): Promise<LoyaltyAccrualOutcome> {
    const connection = await this.connections.acquireScoped(tenantId);

    try {
      const order = await this.repository.findOrderForLoyalty(
        connection,
        orderId,
      );

      if (!order) {
        await connection.commit();
        return {
          credited: false,
          points: 0,
          account: null,
          orderId,
          reason: 'order_not_found',
          customerId: null,
        };
      }

      if (!order.customer_id) {
        await connection.commit();
        return {
          credited: false,
          points: 0,
          account: null,
          orderId,
          reason: 'no_customer',
          customerId: null,
        };
      }

      const points = this.accrual.calculatePoints(money(order.total_amount));
      const result = await this.repository.creditLoyalty(connection, {
        orderId,
        customerId: order.customer_id,
        points,
      });

      await connection.commit();

      if (!result.credited) {
        return {
          credited: false,
          points: 0,
          account: null,
          orderId,
          reason: 'duplicate',
          customerId: order.customer_id,
        };
      }

      return {
        credited: true,
        points,
        account: result.account,
        orderId,
        customerId: order.customer_id,
      };
    } catch (error) {
      await connection.rollback().catch(() => undefined);
      this.logger.error(
        `Loyalty accrual failed for order ${orderId} (tenant ${tenantId}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    } finally {
      await connection.release();
    }
  }

  // ---------------------------------------------------------------- validation

  /**
   * Trims a phone number and requires it to be usable as an identity.
   *
   * Deliberately not normalising formats: `+977 98…` and `+97798…` are
   * different keys to this module because the schema has no agreed canonical
   * form and guessing one would merge two people (or split one) silently. The
   * counter should enter the number the same way each time; trimming is the
   * only transformation that is unambiguous.
   */
  private normalisePhone(value: unknown): string {
    if (typeof value !== 'string') {
      throw new InvalidPhoneException('a phone number is required');
    }
    const phone = value.trim();
    if (phone.length === 0) {
      throw new InvalidPhoneException('the phone number is empty');
    }
    if (phone.length > MAX_PHONE_LENGTH) {
      throw new InvalidPhoneException(
        `it is longer than ${MAX_PHONE_LENGTH} characters`,
      );
    }
    return phone;
  }

  private normaliseName(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidCustomerException('fullName must be a string or null');
    }
    const name = value.trim();
    if (name.length === 0) {
      return null;
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new InvalidCustomerException(
        `fullName is longer than ${MAX_NAME_LENGTH} characters`,
      );
    }
    return name;
  }

  private normaliseEmail(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidCustomerException('email must be a string or null');
    }
    const email = value.trim();
    if (email.length === 0) {
      return null;
    }
    if (email.length > MAX_EMAIL_LENGTH) {
      throw new InvalidCustomerException(
        `email is longer than ${MAX_EMAIL_LENGTH} characters`,
      );
    }
    if (!email.includes('@') || /\s/.test(email)) {
      throw new InvalidCustomerException(
        `'${email}' does not look like an email address`,
      );
    }
    return email;
  }

  /**
   * Validates a birth date as a real calendar day not in the future.
   *
   * The string is not passed through `new Date(value)` and re-formatted: that
   * would accept `1994-02-31` by rolling it into March, and would turn a
   * date-only value into an instant in the server's zone. The components are
   * checked directly and the SQL column is `DATE`, so what is stored is exactly
   * what was sent.
   *
   * "Today" is the UTC calendar day. A tenant-local day needs a tenant timezone,
   * which does not exist yet; this check only rejects impossible birthdays, so
   * a customer in a zone that is already on the next day is not rejected.
   */
  private normaliseDateOfBirth(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== 'string') {
      throw new InvalidCustomerException(
        'dateOfBirth must be a YYYY-MM-DD string or null',
      );
    }
    const birthday = parseCalendarDay(value.trim());
    if (!birthday) {
      throw new InvalidCustomerException(
        `dateOfBirth '${value}' must be a real calendar day in YYYY-MM-DD form`,
      );
    }

    if (birthday > utcCalendarDay(new Date())) {
      throw new InvalidCustomerException('dateOfBirth cannot be in the future');
    }
    return birthday;
  }
}
