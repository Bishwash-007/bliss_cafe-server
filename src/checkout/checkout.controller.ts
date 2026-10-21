import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';

export interface CheckoutResult {
  initiated: boolean;
  message: string;
  staff: AuthenticatedUser;
}

type CheckoutRequest = Request & { user?: AuthenticatedUser };

/**
 * Demonstration of RBAC across modules: kicking off checkout requires an
 * authenticated user holding `branch_manager` or `receptionist`.
 */
@Controller('checkout')
export class CheckoutController {
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('branch_manager', 'receptionist')
  @HttpCode(HttpStatus.ACCEPTED)
  initiate(@Req() req: CheckoutRequest): CheckoutResult {
    const staff = req.user;
    if (!staff) {
      throw new Error('JwtAuthGuard did not attach a user');
    }
    return {
      initiated: true,
      message: 'Checkout accepted; take payment with POST /orders/:id/checkout',
      staff,
    };
  }
}
