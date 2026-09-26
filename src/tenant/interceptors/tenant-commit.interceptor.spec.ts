import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import type { Observable } from 'rxjs';
import type { TenantScopedConnection } from '../connection/tenant-scoped-connection';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';
import { TenantCommitInterceptor } from './tenant-commit.interceptor';

/** Lets pending microtasks and already-resolved promises run. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The invariant under test: the tenant transaction is finished BEFORE the
 * response reaches Nest, so a client that acts on the response cannot read
 * pre-commit state on its next request.
 *
 * Asserted by ordering, not by timing. The original bug was a real race, and a
 * test that tries to reproduce a race fails one run in three and gets ignored the
 * other times. Here `release()` is a promise the test controls, so "the commit
 * finished first" is checked directly and every time.
 */
describe('TenantCommitInterceptor', () => {
  let releaseCalls: number;
  let resolveRelease: () => void;
  let rejectRelease: (error: Error) => void;

  const connection = {
    release: jest.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          releaseCalls += 1;
          resolveRelease = resolve;
          rejectRelease = reject;
        }),
    ),
  } as unknown as TenantScopedConnection;

  const interceptor = new TenantCommitInterceptor();

  beforeEach(() => {
    releaseCalls = 0;
    resolveRelease = () => undefined;
    rejectRelease = () => undefined;
  });

  function httpContext(
    tenantConnection: TenantScopedConnection | undefined,
  ): ExecutionContext {
    const request = { tenantConnection } as unknown as RequestWithTenant;
    return {
      getType: () => 'http',
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  }

  function handler(value: unknown): CallHandler {
    return { handle: () => of(value) };
  }

  /**
   * Starts `intercept` and waits until it has reached the commit.
   *
   * Deliberately does NOT await `intercept`: the whole point is that `intercept`
   * cannot finish while the commit is outstanding, so the test has to hold the
   * commit open and inspect the state in between.
   */
  async function interceptWithPendingCommit(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<{ pending: Promise<Observable<unknown>> }> {
    const pending = interceptor.intercept(context, next);
    await flush();
    await flush();
    expect(releaseCalls).toBe(1);
    // Wrapped, not returned bare: an `async` function awaits whatever it
    // returns, which would deadlock on the very commit this test holds open.
    return { pending };
  }

  it('does not produce the response until the commit has resolved', async () => {
    const { pending } = await interceptWithPendingCommit(
      httpContext(connection),
      handler({ ok: true }),
    );

    // The handler has resolved but the commit is still outstanding: `intercept`
    // must not have handed anything back, or the 200 goes out ahead of the
    // COMMIT and the client's next request can read the old row.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    resolveRelease();
    const stream$ = await pending;
    await expect(lastValueFrom(stream$)).resolves.toEqual({ ok: true });
  });

  it('still commits when the handler throws, and rethrows the error', async () => {
    // A failed request owns an open transaction too; leaving it would leak a
    // pooled connection and pin `app.tenant_id` onto whatever borrows it next.
    const failure = new Error('handler exploded');
    const { pending } = await interceptWithPendingCommit(
      httpContext(connection),
      { handle: () => throwError(() => failure) },
    );

    resolveRelease();
    await expect(pending).rejects.toBe(failure);
  });

  it('reports a successful response even if the commit fails', async () => {
    // The handler already decided this was a 200. Turning it into a 500 here
    // would report a failure for a write that may well have landed.
    const { pending } = await interceptWithPendingCommit(
      httpContext(connection),
      handler('body'),
    );

    rejectRelease(new Error('connection lost'));
    const stream$ = await pending;
    await expect(lastValueFrom(stream$)).resolves.toBe('body');
  });

  it('passes through a handler that emits nothing, without erroring', async () => {
    // Guards the `toArray()` choice: a legitimately empty response must arrive
    // as "no values, completed" rather than as an `EmptyError` that Nest would
    // turn into a 500.
    const { pending } = await interceptWithPendingCommit(
      httpContext(connection),
      { handle: () => of() },
    );

    resolveRelease();
    const stream$ = await pending;
    const seen: unknown[] = [];
    let error: unknown;
    let completed = false;
    stream$.subscribe({
      next: (value) => seen.push(value),
      error: (failure: unknown) => {
        error = failure;
      },
      complete: () => {
        completed = true;
      },
    });
    await flush();

    expect(seen).toEqual([]);
    expect(error).toBeUndefined();
    expect(completed).toBe(true);
  });

  it('does nothing for a request with no tenant connection', async () => {
    // e.g. a controller excluded from the middleware: there is no transaction
    // to end, and inventing one would be wrong.
    await expect(
      lastValueFrom(
        await interceptor.intercept(httpContext(undefined), handler(1)),
      ),
    ).resolves.toBe(1);
    expect(releaseCalls).toBe(0);
  });

  it('does nothing for a non-HTTP execution context', async () => {
    // Registered globally, so it also sees WebSocket traffic.
    const context = {
      getType: () => 'ws',
      switchToHttp: () => ({
        getRequest: () => ({ tenantConnection: connection }),
      }),
    } as unknown as ExecutionContext;

    await expect(
      lastValueFrom(await interceptor.intercept(context, handler('x'))),
    ).resolves.toBe('x');
    expect(releaseCalls).toBe(0);
  });
});
