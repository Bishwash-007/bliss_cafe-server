import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

/**
 * Socket.IO adapter that fans messages out through Redis.
 *
 * ## Why this is needed at all
 *
 * The default adapter keeps its room registry in ONE process's memory. With a
 * single instance, `server.to(room).emit(...)` reaches every socket in that
 * room. Horizontally scaled — which the system design calls for (stateless
 * instances behind a load balancer) — it silently breaks: a KDS display
 * connected to instance 2 never sees an `order.status_changed` published on
 * instance 1, and the bug presents as "the kitchen screen sometimes freezes",
 * which is close to undebuggable in production.
 *
 * The Redis adapter makes pub/sub the transport, so `to(room).emit()` reaches
 * sockets attached to *any* instance, while each socket is still joined to
 * exactly one instance.
 *
 * ## Why it degrades instead of refusing to boot
 *
 * Redis is optional in this repository so far — nothing else uses it, and
 * `.env` is not yet wired for it. Rather than making local development and the
 * test suite depend on a running Redis, an absent `REDIS_URL` keeps the default
 * in-memory adapter and logs a warning naming the consequence. Set `REDIS_URL`
 * in any environment with more than one instance; the same code then needs no
 * changes.
 *
 * Wire it up in `main.ts`:
 * ```ts
 * app.useWebSocketAdapter(new RedisIoAdapter(app));
 * ```
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private distributed = false;
  private readonly clients: Redis[] = [];
  private warnedAboutMissingRedis = false;

  /**
   * `IoAdapter.createIOServer` is the one place the Socket.IO `Server` is
   * constructed, so it is the one place an adapter can be attached — the
   * instance is per-server, and Nest calls this once per gateway namespace.
   *
   * It MUST stay synchronous. `IoAdapter.create` does
   * `this.createIOServer(port, opt).of(namespace)`, so an `async` override
   * hands it a Promise and `.of` does not exist on a Promise — the process dies
   * at boot. That is also why a real `app.listen()` smoke check is worth more
   * than any amount of unit testing here.
   */
  override createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, options) as Server;
    this.attachRedisAdapter(server);
    return server;
  }

  /** True when the cross-instance adapter is actually in use. */
  get isDistributed(): boolean {
    return this.distributed;
  }

  /**
   * Closes every Redis connection this adapter opened.
   *
   * `app.close()` does NOT reach these: the adapter is constructed by hand in
   * `main.ts` rather than injected, so Nest has no lifecycle hook for it. Without
   * this, every shutdown leaks live sockets — which also stops Jest from ever
   * exiting when a test boots the adapter.
   */
  disconnect(): void {
    for (const client of this.clients) {
      client.disconnect();
    }
    this.clients.length = 0;
  }

  private attachRedisAdapter(server: Server): void {
    const redisUrl = process.env.REDIS_URL;
    if (!redisUrl) {
      // Once per process, not once per namespace: Nest builds a server per
      // gateway namespace, and repeating the warning buries the real logs.
      if (!this.warnedAboutMissingRedis) {
        this.warnedAboutMissingRedis = true;
        this.logger.warn(
          'REDIS_URL is not set — WebSocket rooms are in-memory and only work on ' +
            'a single instance. Set REDIS_URL before running more than one ' +
            'replica, otherwise KDS displays connected to other instances go ' +
            'silent.',
        );
      }
      return;
    }

    // The Redis adapter protocol needs two connections: one in subscriber mode
    // (a connection in subscriber mode cannot issue ordinary commands) and one
    // for publishing.
    const pubClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
    const subClient = new Redis(redisUrl, { maxRetriesPerRequest: null });
    this.clients.push(pubClient, subClient);

    // ioredis connects lazily, so the adapter is safe to install before the
    // socket is up; it starts fanning out as soon as Redis answers.
    server.adapter(createAdapter(pubClient, subClient));
    this.distributed = true;
    this.logger.log(`Socket.IO is fanning out over Redis at ${redisUrl}`);

    // Connectivity is reported, not enforced: an unreachable Redis must not
    // take the HTTP API down with it, and `maxRetriesPerRequest: null` means
    // ioredis keeps retrying, so this recovers on its own once Redis returns.
    void this.reportRedisHealth(pubClient, subClient, redisUrl);
  }

  private async reportRedisHealth(
    pubClient: Redis,
    subClient: Redis,
    redisUrl: string,
  ): Promise<void> {
    try {
      await Promise.all([pubClient.ping(), subClient.ping()]);
    } catch (error) {
      this.logger.error(
        `Could not reach Redis at ${redisUrl}; KDS updates will not cross ` +
          `instances until it is available. Cause: ${String(error)}`,
      );
    }
  }
}
