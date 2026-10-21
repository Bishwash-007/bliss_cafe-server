import {
  Controller,
  Get,
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

/** Reading a payment's history is a counter operation. */
const PAYMENT_READ_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
];

/**
 * Moving money back is a manager decision, not a waiter one.
 *
 * Deliberately narrower than checkout: a refund is irreversible at the gateway
 * and is the single action most worth a second pair of eyes.
 */
const REFUND_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

@Controller('payments')
@UseGuards(JwtAuthGuard, RolesGuard)
export class PaymentController {
  constructor(
    private readonly payments: PaymentService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  /** Every payment attempt for an order, newest first. */
  @Get('order/:orderId')
  @Roles(...PAYMENT_READ_ROLES)
  listForOrder(@Param('orderId') orderId: string) {
    return this.payments.listForOrder(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      orderId,
    );
  }

  /**
   * Fully refunds a succeeded payment.
   *
   * Returns both the gateway's refund result and the (possibly updated)
   * `payments` row. It does not reopen or cancel the order: whether a refunded
   * meal should return to the kitchen is a business decision that belongs to
   * the order module, not to a money movement.
   */
  @Post(':id/refund')
  @HttpCode(HttpStatus.OK)
  @Roles(...REFUND_ROLES)
  refund(@Param('id') paymentId: string, @Req() request: AuthedRequest) {
    return this.payments.refund(
      this.tenantContext.getConnection(),
      this.requireTenant(),
      paymentId,
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
