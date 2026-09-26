import { BadRequestException } from '@nestjs/common';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { SlugAlreadyTakenException } from './exceptions/slug-already-taken.exception';
import { TenantOnboardingBuilder } from './tenant-onboarding.builder';

const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const B1 = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1';
const PLAN = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';

function queryCalls(connection: TenantScopedConnection): unknown[][] {
  return (connection as unknown as { query: { mock: { calls: unknown[][] } } })
    .query.mock.calls;
}

function makeConnection(impl?: {
  tenantId?: string;
  branchId?: string;
  ownerId?: string;
  tableIds?: string[];
  forceError?: { at: string; error: Error };
}): TenantScopedConnection {
  let tableIndex = 0;
  const queryImpl = (text: string): { rows: unknown[]; rowCount: number } => {
    const sql = text.replace(/\s+/g, ' ').trim();

    if (impl?.forceError && sql.includes(impl.forceError.at)) {
      throw impl.forceError.error;
    }

    if (
      sql.startsWith('BEGIN') ||
      sql.startsWith('COMMIT') ||
      sql.startsWith('ROLLBACK')
    ) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes("set_config('app.tenant_id'")) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('SELECT id FROM tenants WHERE slug')) {
      return { rows: [], rowCount: 0 };
    }

    if (sql.includes('SELECT id FROM plans')) {
      return { rows: [{ id: PLAN }], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO tenants')) {
      return { rows: [{ id: impl?.tenantId ?? T1 }], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO branches')) {
      return { rows: [{ id: impl?.branchId ?? B1 }], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO tables')) {
      const id = impl?.tableIds?.[tableIndex] ?? `table-${tableIndex + 1}`;
      tableIndex += 1;
      return { rows: [{ id }], rowCount: 1 };
    }

    if (sql.includes('INSERT INTO users')) {
      return { rows: [{ id: impl?.ownerId ?? OWNER }], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  };

  return {
    query: jest.fn().mockImplementation(queryImpl),
  } as unknown as TenantScopedConnection;
}

function sqlText(call: unknown[] | undefined): string {
  return (call?.[0] as string).replace(/\s+/g, ' ').trim();
}

describe('TenantOnboardingBuilder', () => {
  it('creates tenant + branch + tables + owner in a single COMMIT', async () => {
    const connection = makeConnection({ tableIds: ['t1', 't2', 't3'] });

    const result = await new TenantOnboardingBuilder(connection)
      .withOrgDetails('Bean House', 'beanhouse')
      .withPlan(PLAN)
      .withFirstBranch('Brunch St', '123 Main')
      .withDefaultTables(3)
      .withOwnerAccount('owner@cafe.test', 'pwHash')
      .build();

    expect(result).toEqual({
      tenantId: T1,
      slug: 'beanhouse',
      branchId: B1,
      tableIds: ['t1', 't2', 't3'],
      ownerUserId: OWNER,
    });

    const calls = queryCalls(connection).map(sqlText);
    expect(calls[0]).toBe('BEGIN');
    expect(calls.some((s) => s.includes('set_config'))).toBe(true);
    expect(calls[calls.length - 1]).toBe('COMMIT');
  });

  it('rolls back and throws SlugAlreadyTakenException when slug is already taken', async () => {
    const q = jest.fn((text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('SELECT id FROM tenants WHERE slug')) {
        return { rows: [{ id: 'existing' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const connection = { query: q } as unknown as TenantScopedConnection;

    await expect(
      new TenantOnboardingBuilder(connection)
        .withOrgDetails('Bean House', 'beanhouse')
        .withFirstBranch('Brunch St')
        .withOwnerAccount('owner@cafe.test', 'pwHash')
        .build(),
    ).rejects.toBeInstanceOf(SlugAlreadyTakenException);

    const calls = queryCalls(connection).map(sqlText);
    expect(calls[0]).toBe('BEGIN');
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('rolls back on a DB error partway through the chain', async () => {
    const connection = makeConnection({
      forceError: {
        at: 'INSERT INTO users',
        error: Object.assign(new Error('DB failure'), { code: '23505' }),
      },
    });

    await expect(
      new TenantOnboardingBuilder(connection)
        .withOrgDetails('Bean House', 'beanhouse')
        .withPlan(PLAN)
        .withFirstBranch('Brunch St')
        .withDefaultTables(1)
        .withOwnerAccount('owner@cafe.test', 'pwHash')
        .build(),
    ).rejects.toThrow('DB failure');

    const calls = queryCalls(connection).map(sqlText);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('rejects an unknown plan before any inserts', async () => {
    const q = jest.fn((text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('SELECT id FROM plans')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    const connection = { query: q } as unknown as TenantScopedConnection;

    await expect(
      new TenantOnboardingBuilder(connection)
        .withOrgDetails('Bean House', 'beanhouse')
        .withPlan('dead-plan-id')
        .withFirstBranch('Brunch St')
        .withOwnerAccount('owner@cafe.test', 'pwHash')
        .build(),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects an incomplete builder before touching the database', async () => {
    const connection = makeConnection();

    await expect(
      new TenantOnboardingBuilder(connection)
        .withOrgDetails('Bean House', 'beanhouse')
        .build(),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(queryCalls(connection)).toHaveLength(0);
  });

  it('treats negative default tables as zero', async () => {
    const connection = makeConnection();
    const result = await new TenantOnboardingBuilder(connection)
      .withOrgDetails('Bean House', 'beanhouse')
      .withFirstBranch('Brunch St')
      .withDefaultTables(-5)
      .withOwnerAccount('owner@cafe.test', 'pwHash')
      .build();

    expect(result.tableIds).toEqual([]);
    const tableInserts = queryCalls(connection).filter(([text]) =>
      (text as string).includes('INSERT INTO tables'),
    );
    expect(tableInserts).toHaveLength(0);
  });

  it('sets app.tenant_id via set_config for tenant-owned inserts', async () => {
    const connection = makeConnection();

    await new TenantOnboardingBuilder(connection)
      .withOrgDetails('Bean House', 'beanhouse')
      .withFirstBranch('Brunch St')
      .withOwnerAccount('owner@cafe.test', 'pwHash')
      .build();

    const setConfigCall = queryCalls(connection).find(([text]) =>
      (text as string).includes("set_config('app.tenant_id'"),
    );
    expect(setConfigCall).toBeDefined();
    expect(setConfigCall?.[1]).toEqual([T1]);
  });
});
