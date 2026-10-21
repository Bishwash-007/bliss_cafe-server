import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { TenantNotFoundException } from '../tenant/exceptions/tenant-not-found.exception';
import { NotificationService } from './notification.service';
import type {
  NotificationDeadLetter,
  NotificationQueueDriver,
} from './notification.types';

/**
 * Who may inspect dead letters.
 *
 * Dead letters contain recipients and message bodies, so this is not a
 * everyone-with-a-token route. Owners and branch managers are the people who
 * can act on "the SMS provider rejected every number"; a waiter cannot.
 */
const DEAD_LETTER_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface DeadLetterListResponse {
  driver: NotificationQueueDriver;
  count: number;
  dead_letters: NotificationDeadLetter[];
}

/**
 * Operational visibility for the queue.
 *
 * ## Why an HTTP inspector exists
 *
 * "Failed jobs land in a dead-letter queue you can inspect" is only true if
 * somebody can inspect it without shell access to Redis. The queue is shared
 * by every tenant, so the route filters by the tenant the request resolved to;
 * an owner cannot see another tenant's failed recipient or message.
 *
 * There is deliberately no "retry" or "delete" mutator yet. Replaying a dead
 * letter needs a decision about the customer's opt-out and the original
 * event's continued relevance; a DELETE button would make it trivial to lose
 * the only record of a failure.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  @Get('dead-letter')
  @Roles(...DEAD_LETTER_ROLES)
  async listDeadLetters(
    @Query('limit') limit?: string,
  ): Promise<DeadLetterListResponse> {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new TenantNotFoundException();
    }

    const parsed = Number(limit);
    const bounded =
      Number.isInteger(parsed) && parsed > 0
        ? Math.min(parsed, MAX_LIMIT)
        : DEFAULT_LIMIT;

    const deadLetters = await this.notifications.listDeadLetters(
      tenantId,
      bounded,
    );
    return {
      driver: this.notifications.driver,
      count: deadLetters.length,
      dead_letters: deadLetters,
    };
  }
}
