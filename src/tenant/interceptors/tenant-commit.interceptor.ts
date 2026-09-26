import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { from, lastValueFrom, toArray } from 'rxjs';
import type { TenantScopedConnection } from '../connection/tenant-scoped-connection';
import type { RequestWithTenant } from '../interfaces/tenant-request.interface';

/**
 * Ends the tenant transaction BEFORE the response is written.
 *
 * ## Why this exists
 *
 * `TenantContextMiddleware` can only release the connection from the response's
 * `finish`/`close` events, and both fire *after* the bytes are on the wire. That
 * made the commit fire-and-forget relative to the client: a `200` could reach
 * the caller while the `COMMIT` was still in flight, so the caller's very next
 * request — on a different pooled connection — could read pre-commit state.
 *
 * It is not theoretical. A KDS-style client walking an order along its lifecycle
 * (`confirmed -> preparing -> ready -> served -> awaiting_payment -> paid`) saw
 * an intermittent `400 cannot move from 'served' to 'paid'`: the
 * `awaiting_payment` hop was acknowledged, and the `paid` hop then read a status
 * the server had already changed. The write was never lost — the acknowledgement
 * simply outran it, in roughly one run in three. That is exactly the shape of bug
 * that gets filed as "flaky test" and then ships.
 *
 * Interceptors run inside the handler promise, which Nest resolves *before* it
 * serialises the reply, so awaiting the release here puts the `COMMIT` on the
 * critical path in the right order:
 *
 * ```
 *   handler returns -> interceptor awaits COMMIT -> Nest writes 200
 * ```
 *
 * Two properties this deliberately preserves:
 *
 *  - The commit outcome does NOT change the response. A request that fails after
 *    a partial write is still committed, exactly as before; this fixes *when* the
 *    commit lands, not *whether* it happens. Making a failed request roll back
 *    is a separate and much larger change.
 *  - Handler errors are rethrown untouched, so exception filters and status
 *    codes behave exactly as they did.
 *
 * The middleware keeps its `finish`/`close` release as a safety net for requests
 * that never reach here (a filter that short-circuits, a client that hangs up
 * mid-response). `TenantScopedConnection.finish()` ignores an already-released
 * connection, so the two paths cannot double-commit.
 */
@Injectable()
export class TenantCommitInterceptor implements NestInterceptor {
  private readonly logger = new Logger(TenantCommitInterceptor.name);

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    // Only HTTP requests carry a tenant connection. Staying a no-op for other
    // execution contexts (e.g. WebSockets) keeps this safe to register globally.
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<RequestWithTenant>();
    const connection = request.tenantConnection;
    if (!connection) {
      return next.handle();
    }

    let values: unknown[];
    try {
      // `toArray()` rather than a bare `lastValueFrom`: a handler that emits
      // nothing (an empty body) must resolve to `[]`, not throw `EmptyError` and
      // turn a legitimate empty response into a 500.
      values = await lastValueFrom(next.handle().pipe(toArray()));
    } finally {
      // Runs on the error path too, so a failed request still ends its
      // transaction before its error response is written.
      await this.settle(connection);
    }
    return from(values);
  }

  /**
   * Commits, and swallows a commit failure. The response has already been
   * decided by the handler, so there is nothing useful to do with a commit error
   * here except record it — failing the request now would report a 200 as a 500
   * for a write that may well have landed.
   */
  private async settle(connection: TenantScopedConnection): Promise<void> {
    try {
      await connection.release();
    } catch (error) {
      this.logger.error(
        `Failed to commit the tenant transaction: ${String(error)}`,
      );
    }
  }
}
