import type { Pool } from 'pg';
import { runMigrationCommand } from './migrate';

/**
 * A pool that answers the runner's queries with "nothing is applied yet".
 */
function fakePool(): { pool: Pool; statements: string[] } {
  const statements: string[] = [];
  const client = {
    query: (sql: string): Promise<{ rows: unknown[] }> => {
      statements.push(sql);
      return Promise.resolve({ rows: [] });
    },
    release: (): void => undefined,
  };
  const pool = {
    connect: (): Promise<typeof client> => Promise.resolve(client),
    end: (): Promise<void> => Promise.resolve(),
  } as unknown as Pool;
  return { pool, statements };
}

describe('runMigrationCommand', () => {
  it('applies the pending migrations and reports what it did', async () => {
    const { pool, statements } = fakePool();
    const lines: string[] = [];

    const report = await runMigrationCommand({
      pool,
      log: (message) => lines.push(message),
    });

    // Every migration in db/migrations is pending against an empty schema.
    expect(report.applied.length).toBeGreaterThan(0);
    expect(report.baselined).toEqual([]);
    expect(lines.some((line) => line.includes('applied'))).toBe(true);
    expect(statements[0]).toContain('schema_migrations');
  });

  it('does not close a pool it was given', async () => {
    const { pool } = fakePool();
    const end = jest.spyOn(pool, 'end');

    await runMigrationCommand({ pool, log: () => undefined });

    expect(end).not.toHaveBeenCalled();
  });
});
