import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { RequestWithTenant } from '../../tenant/interfaces/tenant-request.interface';
import { BillingRepository } from '../billing.repository';
import {
  SubscriptionCancelledException,
  SubscriptionPastDueException,
} from '../exceptions/billing.exceptions';

/**
 * Paths that stay reachable whatever the subscription state is.
 *
 *  - `/auth` — a tenant that owes money must still be able to log in and read
 *    its own profile; refusing the login would only lock the owner out of the
 *    page where they would pay.
 *  - `/billing` — the subscription routes ARE the way out of `past_due`.
 *  - `/onboarding`, `/platform` — no tenant (or a platform super-admin).
 *  - `/webhooks` — a gateway retrying a callback must never be refused; the
 *    webhook handler is idempotent and settles the payment itself.
 */
const EXEMPT_PATHS = [
  '/auth',
  '/billing',
  '/onboarding',
  '/platform',
  '/webhooks',
];

/** Methods that only READ. A `past_due` tenant may still look at its data. */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * # SubscriptionAccessGuard
 *
 * A subscription state that nothing enforces is a suggestion. `past_due` and
 * `cancelled` used to live only in `tenant_subscriptions.status`: the state
 * machine refused a *plan change* for a `past_due` tenant, but every other
 * module carried on as if the tenant were in good standing, so a café that
 * had stopped paying could keep taking orders indefinitely.
 *
 * The rule this guard enforces:
 *
 *  - `cancelled` — terminal. No tenant route is served at all.
 *  - `past_due`  — read-only. The owner can look at the data, but nothing is
 *    written until the invoice is settled.
 *  - `active`, `trialing`, or no subscription at all — unrestricted.
 *
 * A tenant with NO subscription row is deliberately not gated: onboarding
 * without a plan is a supported flow, and refusing those tenants would break
 * a legitimate state rather than enforce a policy.
 *
 * ## Why the tenant is read off the request
 *
 * The tenant id and the scoped connection are put on the request by
 * `TenantContextMiddleware`, so the guard reads them from there instead of
 * injecting the request-scoped `TenantRequestContext`. That keeps the guard a
 * plain singleton: a request-scoped enhancer would have to be re-instantiated
 * for every request, and a global guard that depends on request scope is easy
 * to get subtly wrong.
 *
 * ## Why the check only runs for authenticated requests
 *
 * The guard is a *global* guard, so it runs before the route's own
 * `JwtAuthGuard`. Refusing an anonymous request here would answer "your
 * subscription is cancelled" to a caller that has not proved who they are.
 * Requests without a bearer token are therefore left to the auth guard, which
 * answers 401/404 without revealing anything about the subscription.
 */
@Injectable()
export class SubscriptionAccessGuard implements CanActivate {
  constructor(private readonly repository: BillingRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithTenant>();

    // Anonymous traffic: the route's own guard decides.
    if (!request.headers?.authorization) {
      return true;
    }

    const path = request.path ?? '';
    if (this.isExempt(path)) {
      return true;
    }

    const tenantId = request.tenantId;
    const connection = request.tenantConnection;
    if (!tenantId || !connection) {
      return true;
    }

    const status = await this.repository.findCurrentStatus(
      connection,
      tenantId,
    );

    if (status === 'cancelled') {
      throw new SubscriptionCancelledException();
    }

    if (status === 'past_due' && !READ_METHODS.has(request.method)) {
      throw new SubscriptionPastDueException();
    }

    return true;
  }

  private isExempt(path: string): boolean {
    return EXEMPT_PATHS.some(
      (exempt) => path === exempt || path.startsWith(`${exempt}/`),
    );
  }
}
