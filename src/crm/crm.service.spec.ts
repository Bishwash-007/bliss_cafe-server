import type { TenantConnectionService } from '../tenant/connection/tenant-connection.service';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { CrmRepository } from './crm.repository';
import { CrmService } from './crm.service';
import type { CustomerRow, LoyaltyAccountRow } from './crm.types';
import {
  CustomerNotFoundException,
  InvalidCustomerException,
  InvalidPhoneException,
} from './exceptions/crm.exceptions';
import { PointsPerCurrencyStrategy } from './loyalty/points-per-currency.strategy';

const TENANT = 'tenant-1';

function customer(overrides: Partial<CustomerRow> = {}): CustomerRow {
  return {
    id: 'customer-1',
    tenant_id: TENANT,
    full_name: 'Asha Rai',
    phone: '9800000000',
    email: 'asha@example.test',
    created_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function account(
  overrides: Partial<LoyaltyAccountRow> = {},
): LoyaltyAccountRow {
  return {
    id: 'account-1',
    tenant_id: TENANT,
    customer_id: 'customer-1',
    points_balance: 0,
    tier: 'standard',
    updated_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

/** A connection whose only real behaviour is the transaction lifecycle. */
function connectionMock(): {
  tenantId: string;
  commit: jest.Mock;
  rollback: jest.Mock;
  release: jest.Mock;
} {
  return {
    tenantId: TENANT,
    commit: jest.fn().mockResolvedValue(undefined),
    rollback: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
  };
}

/** The same object, typed the way the service accepts it. */
function connection(): TenantScopedConnection {
  return connectionMock() as unknown as TenantScopedConnection;
}

function makeService(acquired = connectionMock()) {
  const repository = {
    findCustomerByPhone: jest.fn(),
    findCustomerById: jest.fn(),
    listCustomers: jest.fn(),
    insertCustomer: jest.fn(),
    findLoyaltyAccount: jest.fn(),
    ensureLoyaltyAccount: jest.fn(),
    creditLoyalty: jest.fn(),
    findOrderForLoyalty: jest.fn(),
    withSavepoint: jest.fn(
      (
        _connection: TenantScopedConnection,
        work: () => Promise<unknown>,
      ): Promise<unknown> => work(),
    ),
  };
  const connections = {
    acquireScoped: jest.fn().mockResolvedValue(acquired),
  };
  const service = new CrmService(
    repository as unknown as CrmRepository,
    connections as unknown as TenantConnectionService,
    new PointsPerCurrencyStrategy(),
  );
  return { service, repository, connections, acquired };
}

describe('CrmService.lookupOrCreateByPhone', () => {
  it('returns the existing customer, untouched, when the phone is known', async () => {
    const { service, repository } = makeService();
    const existing = customer({ full_name: 'Asha R.' });
    repository.findCustomerByPhone.mockResolvedValue(existing);
    repository.findLoyaltyAccount.mockResolvedValue(account());

    const result = await service.lookupOrCreateByPhone(connection(), {
      phone: ' 9800000000 ',
      fullName: 'A DIFFERENT NAME',
    });

    expect(result.created).toBe(false);
    expect(result.customer).toBe(existing);
    expect(result.loyalty?.customer_id).toBe('customer-1');
    expect(repository.insertCustomer).not.toHaveBeenCalled();
    // A lookup is not an edit: the supplied name must not overwrite the row.
    expect(existing.full_name).toBe('Asha R.');
  });

  it('creates the customer and their loyalty account when the phone is new', async () => {
    const { service, repository } = makeService();
    repository.findCustomerByPhone.mockResolvedValue(null);
    repository.insertCustomer.mockResolvedValue(customer());
    repository.ensureLoyaltyAccount.mockResolvedValue(account());

    const result = await service.lookupOrCreateByPhone(connection(), {
      phone: '9800000000',
      fullName: '  Asha Rai  ',
      email: ' asha@example.test ',
    });

    expect(result.created).toBe(true);
    expect(repository.insertCustomer).toHaveBeenCalledWith(expect.anything(), {
      phone: '9800000000',
      fullName: 'Asha Rai',
      email: 'asha@example.test',
    });
    expect(repository.ensureLoyaltyAccount).toHaveBeenCalledWith(
      expect.anything(),
      'customer-1',
    );
  });

  it('stores an omitted name and email as null', async () => {
    const { service, repository } = makeService();
    repository.findCustomerByPhone.mockResolvedValue(null);
    repository.insertCustomer.mockResolvedValue(customer());
    repository.ensureLoyaltyAccount.mockResolvedValue(account());

    await service.lookupOrCreateByPhone(connection(), { phone: '9800000000' });

    expect(repository.insertCustomer).toHaveBeenCalledWith(expect.anything(), {
      phone: '9800000000',
      fullName: null,
      email: null,
    });
  });

  it('returns the winner of an insert race instead of a 500', async () => {
    const { service, repository } = makeService();
    repository.findCustomerByPhone
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(customer());
    repository.insertCustomer.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505' }),
    );
    repository.findLoyaltyAccount.mockResolvedValue(account());

    const result = await service.lookupOrCreateByPhone(connection(), {
      phone: '9800000000',
    });

    expect(result.created).toBe(false);
    expect(result.customer.id).toBe('customer-1');
  });

  it('rethrows a non-unique insert failure', async () => {
    const { service, repository } = makeService();
    repository.findCustomerByPhone.mockResolvedValue(null);
    repository.insertCustomer.mockRejectedValue(new Error('connection lost'));

    await expect(
      service.lookupOrCreateByPhone(connection(), { phone: '9800000000' }),
    ).rejects.toThrow('connection lost');
  });

  it('rejects an empty or over-long phone', async () => {
    const { service } = makeService();

    await expect(
      service.lookupOrCreateByPhone(connection(), { phone: '   ' }),
    ).rejects.toThrow(InvalidPhoneException);
    await expect(
      service.lookupOrCreateByPhone(connection(), { phone: '1'.repeat(31) }),
    ).rejects.toThrow(InvalidPhoneException);
  });

  it('rejects a malformed email rather than storing it', async () => {
    const { service } = makeService();

    await expect(
      service.lookupOrCreateByPhone(connection(), {
        phone: '9800000000',
        email: 'not-an-email',
      }),
    ).rejects.toThrow(InvalidCustomerException);
  });
});

describe('CrmService reads', () => {
  it('returns the customer with their loyalty account', async () => {
    const { service, repository } = makeService();
    repository.findCustomerById.mockResolvedValue(customer());
    repository.findLoyaltyAccount.mockResolvedValue(account());

    const profile = await service.getCustomer(connection(), 'customer-1');

    expect(profile.customer.id).toBe('customer-1');
    expect(profile.loyalty?.points_balance).toBe(0);
  });

  it('404s an unknown customer', async () => {
    const { service, repository } = makeService();
    repository.findCustomerById.mockResolvedValue(null);

    await expect(service.getCustomer(connection(), 'missing')).rejects.toThrow(
      CustomerNotFoundException,
    );
  });

  it('creates a missing loyalty account on read', async () => {
    const { service, repository } = makeService();
    repository.findCustomerById.mockResolvedValue(customer());
    repository.ensureLoyaltyAccount.mockResolvedValue(account());

    const loyalty = await service.getLoyalty(connection(), 'customer-1');

    expect(loyalty.customer_id).toBe('customer-1');
    expect(repository.ensureLoyaltyAccount).toHaveBeenCalled();
  });

  it('looks a customer up by phone, or 404s', async () => {
    const { service, repository } = makeService();
    repository.findCustomerByPhone.mockResolvedValue(null);

    await expect(
      service.listCustomers(connection(), { phone: '9800000000' }),
    ).rejects.toThrow(CustomerNotFoundException);
  });
});

describe('CrmService.awardForPaidOrder', () => {
  it('awards points once, from the order total', async () => {
    const { service, repository, acquired } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue({
      customer_id: 'customer-1',
      total_amount: '250.50',
    });
    repository.creditLoyalty.mockResolvedValue({
      credited: true,
      account: account({ points_balance: 2 }),
    });

    const outcome = await service.awardForPaidOrder(TENANT, 'order-1');

    expect(outcome).toMatchObject({
      credited: true,
      points: 2,
      customerId: 'customer-1',
      orderId: 'order-1',
    });
    expect(repository.creditLoyalty).toHaveBeenCalledWith(expect.anything(), {
      orderId: 'order-1',
      customerId: 'customer-1',
      points: 2,
    });
    expect(acquired.commit).toHaveBeenCalled();
    expect(acquired.release).toHaveBeenCalled();
  });

  it('reports a duplicate delivery without awarding again', async () => {
    const { service, repository } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue({
      customer_id: 'customer-1',
      total_amount: '250.50',
    });
    repository.creditLoyalty.mockResolvedValue({
      credited: false,
      account: account({ points_balance: 2 }),
    });

    const outcome = await service.awardForPaidOrder(TENANT, 'order-1');

    expect(outcome).toMatchObject({
      credited: false,
      reason: 'duplicate',
      points: 0,
      customerId: 'customer-1',
    });
  });

  it('does nothing for an order with no customer', async () => {
    const { service, repository } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue({
      customer_id: null,
      total_amount: '250.50',
    });

    const outcome = await service.awardForPaidOrder(TENANT, 'order-1');

    expect(outcome).toMatchObject({ credited: false, reason: 'no_customer' });
    expect(repository.creditLoyalty).not.toHaveBeenCalled();
  });

  it('does nothing for an order it cannot see', async () => {
    const { service, repository } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue(null);

    const outcome = await service.awardForPaidOrder(TENANT, 'order-1');

    expect(outcome).toMatchObject({
      credited: false,
      reason: 'order_not_found',
    });
  });

  it('rolls back and rethrows when a write fails', async () => {
    const { service, repository, acquired } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue({
      customer_id: 'customer-1',
      total_amount: '100.00',
    });
    repository.creditLoyalty.mockRejectedValue(new Error('disk full'));

    await expect(service.awardForPaidOrder(TENANT, 'order-1')).rejects.toThrow(
      'disk full',
    );
    expect(acquired.rollback).toHaveBeenCalled();
    expect(acquired.release).toHaveBeenCalled();
  });

  it('records a zero-point credit rather than skipping the order', async () => {
    const { service, repository } = makeService();
    repository.findOrderForLoyalty.mockResolvedValue({
      customer_id: 'customer-1',
      total_amount: '50.00',
    });
    repository.creditLoyalty.mockResolvedValue({
      credited: true,
      account: account(),
    });

    const outcome = await service.awardForPaidOrder(TENANT, 'order-1');

    expect(outcome).toMatchObject({ credited: true, points: 0 });
    expect(repository.creditLoyalty).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ points: 0 }),
    );
  });
});
