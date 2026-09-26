import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { InventoryRepository } from './inventory.repository';
import type { SupplierRow } from './inventory.types';

/**
 * Captures the SQL a repository method builds, so its text and its parameter
 * numbering can be asserted.
 *
 * A unit test cannot prove the statement SUCCEEDS against a real database — the
 * e2e suite does that. What it can do is pin the statement itself, which is
 * where the quiet bugs live: a column that is written when it should not be, or a
 * `$n` that does not line up with the values array. Both fail at runtime, in
 * production, and neither shows up in a mocked service test because the service
 * never sees SQL.
 */
class RecordingConnection {
  readonly statements: Array<{ text: string; values: unknown[] }> = [];
  rows: unknown[] = [];
  rowCount = 0;

  constructor(private readonly tenant: string | null) {}

  get tenantId(): string | null {
    return this.tenant;
  }

  query<R>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount: number }> {
    this.statements.push({ text, values });
    return Promise.resolve({ rows: this.rows as R[], rowCount: this.rowCount });
  }

  /** The single statement issued, asserted to be the only one. */
  get only(): { text: string; values: unknown[] } {
    expect(this.statements).toHaveLength(1);
    return this.statements[0];
  }
}

function asConnection(connection: RecordingConnection): TenantScopedConnection {
  return connection as unknown as TenantScopedConnection;
}

function supplierRow(overrides: Partial<SupplierRow> = {}): SupplierRow {
  return {
    id: 'sup-1',
    tenant_id: 'tenant-1',
    name: 'Valley Dairy',
    contact_phone: '9800000000',
    contact_email: 'orders@valleydairy.test',
    created_at: new Date(0),
    ...overrides,
  };
}

const repository = new InventoryRepository();

describe('InventoryRepository.updateSupplier', () => {
  it('writes ONLY the column that was sent', async () => {
    // The bug this pins: writing every column turns "correct my phone number"
    // into "also blank my name and email", permanently.
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [supplierRow({ contact_phone: '9800000009' })];

    await repository.updateSupplier(asConnection(connection), 'sup-1', {
      contactPhone: '9800000009',
    });

    const { text, values } = connection.only;
    expect(text).toContain('SET contact_phone = $3');
    expect(text).not.toContain('name =');
    expect(text).not.toContain('contact_email =');
    // $1/$2 are the tenant and the id, and the value is $3.
    expect(values).toEqual(['tenant-1', 'sup-1', '9800000009']);
  });

  it('numbers the placeholders in the same order as the values', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [supplierRow()];

    await repository.updateSupplier(asConnection(connection), 'sup-1', {
      contactEmail: 'new@valleydairy.test',
      name: 'Valley Creamery',
    });

    const { text, values } = connection.only;
    // name is sent first, so it is $3 and the email is $4. A mismatch here writes
    // the email into the name column with no error at all.
    expect(text).toContain('SET name = $3, contact_email = $4');
    expect(values).toEqual([
      'tenant-1',
      'sup-1',
      'Valley Creamery',
      'new@valleydairy.test',
    ]);
  });

  it('writes an explicitly null column, to CLEAR it', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [supplierRow({ contact_phone: null })];

    await repository.updateSupplier(asConnection(connection), 'sup-1', {
      contactPhone: null,
    });

    const { text, values } = connection.only;
    // Distinguishable from omitting the key, which is what makes removing a wrong
    // phone number possible as well as correcting it.
    expect(text).toContain('SET contact_phone = $3');
    expect(values).toEqual(['tenant-1', 'sup-1', null]);
    expect(connection.only.text).not.toContain('name =');
  });

  it('reads the row instead of issuing an empty UPDATE when nothing was sent', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [supplierRow()];

    const result = await repository.updateSupplier(
      asConnection(connection),
      'sup-1',
      {},
    );

    // A no-op PATCH is a no-op: one SELECT, and no UPDATE with an empty SET list,
    // which is not even valid SQL.
    expect(connection.only.text).toContain('SELECT * FROM suppliers');
    expect(connection.statements[0].text).not.toContain('UPDATE');
    expect(result?.name).toBe('Valley Dairy');
  });

  it("returns null when the supplier is not the tenant's", async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [];

    const result = await repository.updateSupplier(
      asConnection(connection),
      'sup-1',
      {
        name: 'x',
      },
    );

    // The service turns this into a 404, so another tenant's supplier is
    // indistinguishable from one that does not exist.
    expect(result).toBeNull();
  });

  it('refuses to run without a pinned tenant', async () => {
    const connection = new RecordingConnection(null);

    await expect(
      repository.updateSupplier(asConnection(connection), 'sup-1', {
        name: 'x',
      }),
    ).rejects.toThrow();
  });
});

describe('InventoryRepository.deleteSupplier', () => {
  it('reports a row as deleted', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rowCount = 1;

    await expect(
      repository.deleteSupplier(asConnection(connection), 'sup-1'),
    ).resolves.toBe(true);
    expect(connection.only.values).toEqual(['tenant-1', 'sup-1']);
  });

  it('reports nothing deleted when no row matched', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rowCount = 0;

    await expect(
      repository.deleteSupplier(asConnection(connection), 'sup-1'),
    ).resolves.toBe(false);
  });

  it('handles a driver that reports a null rowCount', async () => {
    const nullRowCount = {
      tenantId: 'tenant-1',
      query: () => Promise.resolve({ rows: [], rowCount: null }),
    } as unknown as TenantScopedConnection;

    // Must not throw on `null > 0`; treated as "nothing was deleted", which the
    // service then reports as a 404.
    await expect(
      repository.deleteSupplier(nullRowCount, 'sup-1'),
    ).resolves.toBe(false);
  });
});

describe('InventoryRepository.countItemsForSupplier', () => {
  it('counts the linked items as a number', async () => {
    const connection = new RecordingConnection('tenant-1');
    // PostgreSQL returns count(*) as text over the wire.
    connection.rows = [{ count: '3' }];

    await expect(
      repository.countItemsForSupplier(asConnection(connection), 'sup-1'),
    ).resolves.toBe(3);
    expect(connection.only.text).toContain('supplier_id = $2');
  });

  it('reports zero when the count comes back empty', async () => {
    const connection = new RecordingConnection('tenant-1');
    connection.rows = [];

    await expect(
      repository.countItemsForSupplier(asConnection(connection), 'sup-1'),
    ).resolves.toBe(0);
  });
});

describe('InventoryRepository.listDiscrepancies', () => {
  it('lists the review queue for a tenant-wide caller', async () => {
    const connection = new RecordingConnection('tenant-1');
    await repository.listDiscrepancies(asConnection(connection));
    const { text, values } = connection.only;
    expect(values).toEqual(['tenant-1']);
    // Default is "what needs fixing?", not all 40,000 settled deductions.
    expect(text).toContain("d.status IN ('failed', 'partial')");
    // The join is harmless for a tenant-wide caller but must not become an inner
    // join against a table that is not there.
    expect(text).toContain('JOIN orders o ON o.id = d.order_id');
  });

  it('filters by branch, and numbers the placeholder to match', async () => {
    const connection = new RecordingConnection('tenant-1');
    await repository.listDiscrepancies(
      asConnection(connection),
      undefined,
      'branch-a',
    );
    const { text, values } = connection.only;
    // The table has no branch_id of its own, so the filter comes through the order.
    expect(text).toContain('o.branch_id = $2');
    expect(values).toEqual(['tenant-1', 'branch-a']);
  });

  it('keeps the status and branch placeholders lined up when both are given', async () => {
    const connection = new RecordingConnection('tenant-1');
    await repository.listDiscrepancies(
      asConnection(connection),
      'failed',
      'branch-a',
    );
    const { text, values } = connection.only;
    // A hand-counted $n that drifts from the values array only fails at runtime,
    // in production, on the one query that takes both filters.
    expect(text).toContain('d.status = $2');
    expect(text).toContain('o.branch_id = $3');
    expect(values).toEqual(['tenant-1', 'failed', 'branch-a']);
  });

  it('selects the deduction columns, not the joined order row', async () => {
    const connection = new RecordingConnection('tenant-1');
    await repository.listDiscrepancies(
      asConnection(connection),
      undefined,
      'branch-a',
    );
    // `SELECT *` across the join would add the order's own columns to every row.
    expect(connection.only.text).toContain('SELECT d.*');
  });
});
