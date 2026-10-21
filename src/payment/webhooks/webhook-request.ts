import { InternalServerErrorException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Reads the exact bytes the gateway signed.
 *
 * Nest is configured with `rawBody: true` (see `main.ts`), which attaches the
 * untouched buffer before the JSON body parser replaces `req.body`. Re-encoding
 * `req.body` would produce a different string for any payload with whitespace,
 * key ordering or unicode escaping, and every signature would fail.
 *
 * A misconfigured app is a server error, not an invalid signature: silently
 * falling back to the parsed body would fail open for some gateways and closed
 * for others with no clue why.
 */
export function rawPayload(request: RawBodyRequest<Request>): string {
  if (!request.rawBody) {
    throw new InternalServerErrorException(
      'Webhook raw body is unavailable; the application must be created with ' +
        '`{ rawBody: true }` to verify gateway signatures.',
    );
  }
  return request.rawBody.toString('utf8');
}

/** Lowercased header map for the adapters' constant-time comparisons. */
export function headerMap(
  request: Request,
): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return headers;
}
