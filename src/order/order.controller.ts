import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { assertBranchAccess } from '../auth/branch-scope';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type { CreateOrderDto, TransitionOrderDto } from './dto/order.dto';
import type { OrderRow } from './order.repository';
import { OrderService } from './order.service';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Who may take an order.
 *
 * Waiters and the counter ring orders up; managers can do everything, which is
 * what makes a manager override possible without a second code path.
 */
const ORDER_WRITE_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
];

/**
 * Who may move an order along.
 *
 * Includes `kitchen_staff` — pushing a ticket to `preparing`/`ready` is exactly
 * their job. The set is intentionally the same as `ORDER_WRITE_ROLES` plus the
 * kitchen, kept as a separate constant so the two can diverge (a future rule
 * like "only a manager may cancel" needs two edits, not a hunt).
 */
const ORDER_TRANSITION_ROLES = [...ORDER_WRITE_ROLES, 'kitchen_staff'];

/**
 * Who may READ the ticket stream.
 *
 * The same set as the people who may transition a ticket: a customer has no
 * business reading another customer's ticket, and a `customer` token is the
 * one credential that reaches these routes without a staff role.
 */
const ORDER_READ_ROLES = ORDER_TRANSITION_ROLES;

/**
 * `/orders` — the order module's HTTP surface.
 *
 * Every route is authenticated and tenant-scoped: the tenant comes from the
 * middleware-resolved `TenantRequestContext`, and the service/repository filter
 * by `tenant_id` regardless (RLS as the second layer). An order id alone never
 * grants access to another café's ticket.
 *
 * Branch scope is enforced on top of that: a branch-confined account (a
 * waiter, a receptionist, a branch manager) sees and changes the tickets of
 * its own branch only, whatever branch id the URL carries.
 */
@Controller('orders')
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private get connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  private get tenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is missing');
    }
    return tenantId;
  }

  /**
   * Places an order.
   *
   * Safe to retry: pass the `clientActionId` from your offline action queue and
   * a repeat of the same action returns the ORIGINAL order rather than a
   * duplicate or an error — see `OrderService.create`.
   *
   * `created_by` comes from the validated JWT, never the body: a client that
   * could name the author of a ticket could file an order against a colleague.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_WRITE_ROLES)
  @HttpCode(201)
  async create(
    @Body() dto: CreateOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<OrderRow> {
    assertBranchAccess(req.user, dto.branchId, 'The branch');
    return this.orderService.create(
      this.connection,
      this.tenantId,
      req.user?.userId ?? null,
      dto,
    );
  }

  /**
   * Advances an order. Illegal moves are rejected with
   * `InvalidOrderTransitionException` (400) naming what IS allowed — the State
   * pattern in `state/` is the authority, not this route.
   */
  @Post(':id/transition')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_TRANSITION_ROLES)
  @HttpCode(200)
  async transition(
    @Param('id') orderId: string,
    @Body() dto: TransitionOrderDto,
    @Req() req: AuthedRequest,
  ): Promise<OrderRow> {
    const order = await this.orderService.findById(
      this.connection,
      this.tenantId,
      orderId,
    );
    assertBranchAccess(req.user, order.branch_id, 'The order');
    return this.orderService.transition(
      this.connection,
      this.tenantId,
      orderId,
      dto.status,
    );
  }

  /** Everything in flight for a branch, oldest first — the KDS snapshot. */
  @Get('branches/:branchId/active')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_READ_ROLES)
  listActive(
    @Param('branchId') branchId: string,
    @Req() req: AuthedRequest,
  ): Promise<OrderRow[]> {
    assertBranchAccess(req.user, branchId, 'The branch');
    return this.orderService.listActiveByBranch(
      this.connection,
      this.tenantId,
      branchId,
    );
  }

  @Get('branches/:branchId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_READ_ROLES)
  listByBranch(
    @Param('branchId') branchId: string,
    @Req() req: AuthedRequest,
  ): Promise<OrderRow[]> {
    assertBranchAccess(req.user, branchId, 'The branch');
    return this.orderService.listByBranch(
      this.connection,
      this.tenantId,
      branchId,
    );
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...ORDER_READ_ROLES)
  async findById(
    @Param('id') orderId: string,
    @Req() req: AuthedRequest,
  ): Promise<OrderRow> {
    const order = await this.orderService.findById(
      this.connection,
      this.tenantId,
      orderId,
    );
    assertBranchAccess(req.user, order.branch_id, 'The order');
    return order;
  }
}
