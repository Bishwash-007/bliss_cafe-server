import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Tenant-scoped database connection (Proxy pattern).
 *
 * Wraps a raw `pg.PoolClient` so that tenant-scoping is structurally
 * impossible to forget:
 *   - on acquisition a transaction is started and the RLS session variable
 *     `app.tenant_id` is pinned (via `set_config(...)`, `true` = local scope)
 *     BEFORE any repository query can run;
 *   - repository code only ever sees the wrapper (the raw client is held in a
 *     `WeakMap` and is unreachable through the wrapper) and never sets
 *     `app.tenant_id` itself;
 *   - `release()` ends the transaction (or rolls back on error), returning the
 *     client to the pool.
 *
 * Platform (`/platform/*`) routes use an "unscoped" connection — same wrapper,
 * no `app.tenant_id` set, so platform tables (with no RLS policy) keep
 * working. Any query against RLS-protected tables without the session variable
 * returns zero rows instead of leaking another tenant's data (fail-safe).
 */
export class TenantScopedConnection {
  private readonly internal = new WeakMap<
    object,
    { raw: PoolClient; released: boolean }
  >();

  private constructor() {}

  /**
   * Acquires a tenant-scoped connection: starts a transaction and pins
   * `app.tenant_id` for it, before the connection is handed to any repository.
   *
   * Uses `set_config(...)` rather than `SET LOCAL` because Postgres's `SET`
   * statement cannot take a bind parameter — this keeps the tenant id out of
   * string interpolation entirely.
   */
  static async acquireScoped(
    pool: Pool,
    tenantId: string,
  ): Promise<TenantScopedConnection> {
    const raw = await pool.connect();
    try {
      await raw.query('BEGIN');
      await raw.query("SELECT set_config('app.tenant_id', $1, true)", [
        tenantId,
      ]);
    } catch (error) {
      raw.release(error as Error);
      throw error;
    }
    return TenantScopedConnection.attach(raw);
  }

  /**
   * Acquires an unscoped connection (platform / super-admin routes). No
   * `app.tenant_id` is set; RLS-protected tables will simply return zero rows.
   */
  static async acquireUnscoped(pool: Pool): Promise<TenantScopedConnection> {
    const raw = await pool.connect();
    return TenantScopedConnection.attach(raw);
  }

  private static attach(raw: PoolClient): TenantScopedConnection {
    const instance = new TenantScopedConnection();
    instance.internal.set(instance, { raw, released: false });
    return instance;
  }

  private readonly onCommitCallbacks: Array<() => void> = [];
  private hasCommitted = false;

  /**
   * Serialises every statement issued on this connection.
   *
   * A `TenantScopedConnection` wraps exactly ONE `pg` client, and one client
   * cannot multiplex. `Promise.all([repo.find(connection), repo.find(connection)])`
   * is therefore a bug even though it reads like a harmless parallel read: `pg`
   * only tolerates it by queueing internally, which
   *
   *   - emits `Calling client.query() when the client is already executing a
   *     query is deprecated and will be removed in pg@9.0`, and
   *   - ties result delivery to a queue whose ordering is not something the
   *     caller can reason about.
   *
   * Rather than rely on every call site remembering (two were doing this, both
   * unknowingly), the invariant lives here: statements run one at a time in call
   * order, and the transaction-ending statement is queued last so it can never
   * overtake a query that is still in flight.
   */
  private statementQueue: Promise<unknown> = Promise.resolve();

  /** True once the underlying client has been fully released to the pool. */
  get isReleased(): boolean {
    return this.getState().released;
  }

  /**
   * Registers a callback that runs AFTER the connection successfully COMMITs,
   * before the client is returned to the pool. The callback runs in-process and
   * ONLY after commit — it is discarded on rollback and never runs if the
   * transaction is aborted. Callbacks are executed in registration order (FIFO),
   * one after another with the current event loop.
   *
   * This exists for the "Observer AFTER commit" guarantee: domain events should
   * fire after the database write is durable, so that subscribers reading the
   * same database from a different connection actually see the new row(s). The
   * trade-off is a small amount of in-process work after COMMIT but before the
   * HTTP response finishes; callbacks must not rely on the transaction (it is
   * already closed) and must not re-throw in a way that breaks release (errors
   * here are logged by the caller if desired, but the connection is still
   * released).
   */
  onCommit(fn: () => void): void {
    if (this.hasCommitted || this.isReleased) {
      // The transaction already ended — do not schedule an execution that was
      // meant to happen after the commit that never will.
      return;
    }
    this.onCommitCallbacks.push(fn);
  }

  /**
   * Runs a query inside the tenant-scoped transaction.
   */
  query<R extends QueryResultRow = Record<string, unknown>>(
    text: string,
    values?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>> {
    const { raw } = this.getState();
    return this.enqueue(() => raw.query<R>(text, values as never[]));
  }

  /**
   * Appends a statement to the serial queue.
   *
   * The rejection handler on both halves is deliberate: a failed statement must
   * not poison the queue for the rest of the transaction, or one bad query would
   * turn every later query into the same error.
   */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.statementQueue.then(run, run);
    this.statementQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Commits the tenant-scoped transaction and returns the client to the pool. */
  async commit(): Promise<void> {
    await this.finish('COMMIT');
  }

  /** Rolls back the tenant-scoped transaction and returns the client to the pool. */
  async rollback(): Promise<void> {
    await this.finish('ROLLBACK');
  }

  /** Alias of `commit()` — the middleware hooks this to end-of-request. */
  async release(): Promise<void> {
    await this.finish('COMMIT');
  }

  private getState(): { raw: PoolClient; released: boolean } {
    const state = this.internal.get(this);
    if (!state) {
      throw new Error('TenantScopedConnection is not attached to a client.');
    }
    return state;
  }

  private async finish(statement: 'COMMIT' | 'ROLLBACK'): Promise<void> {
    const state = this.getState();
    if (state.released) {
      return;
    }
    state.released = true;
    let commitSucceeded = false;
    try {
      // Queued, not issued directly: a `COMMIT` that overtook a still-running
      // query would close the transaction out from under it.
      await this.enqueue(() => state.raw.query(statement));
      commitSucceeded = statement === 'COMMIT';
    } finally {
      try {
        state.raw.release();
      } finally {
        if (commitSucceeded && this.onCommitCallbacks.length > 0) {
          this.hasCommitted = true;
          const callbacks = this.onCommitCallbacks.splice(0);
          for (const callback of callbacks) {
            try {
              callback();
            } catch {
              // Deferring events to after-commit is an in-process side effect;
              // a subscriber throwing must not mask the successful commit or
              // prevent releasing other resources. Swallow and move to next.
            }
          }
        } else {
          this.onCommitCallbacks.length = 0;
          this.hasCommitted = true;
        }
      }
    }
  }
}
