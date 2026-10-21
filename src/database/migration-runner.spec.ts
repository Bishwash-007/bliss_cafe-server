import {
  checksumOf,
  MigrationRunner,
  parseMarkers,
  type MigrationClient,
  type MigrationFile,
} from './migration-runner';

/**
 * A fake client that answers the runner's introspection queries from a set of
 * "objects that exist", and records everything it is asked to do.
 */
class FakeClient implements MigrationClient {
  readonly statements: string[] = [];
  readonly ledger = new Map<string, string>();
  readonly existing = new Set<string>();

  query(
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.statements.push(sql.trim());

    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) {
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('FROM schema_migrations')) {
      return Promise.resolve({
        rows: [...this.ledger.entries()].map(([filename, checksum]) => ({
          filename,
          checksum,
        })),
      });
    }
    if (sql.includes('INSERT INTO schema_migrations')) {
      const [filename, checksum] = values as [string, string];
      this.ledger.set(filename, checksum);
      return Promise.resolve({ rows: [] });
    }
    if (sql.includes('AS exists')) {
      // The runner asks one question per marker; the parameters identify what
      // it is asking about.
      const key = values
        ?.map((value) => String(value))
        .join('.')
        .toLowerCase();
      return Promise.resolve({
        rows: [{ exists: this.existing.has(key ?? '') }],
      });
    }
    return Promise.resolve({ rows: [] });
  }
}

const SQL = `
  CREATE TABLE widgets (
    id UUID PRIMARY KEY
  );
  CREATE UNIQUE INDEX widgets_id_idx ON widgets(id);
`;

function file(name: string, sql: string): MigrationFile {
  return {
    name,
    sql,
    checksum: checksumOf(sql),
    markers: parseMarkers(sql),
  };
}

describe('parseMarkers', () => {
  it('finds the tables, indexes, columns and policies a migration creates', () => {
    const markers = parseMarkers(`
      CREATE TABLE widgets (
        id UUID PRIMARY KEY
      );
      CREATE UNIQUE INDEX widgets_id_idx ON widgets(id);
      ALTER TABLE widgets ADD COLUMN label TEXT;
      CREATE POLICY widgets_isolation ON widgets USING (true);
      CREATE EXTENSION IF NOT EXISTS "pgcrypto";
    `);

    expect(markers).toEqual([
      { kind: 'table', name: 'widgets' },
      { kind: 'index', name: 'widgets_id_idx' },
      { kind: 'column', table: 'widgets', name: 'label' },
      { kind: 'policy', name: 'widgets_isolation', table: 'widgets' },
      { kind: 'extension', name: 'pgcrypto' },
    ]);
  });

  it('finds every column of a multi-column ALTER', () => {
    const markers = parseMarkers(`
      ALTER TABLE customers
          ADD COLUMN notification_opt_out BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN notification_channel VARCHAR(20);
    `);

    expect(markers).toEqual([
      { kind: 'column', table: 'customers', name: 'notification_opt_out' },
      { kind: 'column', table: 'customers', name: 'notification_channel' },
    ]);
  });

  it('finds the tables of a row-level-security migration', () => {
    const markers = parseMarkers(`
      ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
    `);

    expect(markers).toEqual([{ kind: 'rls', table: 'orders' }]);
  });

  it('reports nothing for a migration whose objects are created dynamically', () => {
    const markers = parseMarkers(`
      DO $$
      BEGIN
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
      END $$;
    `);

    expect(markers).toEqual([]);
  });

  it('ignores commented-out statements', () => {
    const markers = parseMarkers(`
      -- CREATE TABLE commented_out (id UUID);
      CREATE TABLE real_table (id UUID);
    `);

    expect(markers).toEqual([{ kind: 'table', name: 'real_table' }]);
  });
});

describe('MigrationRunner', () => {
  let client: FakeClient;

  beforeEach(() => {
    client = new FakeClient();
  });

  it('applies a migration that has not run yet, and records it', async () => {
    const runner = new MigrationRunner(client);

    const report = await runner.run([file('001_widgets.sql', SQL)]);

    expect(report.applied).toEqual(['001_widgets.sql']);
    expect(client.ledger.get('001_widgets.sql')).toBe(checksumOf(SQL));
    expect(client.statements).toContain('BEGIN');
    expect(client.statements).toContain(SQL.trim());
    expect(client.statements).toContain('COMMIT');
  });

  it('skips a migration the ledger already knows', async () => {
    const migration = file('001_widgets.sql', SQL);
    client.ledger.set(migration.name, migration.checksum);
    const runner = new MigrationRunner(client);

    const report = await runner.run([migration]);

    expect(report.skipped).toEqual(['001_widgets.sql']);
    expect(report.applied).toEqual([]);
    expect(client.statements).not.toContain(SQL.trim());
  });

  it('refuses to run when an applied migration has changed', async () => {
    const migration = file('001_widgets.sql', SQL);
    client.ledger.set(migration.name, 'a-different-checksum');
    const runner = new MigrationRunner(client);

    await expect(runner.run([migration])).rejects.toThrow(/has changed/);
  });

  it('accepts a changed migration when the operator allows it', async () => {
    const migration = file('001_widgets.sql', SQL);
    client.ledger.set(migration.name, 'a-different-checksum');
    const runner = new MigrationRunner(client, {
      allowChecksumDrift: true,
    });

    const report = await runner.run([migration]);

    expect(report.skipped).toEqual(['001_widgets.sql']);
    expect(client.ledger.get(migration.name)).toBe(migration.checksum);
  });

  it('baselines a migration whose objects are already in the schema', async () => {
    // A database created by the old initdb mount has the tables but no ledger.
    client.existing.add('widgets');
    client.existing.add('widgets_id_idx');
    const runner = new MigrationRunner(client);

    const report = await runner.run([file('001_widgets.sql', SQL)]);

    expect(report.baselined).toEqual(['001_widgets.sql']);
    expect(client.ledger.get('001_widgets.sql')).toBe(checksumOf(SQL));
    expect(client.statements).not.toContain(SQL.trim());
  });

  it('refuses to guess when only some of the objects are there', async () => {
    client.existing.add('widgets');
    const runner = new MigrationRunner(client);

    await expect(runner.run([file('001_widgets.sql', SQL)])).rejects.toThrow(
      /only partly applied/,
    );
  });

  it('rolls back a migration that fails', async () => {
    const broken = 'CREATE TABLE broken (id UUID PRIMARY KEY); -- boom';
    const failing: MigrationClient = {
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('boom')) {
          throw new Error('syntax error');
        }
        return client.query(sql, values);
      },
    };
    const runner = new MigrationRunner(failing);

    await expect(runner.run([file('002_broken.sql', broken)])).rejects.toThrow(
      /002_broken\.sql failed/,
    );

    expect(client.statements).toContain('ROLLBACK');
    expect(client.ledger.has('002_broken.sql')).toBe(false);
  });
});
