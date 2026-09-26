import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantResolver } from '../interfaces/tenant-resolver.interface';

/**
 * Resolves the tenant from the request's subdomain.
 *
 * e.g. `beanhouse.yourapp.com` -> slug `beanhouse`
 *      `a.b.yourapp.com`       -> slug `a.b`
 *      `yourapp.com` / `localhost` / an IP -> null (apex / non-routable)
 *
 * The returned value is treated as a slug by the middleware, which validates it
 * against the `tenants` table.
 */
@Injectable()
export class SubdomainTenantResolver implements TenantResolver {
  resolve(req: Request): string | null {
    const hostname = req.hostname;
    if (!hostname) {
      return null;
    }

    // IP-literal hosts (v4 or bracketed v6) can never carry a subdomain slug.
    if (
      hostname.includes(':') ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
      hostname === 'localhost'
    ) {
      return null;
    }

    const labels = hostname.split('.');
    // Two labels or fewer means we are on the apex domain, not a subdomain.
    if (labels.length <= 2) {
      return null;
    }

    // Strip a common "www" prefix so www.yourapp.com behaves like the apex.
    const subdomainLabels =
      labels[0] === 'www' ? labels.slice(1, -2) : labels.slice(0, -2);
    const slug = subdomainLabels.join('.');
    return slug.length > 0 ? slug : null;
  }
}
