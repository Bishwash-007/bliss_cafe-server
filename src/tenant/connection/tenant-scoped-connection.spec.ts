import type { Pool, PoolClient } from 'pg';
import { TenantScopedConnection } from './tenant-scoped-connection';

interface FakePostgresState {
  sql: string[];
  released: boolean;
  session: Record<string, string>;
  failOn: (sql: string) => boolean;
}

interface FakeClient {
  client: PoolClient & { state: FakePostgresState };
  state: FakePostgresState;
  query: jest.Mock;
  release: jest.Mock;
}

function createFakeClient(overrides?: Partial<FakePostgresState>): FakeClient {
  const state: FakePostgresState = {
    sql: [],
    released: false,
    session: {},
    failOn: () => false,
    ...overrides,
  };

  const query = jest.fn((text: string, values?: unknown[]) => {
    state.sql.push(text);

    if (state.failOn(text)) {
      throw new Error(`failed: ${text}`);
    }

    if (
      text.includes('app.tenant_id') &&
      Array.isArray(values) &&
      values.length > 0
    ) {
      state.session['app.tenant_id'] = String(values[0]);
    }

    return {
      rows: [],
      rowCount: 0,
      command: 'SELECT',
      fields: [],
    };
  });

  const release = jest.fn((error?: unknown) => {
    state.released = true;
    if (error) {
      throw error as Error;
    }
  });

  const client = { state, query, release } as unknown as PoolClient & {
    state: FakePostgresState;
  };

  return { client, state, query, release };
}

function createFakePool(client: PoolClient): Pool {
  return { connect: jest.fn(() => client) } as unknown as Pool;
}

const TENANT_ID = '8f14e45f-0000-4000-8000-000000000001';

describe('TenantScopedConnection', () => {
  it('starts a transaction and sets the tenant before any repository query', async () => {
    const { client, state, query } = createFakeClient();
    const pool = createFakePool(client);

    const connection = await TenantScopedConnection.acquireScoped(
      pool,
      TENANT_ID,
    );
    await connection.query('SELECT * FROM orders');

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('app.tenant_id', $1, true)",
      [TENANT_ID],
    );
    expect(state.sql).toEqual([
      'BEGIN',
      "SELECT set_config('app.tenant_id', $1, true)",
      'SELECT * FROM orders',
    ]);
    expect(state.session['app.tenant_id']).toBe(TENANT_ID);
  });

  it('releases the client with a COMMIT and flips the released flag', async () => {
    const { client, state, query } = createFakeClient();
    const connection = await TenantScopedConnection.acquireScoped(
      createFakePool(client),
      TENANT_ID,
    );

    await connection.release();

    expect(query).toHaveBeenCalledWith('COMMIT');
    expect(state.released).toBe(true);
    expect(connection.isReleased).toBe(true);
  });

  it('release() is idempotent', async () => {
    const { client, state, release } = createFakeClient();
    const connection = await TenantScopedConnection.acquireScoped(
      createFakePool(client),
      TENANT_ID,
    );

    await connection.release();
    await connection.release();

    expect(release).toHaveBeenCalledTimes(1);
    expect(state.sql).toEqual([
      'BEGIN',
      "SELECT set_config('app.tenant_id', $1, true)",
      'COMMIT',
    ]);
    expect(connection.isReleased).toBe(true);
  });

  it('rolls back and releases on rollback()', async () => {
    const { client, state, query } = createFakeClient();
    const connection = await TenantScopedConnection.acquireScoped(
      createFakePool(client),
      TENANT_ID,
    );

    await connection.rollback();

    expect(query).toHaveBeenCalledWith('ROLLBACK');
    expect(state.released).toBe(true);
    expect(connection.isReleased).toBe(true);
  });

  it('releases the client and rejects when scoping fails', async () => {
    const { client, state, release } = createFakeClient({
      failOn: (sql) => sql.includes('app.tenant_id'),
    });
    const pool = createFakePool(client);

    await expect(
      TenantScopedConnection.acquireScoped(pool, TENANT_ID),
    ).rejects.toThrow("failed: SELECT set_config('app.tenant_id', $1, true)");

    expect(release).toHaveBeenCalled();
    expect(state.released).toBe(true);
  });

  it('acquireUnscoped never sets app.tenant_id', async () => {
    const { client, state, query } = createFakeClient();
    const connection = await TenantScopedConnection.acquireUnscoped(
      createFakePool(client),
    );

    await connection.query('SELECT * FROM tenants');

    expect(state.sql).toEqual(['SELECT * FROM tenants']);
    expect(state.session['app.tenant_id']).toBeUndefined();

    await connection.release();
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('exposes only the wrapped query API to repository code', async () => {
    const { client, state } = createFakeClient();
    const connection = await TenantScopedConnection.acquireScoped(
      createFakePool(client),
      TENANT_ID,
    );

    // Repository code sees a query()-driven interface (the proxy), not the
    // raw PoolClient that would let it bypass the tenant-scoped transaction.
    const result = await connection.query('SELECT * FROM orders');
    expect(result).toBeDefined();
    expect(state.sql).toContain('SELECT * FROM orders');
    expect(
      (connection as unknown as Record<string, unknown>)['client'],
    ).toBeUndefined();
  });

  /**
   * `onCommit` is what lets the domain event bus keep its promise to subscribers
   * that the row is already readable. These tests pin the three properties the
   * order module depends on: nothing early, nothing on rollback, no leaks.
   */
  describe('onCommit', () => {
    const acquire = async () => {
      const { client, query, release } = createFakeClient();
      const connection = await TenantScopedConnection.acquireScoped(
        createFakePool(client),
        TENANT_ID,
      );
      return { connection, query, release };
    };

    it('does not run the callback before the transaction commits', async () => {
      const { connection } = await acquire();
      const callback = jest.fn();

      connection.onCommit(callback);

      expect(callback).not.toHaveBeenCalled();
      await connection.commit();
    });

    it('runs the callback after a successful commit', async () => {
      const { connection, query } = await acquire();
      const callback = jest.fn();

      connection.onCommit(callback);
      await connection.commit();

      expect(query).toHaveBeenCalledWith('COMMIT');
      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('runs callbacks in registration order', async () => {
      const { connection } = await acquire();
      const seen: number[] = [];

      connection.onCommit(() => seen.push(1));
      connection.onCommit(() => seen.push(2));
      connection.onCommit(() => seen.push(3));
      await connection.commit();

      expect(seen).toEqual([1, 2, 3]);
    });

    it('discards callbacks on rollback so nothing announces unwritten rows', async () => {
      const { connection, query } = await acquire();
      const callback = jest.fn();

      connection.onCommit(callback);
      await connection.rollback();

      expect(query).toHaveBeenCalledWith('ROLLBACK');
      expect(callback).not.toHaveBeenCalled();
    });

    it('discards callbacks when the COMMIT itself fails', async () => {
      const { client, release } = createFakeClient({
        failOn: (sql) => sql === 'COMMIT',
      });
      const connection = await TenantScopedConnection.acquireScoped(
        createFakePool(client),
        TENANT_ID,
      );
      const callback = jest.fn();

      connection.onCommit(callback);

      await expect(connection.commit()).rejects.toThrow('failed: COMMIT');
      expect(callback).not.toHaveBeenCalled();
      // and the client still goes back to the pool
      expect(release).toHaveBeenCalled();
    });

    it('ignores a callback registered after the transaction already ended', async () => {
      const { connection } = await acquire();
      await connection.commit();

      const callback = jest.fn();
      connection.onCommit(callback);

      expect(callback).not.toHaveBeenCalled();
    });

    it('still releases the client and runs later callbacks when one throws', async () => {
      const { connection, release } = await acquire();
      const after = jest.fn();

      connection.onCommit(() => {
        throw new Error('subscriber exploded');
      });
      connection.onCommit(after);

      await expect(connection.commit()).resolves.toBeUndefined();

      // One bad subscriber must not cost the commit, the release, or the
      // remaining subscribers.
      expect(after).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalled();
    });

    it('runs each callback at most once even if release is called twice', async () => {
      const { connection } = await acquire();
      const callback = jest.fn();

      connection.onCommit(callback);
      await connection.commit();
      await connection.release();

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });
  /**
   * One `TenantScopedConnection` wraps ONE `pg` client, and a client cannot
   * multiplex. `pg` only tolerates overlapping `query()` calls by queueing them
   * internally, which it now deprecates ("will be removed in pg@9.0") and which
   * decouples result delivery from the caller's ordering assumptions.
   *
   * Two call sites were doing `Promise.all` over one connection (the menu
   * render's four reads, and the branch plan-limit guard's two). This suite is
   * the reason that can never come back silently.
   */
  describe('statement serialisation', () => {
    /** A client that records how many statements are in flight at once. */
    function createConcurrencyProbe() {
      const state = {
        inFlight: 0,
        peak: 0,
        order: [] as string[],
        failOn: (_sql: string) => false,
      };
      const query = jest.fn(async (text: string) => {
        state.inFlight += 1;
        state.peak = Math.max(state.peak, state.inFlight);
        state.order.push(text);
        // Yield twice: a single microtask would not let a second, genuinely
        // concurrent call get in, so the probe could not detect the overlap.
        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));
        state.inFlight -= 1;
        if (state.failOn(text)) {
          throw new Error(`failed: ${text}`);
        }
        return { rows: [], rowCount: 0, command: 'SELECT', fields: [] };
      });
      const client = { query, release: jest.fn() } as unknown as PoolClient;
      return { state, client };
    }

    async function acquireProbed() {
      const probe = createConcurrencyProbe();
      const connection = await TenantScopedConnection.acquireScoped(
        createFakePool(probe.client),
        TENANT_ID,
      );
      return { connection, state: probe.state };
    }

    it('never runs two statements on the client at the same time', async () => {
      const { connection, state } = await acquireProbed();

      // Exactly the shape that used to warn: four reads "in parallel".
      await Promise.all([
        connection.query('SELECT 1'),
        connection.query('SELECT 2'),
        connection.query('SELECT 3'),
        connection.query('SELECT 4'),
      ]);

      expect(state.peak).toBe(1);
      // ...and they still run in the order they were asked for. `BEGIN` and the
      // `set_config` come from acquisition, before any caller query.
      expect(state.order.slice(2)).toEqual([
        'SELECT 1',
        'SELECT 2',
        'SELECT 3',
        'SELECT 4',
      ]);
    });

    it('keeps the queue usable after one statement fails', async () => {
      const { connection, state } = await acquireProbed();
      state.failOn = (sql) => sql === 'SELECT boom';

      await expect(connection.query('SELECT boom')).rejects.toThrow();

      // A single bad statement must not turn every later statement into the same
      // failure, which is what poisoning the chain would do.
      await expect(connection.query('SELECT fine')).resolves.toBeDefined();
    });

    it('never lets the COMMIT overtake a statement still in flight', async () => {
      const { connection, state } = await acquireProbed();

      const inFlight = connection.query('SELECT slow');
      // No await: the COMMIT is requested while the read is still running.
      const commit = connection.commit();
      await Promise.all([inFlight, commit]);

      expect(state.order[state.order.length - 1]).toBe('COMMIT');
      expect(state.peak).toBe(1);
    });
  });
});
