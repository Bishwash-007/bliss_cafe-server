import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { TenantNotFoundException } from '../tenant/exceptions/tenant-not-found.exception';
import type { BillingPlan, SubscriptionView } from './billing.types';
import type { ChangePlanDto, SubscriptionActionDto } from './dto/billing.dto';
import { PlanNotFoundException } from './exceptions/billing.exceptions';
import {
  SubscriptionService,
  type PerformActionOptions,
} from './subscription.service';
import type { SubscriptionActionResult } from './billing.types';

/**
 * Billing is the tenant's contract with the platform, so only the account
 * owner (or a platform super-admin acting on their behalf) may read or change
 * it. A branch manager who needs to know whether the plan allows another staff
 * member gets that answer from the staff module's plan limit, not from here.
 */
const BILLING_ROLES = ['super_admin', 'org_owner'];

/**
 * `/billing` — the tenant's SaaS subscription.
 *
 * This is NOT the guest checkout surface; that is `/payments` and
 * `/orders/:id/checkout`. Every charge initiated here flows through
 * `PaymentModule.PaymentProviderFactory`.
 */
@Controller('billing')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BillingController {
  constructor(
    private readonly subscriptions: SubscriptionService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  /** The current subscription, its plan and its period. */
  @Get('subscription')
  @Roles(...BILLING_ROLES)
  getSubscription(): Promise<SubscriptionView> {
    return this.subscriptions.getSubscription(this.requireTenant());
  }

  /** Plans available to move to, cheapest first. */
  @Get('plans')
  @Roles(...BILLING_ROLES)
  listPlans(): Promise<BillingPlan[]> {
    return this.subscriptions.listPlans(this.requireTenant());
  }

  /**
   * State-guarded actions.
   *
   * `upgrade`/`downgrade` need a `planId`; the others do not. Illegal actions
   * (for example `upgrade` while `past_due`) are refused by the state machine
   * before any gateway call.
   */
  @Post('subscription/actions')
  @Roles(...BILLING_ROLES)
  @HttpCode(200)
  performAction(
    @Body() body: SubscriptionActionDto,
  ): Promise<SubscriptionActionResult> {
    const action = body?.action?.trim();
    if (!action) {
      throw new BadRequestException('`action` is required');
    }
    if (
      body.planId !== undefined &&
      (typeof body.planId !== 'string' || body.planId.trim().length === 0)
    ) {
      throw new BadRequestException('`planId` must be a non-empty string');
    }

    const options: PerformActionOptions = {
      planId: body.planId?.trim(),
    };
    return this.subscriptions.performAction(
      this.requireTenant(),
      action,
      options,
    );
  }

  /**
   * Convenience route for the plan picker: derives `upgrade`/`downgrade` from
   * the target price, then goes through the same state guard and proration
   * strategy as `POST /billing/subscription/actions`.
   */
  @Post('subscription/change-plan')
  @Roles(...BILLING_ROLES)
  @HttpCode(200)
  async changePlan(
    @Body() body: ChangePlanDto,
  ): Promise<SubscriptionActionResult> {
    const planId = body?.planId?.trim();
    if (!planId) {
      throw new BadRequestException('`planId` is required');
    }

    const tenantId = this.requireTenant();
    const current = await this.subscriptions.getSubscription(tenantId);
    const plans = await this.subscriptions.listPlans(tenantId);
    const target = plans.find((plan) => plan.id === planId);
    if (!target) {
      throw new PlanNotFoundException(planId);
    }

    const action =
      target.priceMonthly > current.plan.priceMonthly ? 'upgrade' : 'downgrade';
    return this.subscriptions.performAction(tenantId, action, { planId });
  }

  private requireTenant(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new TenantNotFoundException();
    }
    return tenantId;
  }
}
