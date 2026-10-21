import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './order/realtime/redis-io.adapter';

/**
 * Cross-origin allow-list.
 *
 * `CORS_ORIGINS` is a comma-separated list of origins that may call this API
 * from a browser. In production an unset value means "no browser origin is
 * allowed" — the API still works for server-to-server callers, and a
 * misconfigured deploy fails closed instead of opening the API to every
 * origin. Outside production the default is "any origin", which is what a
 * local mobile/web client expects.
 */
function allowedOrigins(): string[] | true {
  const configured = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  if (configured.length > 0) {
    return configured;
  }
  return process.env.NODE_ENV === 'production' ? [] : true;
}

async function bootstrap() {
  // `rawBody: true` is for the payment webhooks: gateway signatures are an
  // HMAC over the exact bytes posted, so re-serialising `req.body` would
  // validate against a different string than the provider signed. Every other
  // route continues to use the parsed body.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Security headers on every response: `X-Content-Type-Options`,
  // `X-Frame-Options`, `Strict-Transport-Security` and friends. This is a JSON
  // API, so the content-security-policy of a document server is turned off —
  // it has nothing to protect here and only confuses browser tooling.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  const origins = allowedOrigins();
  if (Array.isArray(origins) && origins.length === 0) {
    Logger.warn(
      'CORS_ORIGINS is not set: browser origins will be rejected. Set it to a ' +
        'comma-separated list of allowed origins.',
      'Bootstrap',
    );
  }
  app.enableCors({
    origin: origins,
    credentials: true,
  });

  // Behind a load balancer the client IP arrives in `X-Forwarded-For`; without
  // this the rate limiter would see every request as coming from the proxy.
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy && trustProxy !== 'false') {
    // The adapter's `getInstance()` is untyped in Nest; the only thing used
    // here is Express's `set`, so that is all this declares.
    const instance = app.getHttpAdapter().getInstance() as {
      set: (key: string, value: unknown) => void;
    };
    // `true` means "one hop" — Express understands the string as well, so the
    // only thing to do is pass a number through when the value is numeric and
    // hand anything else (a subnet, `loopback`) to Express untouched.
    const hops = Number(trustProxy);
    instance.set('trust proxy', Number.isNaN(hops) ? trustProxy : hops);
  }

  // Must be installed BEFORE `listen()`, and before the gateway is initialised,
  // or the first sockets bind to the in-memory adapter. With REDIS_URL set this
  // fans KDS events out across every replica; without it, the adapter falls
  // back to in-memory Socket.IO for single-instance local development.
  const wsAdapter = new RedisIoAdapter(app);
  app.useWebSocketAdapter(wsAdapter);

  // The adapter is hand-built, so Nest has no lifecycle hook for it and
  // `app.close()` would leave its Redis sockets open on every deploy. Order
  // matters: the WebSocket server has to be closed FIRST, otherwise it is still
  // publishing on connections that are being torn down and the shutdown spews
  // "Connection is closed" stack traces.
  const shutdown = async () => {
    await app.close();
    wsAdapter.disconnect();
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  Logger.log(`Listening on ${port}`, 'Bootstrap');
}
void bootstrap();
