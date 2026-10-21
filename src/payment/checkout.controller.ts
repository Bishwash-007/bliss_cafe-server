import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { TenantNotFoundException } from '../tenant/exceptions/tenant-not-found.exception';
import { PaymentService } from './payment.service';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Who is standing at the till.
 *
 * The same roles that take an order: a waiter closing a table and a
 * receptionist taking a walk-in both need to show the customer a QR.
 */
const CHECKOUT_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
];

/**
 * Starts payment for an order.
 *
 * `POST /orders/:id/checkout` rather than a `/payments` route because the
 * order is the resource being settled, and a client that just created the
 * order already holds its id. The response pairs the persisted `payments` row
 * with a provider-neutral QR payload.
 *
 * Branch confinement is the order module's existing model: a request may act on
 * any order in its tenant. Adding branch checks here alone would be a
 * half-measure, so the rule stays where order writes already enforce it.
 */
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CheckoutController {
  constructor(
    private readonly payments: PaymentService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Post(':id/checkout')
  @HttpCode(HttpStatus.OK)
  @Roles(...CHECKOUT_ROLES)
  checkout(@Param('id') orderId: string, @Req() request: AuthedRequest) {
    return this.payments.checkout(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      orderId,
      request.user?.userId ?? null,
    );
  }

  private requireTenant(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new TenantNotFoundException();
    }
    return tenantId;
  }
}
