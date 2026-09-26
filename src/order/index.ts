/**
 * # OrderModule — public surface
 *
 * The barrel other modules import. Deliberately small: Inventory (06), CRM (08)
 * and Notification (10) should need these three things and nothing else —
 * the event names/payloads to subscribe to, the service to call when they need
 * to move an order (a payment webhook landing on `paid`, say), and the KDS
 * gateway if they ever need to push to a display directly.
 *
 * They should NOT need `OrderRepository` (data access stays internal) or any
 * state class (the transition rules are the service's business, not a table a
 * caller should read to decide what to do).
 *
 * ```ts
 * // subscriber
 * import { ORDER_EVENTS, type OrderStatusChangedEvent } from '../order';
 *
 * @OnEvent(ORDER_EVENTS.statusChanged)
 * onOrderStatusChanged(event: OrderStatusChangedEvent): void { ... }
 * ```
 *
 * Events fire only after the request transaction has committed, so a handler can
 * re-read the order on its own connection and a rolled-back request is silent.
 * See `./events/order-events` for the durability limits before relying on it.
 */

// The event contract — names, payload shapes, and when each one fires.
export {
  ORDER_EVENTS,
  ORDER_TYPES,
  isOrderType,
  type OrderEventName,
  type OrderPaidEvent,
  type OrderPlacedEvent,
  type OrderPlacedItem,
  type OrderStatusChangedEvent,
  type OrderType,
} from './events/order-events';

// The lifecycle vocabulary, for callers that need to name a status.
export {
  ORDER_STATUSES,
  isOrderStatus,
  type OrderState,
  type OrderStatus,
} from './state/order-state';

// Callable surface.
export { OrderService } from './order.service';
export { KdsGateway, kdsRoom } from './realtime/kds.gateway';

// Failures a caller may want to branch on (e.g. a webhook for an order that is
// already `paid` is an expected 400, not a bug).
export {
  InvalidOrderTransitionException,
  OrderNotFoundException,
  UnknownOrderStatusException,
} from './exceptions/order.exceptions';
