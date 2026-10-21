import { Injectable } from '@nestjs/common';

/**
 * The seam between a gateway adapter and the network.
 *
 * Every provider talks through this interface instead of calling `fetch`
 * directly. That is what lets the shared provider-contract test suite exercise
 * three real adapters against scripted gateway responses, and it is what keeps
 * an accidental live charge out of CI. The production binding is
 * `FetchPaymentHttpClient`.
 */
export const PAYMENT_HTTP = 'PAYMENT_HTTP';

export interface PaymentHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON objects are serialised; strings and form bodies are sent verbatim. */
  body?: string | URLSearchParams | Record<string, unknown>;
}

export interface PaymentHttpResponse {
  status: number;
  /** Parsed JSON when the response was JSON, otherwise the raw text. */
  body: unknown;
}

export interface PaymentHttpClient {
  request(request: PaymentHttpRequest): Promise<PaymentHttpResponse>;
}

/** How long a single gateway call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class FetchPaymentHttpClient implements PaymentHttpClient {
  async request(input: PaymentHttpRequest): Promise<PaymentHttpResponse> {
    const headers: Record<string, string> = { ...input.headers };
    let body: string | URLSearchParams | undefined;

    if (input.body instanceof URLSearchParams) {
      body = input.body;
      headers['content-type'] ??=
        'application/x-www-form-urlencoded;charset=utf-8';
    } else if (typeof input.body === 'string') {
      body = input.body;
    } else if (input.body !== undefined) {
      body = JSON.stringify(input.body);
      headers['content-type'] ??= 'application/json';
    }

    const response = await fetch(input.url, {
      method: input.method,
      headers,
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const text = await response.text();
    return {
      status: response.status,
      body: parseBody(text),
    };
  }
}

function parseBody(text: string): unknown {
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
