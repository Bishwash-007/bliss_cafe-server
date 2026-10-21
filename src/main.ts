import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { RedisIoAdapter } from './order/realtime/redis-io.adapter';

async function bootstrap() {
  // `rawBody: true` is for the payment webhooks: gateway signatures are an
  // HMAC over the exact bytes posted, so re-serialising `req.body` would
  // validate against a different string than the provider signed. Every other
  // route continues to use the parsed body.
  const app = await NestFactory.create(AppModule, { rawBody: true });

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
