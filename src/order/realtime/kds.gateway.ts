import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { AUTH_CONFIG } from '../../auth/auth.constants';
import type { JwtAccessPayload } from '../../auth/interfaces/auth.interface';
import {
  ORDER_EVENTS,
  type OrderStatusChangedEvent,
} from '../events/order-events';

/**
 * The room name for one branch's KDS.
 *
 * Scoped by BOTH tenant and branch. `branchId` is the axis the design calls for
 * ("a room scoped by `branch_id`"), and the tenant is added so that room names
 * stay globally unambiguous across every tenant sharing the Redis adapter.
 * The delimiter is a character a UUID cannot contain, so no two (tenant, branch)
 * pairs can collapse onto the same string.
 *
 * Nothing reaches this function from client input: `tenantId` and `branchId`
 * always come from a verified access token's claims. See `authorizeBranch`.
 */
export function kdsRoom(tenantId: string, branchId: string): string {
  return `kds:${tenantId}:${branchId}`;
}

export const KDS_JOIN_EVENT = 'kds:join';
export const KDS_LEAVE_EVENT = 'kds:leave';
/** Wire event clients receive; identical to the domain event name. */
export const KDS_STATUS_CHANGED_EVENT = ORDER_EVENTS.statusChanged;

/**
 * Roles allowed to watch a kitchen display.
 *
 * A `customer` token is deliberately absent: the KDS stream carries every open
 * ticket in the branch — quantities, prices, table numbers — which is staff
 * information. The customer's own ticket reaches them over HTTP instead.
 */
export const KDS_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
  'kitchen_staff',
] as const;

/** The verified caller, attached to the socket during the handshake. */
export interface KdsIdentity {
  userId: string;
  tenantId: string;
  /** `null` for tenant-wide staff, who may watch any of their branches. */
  branchId: string | null;
  role: string;
}

/**
 * The per-socket data bag. Socket.IO types `data` as `any` (it is a free-form
 * object by design), so this narrows it in exactly one place instead of
 * sprinkling casts — the identity is written once by the handshake and read
 * from there on.
 */
interface KdsSocketData {
  identity?: KdsIdentity;
}

function socketDataOf(socket: Socket): KdsSocketData {
  return socket.data as KdsSocketData;
}

interface JoinBranchMessage {
  /** Optional; when present it must agree with the token. Never trusted. */
  tenantId?: string;
  branchId?: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * # Kitchen Display System gateway
 *
 * Pushes `order.status_changed` to the room of the branch the order belongs to,
 * which is the whole reason the state lives on the payload: a display for the
 * downtown branch must see downtown tickets and nothing else.
 *
 * ## The Observer half of the design
 *
 * This class is a SUBSCRIBER, not a caller. It never imports `OrderService`,
 * never knows how a transition is validated, and works unchanged if the
 * lifecycle grows a new status. Conversely `OrderService` knows nothing about
 * sockets, rooms or branches-as-channels — it just emits. The dependency points
 * one way, which is what lets Inventory, CRM and Notification plug into the
 * same bus without knowing a WebSocket exists.
 *
 * ## Authentication: the socket is not a way around the JWT
 *
 * A WebSocket is a long-lived, cross-instance data channel, so "shape looks
 * right" is not a security boundary. Before this was authenticated, any client
 * that could reach the port could name any `(tenantId, branchId)` pair and read
 * another café's tickets — a guessable-UUID away from a data breach, and the
 * Redis adapter made it work across every instance.
 *
 * So the handshake is authenticated instead:
 *
 * 1. `afterInit` installs Socket.IO middleware that verifies the access token
 *    from `handshake.auth.token` (browsers) or the `Authorization` header
 *    (kiosks/native) and stores the result in `socket.data.identity`. An
 *    unverifiable token never becomes a connected socket — the client gets
 *    `connect_error`, not a room.
 * 2. `tenantId` and `branchId` for every join are read from those verified
 *    claims. A `kds:join` body can ask for a branch; it can never *assert* one.
 * 3. `authorizeBranch` enforces the two rules that matter: the role must be
 *    allowed to watch a KDS at all, and a branch-scoped user may only watch
 *    their own branch. Tenant-wide staff (`branchId: null`) may watch any branch
 *    inside their own tenant — and still no other tenant's, because the tenant
 *    comes from the token rather than the message.
 *
 * Known limit, shared with every other authenticated route here: an access
 * token is not re-checked against `user_sessions`, so deactivating staff does
 * not eject an already-connected display until the token expires (15m by
 * default). Short-lived tokens bound the exposure; closing that fully needs a
 * per-message session check, which is a deliberate non-goal for a display that
 * reconnects on its own.
 *
 * ## Client protocol
 *
 * ```ts
 * const socket = io('/kds', { auth: { token: accessToken } });
 * socket.emit('kds:join', { branchId });            // -> 'kds:joined'
 * socket.on('order.status_changed', (event) => { ... });
 * socket.emit('kds:leave', { branchId });
 * ```
 */
@WebSocketGateway({
  namespace: '/kds',
  // Credentials are passed in the handshake `auth` payload, not a query string,
  // so tokens do not end up in proxy access logs.
  cors: { origin: true, credentials: true },
})
export class KdsGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(KdsGateway.name);

  constructor(private readonly jwt: JwtService) {}

  @WebSocketServer()
  private server!: Server;

  /**
   * Authenticates the handshake. Socket.IO middleware runs before the connection
   * is accepted, so rejecting here means the socket never exists — strictly
   * better than connecting and then disconnecting, which leaves a window where
   * the client believes it is connected.
   */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      void this.authenticate(socket)
        .then((identity) => {
          socketDataOf(socket).identity = identity;
          next();
        })
        .catch((error: unknown) => {
          this.logger.warn(
            `Rejected unauthenticated KDS socket: ${String(error)}`,
          );
          next(new Error('Unauthorized'));
        });
    });
  }

  /**
   * Auto-join a display that supplied its branch in the handshake, so a
   * reconnecting KDS screen is back on the rail without a round trip. A display
   * that did not supply one joins explicitly via `kds:join`.
   */
  handleConnection(client: Socket): void {
    const identity = this.identityOf(client);
    if (!identity) {
      return;
    }
    const handshake = client.handshake?.auth as
      Partial<JoinBranchMessage> | undefined;
    const branchId = handshake?.branchId;
    if (!branchId) {
      return;
    }
    // A bad handshake branch must NOT disconnect the socket: the display may
    // legitimately be misconfigured for one branch and still be worth keeping
    // connected so an operator can see the rejection in the log.
    const denial = this.authorizeBranch(identity, branchId);
    if (denial) {
      this.logger.warn(
        `KDS client ${client.id} handshake auto-join refused: ${denial}`,
      );
      return;
    }
    void this.join(client, identity.tenantId, branchId);
  }

  handleDisconnect(client: Socket): void {
    // Socket.IO removes the socket from every room it was in on disconnect, so
    // there is nothing to clean up here. The method exists to make that
    // explicit and to give the next engineer a place to hook presence tracking
    // ("is anyone watching this branch?" is a real KDS question).
    this.logger.debug(`KDS client ${client.id} disconnected`);
  }

  @SubscribeMessage(KDS_JOIN_EVENT)
  async joinBranch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<JoinBranchMessage>,
  ): Promise<{ event: string; room: string }> {
    const identity = this.requireIdentity(client);
    const branchId = body?.branchId;
    if (!branchId || !UUID_RE.test(branchId)) {
      throw new WsException('kds:join requires a valid branchId');
    }
    // A tenant in the body is only ever a consistency check against the token.
    // Mismatch means the client is pointed at the wrong deployment, and failing
    // loudly beats silently serving another tenant's room name.
    if (body?.tenantId && body.tenantId !== identity.tenantId) {
      throw new WsException('kds:join tenant does not match the access token');
    }
    const denial = this.authorizeBranch(identity, branchId);
    if (denial) {
      throw new WsException(denial);
    }
    return this.join(client, identity.tenantId, branchId);
  }

  @SubscribeMessage(KDS_LEAVE_EVENT)
  async leaveBranch(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: Partial<JoinBranchMessage>,
  ): Promise<{ event: string }> {
    const identity = this.requireIdentity(client);
    const branchId = body?.branchId;
    if (branchId && UUID_RE.test(branchId)) {
      // Leaving is always allowed for a room the socket actually joined —
      // there is no escalation in giving it back, and refusing here would leave
      // a display stuck in a room it is no longer allowed to watch.
      await client.leave(kdsRoom(identity.tenantId, branchId));
    }
    return { event: 'kds:left' };
  }

  /**
   * The subscription. One `emit` from `OrderService` and every display watching
   * that branch — on any instance — updates.
   *
   * `order.placed` is deliberately NOT subscribed to: `OrderService` emits
   * `order.status_changed` (`previousStatus: null`) alongside every placement,
   * so a gateway built only on this one event still picks up brand new tickets.
   * Listening to both would deliver every new order to the KDS twice.
   */
  @OnEvent(ORDER_EVENTS.statusChanged)
  handleOrderStatusChanged(event: OrderStatusChangedEvent): void {
    if (!this.server) {
      // A domain event can be emitted before the gateway's `afterInit` has run
      // (e.g. an order created during bootstrap). Dropping it is correct: the
      // display has no snapshot yet, so it will pick the order up from
      // `GET /orders/branches/:branchId/active` when it connects.
      return;
    }
    this.server
      .to(kdsRoom(event.tenantId, event.branchId))
      .emit(KDS_STATUS_CHANGED_EVENT, event);
  }

  private async authenticate(socket: Socket): Promise<KdsIdentity> {
    const token = this.tokenFrom(socket);
    if (!token) {
      throw new Error('no access token in the handshake');
    }

    let payload: JwtAccessPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtAccessPayload>(token, {
        secret: AUTH_CONFIG.jwtSecret,
      });
    } catch {
      // Signature/expiry failures are deliberately not distinguished to the
      // client; the server log keeps the detail.
      throw new Error('access token is invalid or expired');
    }

    if (payload.type !== 'access') {
      throw new Error('not an access token');
    }
    if (!payload.sub || !payload.tenantId) {
      throw new Error('access token is missing required claims');
    }

    return {
      userId: payload.sub,
      tenantId: payload.tenantId,
      branchId: payload.branchId ?? null,
      role: payload.role,
    };
  }

  /** Browsers send `auth.token`; native/kiosk clients send a bearer header. */
  private tokenFrom(socket: Socket): string | undefined {
    const fromAuth = (socket.handshake?.auth as { token?: string } | undefined)
      ?.token;
    if (typeof fromAuth === 'string' && fromAuth.length > 0) {
      return fromAuth;
    }
    const header = socket.handshake?.headers?.authorization;
    if (
      typeof header === 'string' &&
      header.toLowerCase().startsWith('bearer ')
    ) {
      return header.slice('bearer '.length).trim();
    }
    return undefined;
  }

  /**
   * Returns a human-readable reason to refuse, or `null` to allow.
   *
   * Both checks are on claims the server signed. The tenant is therefore not
   * negotiable, and a branch-scoped user cannot widen their view by asking for
   * a different branch.
   */
  private authorizeBranch(
    identity: KdsIdentity,
    branchId: string,
  ): string | null {
    if (!(KDS_ROLES as readonly string[]).includes(identity.role)) {
      return `Role '${identity.role}' may not watch a KDS`;
    }
    if (identity.branchId !== null && identity.branchId !== branchId) {
      return 'This account is scoped to a different branch';
    }
    return null;
  }

  private identityOf(client: Socket): KdsIdentity | null {
    return socketDataOf(client).identity ?? null;
  }

  private requireIdentity(client: Socket): KdsIdentity {
    const identity = this.identityOf(client);
    if (!identity) {
      // Unreachable while the handshake middleware is installed; throwing beats
      // trusting a missing identity if that ever changes.
      throw new WsException('Socket is not authenticated');
    }
    return identity;
  }

  private async join(
    client: Socket,
    tenantId: string,
    branchId: string,
  ): Promise<{ event: string; room: string }> {
    const room = kdsRoom(tenantId, branchId);
    await client.join(room);
    this.logger.log(`KDS client ${client.id} joined ${room}`);
    return { event: 'kds:joined', room };
  }
}
