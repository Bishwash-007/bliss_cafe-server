import { IsOptional, IsString } from 'class-validator';

/**
 * Request shapes for the billing routes.
 *
 * The controller still trims and checks the few required fields because the
 * lifecycle rules belong to the service; these decorators reject wrong JSON
 * types before any database or gateway work happens.
 */
export class SubscriptionActionDto {
  /** One of: upgrade, downgrade, renew, retry_payment, cancel. */
  @IsOptional()
  @IsString()
  action?: string;

  /** Required for upgrade/downgrade. */
  @IsOptional()
  @IsString()
  planId?: string;
}

export class ChangePlanDto {
  @IsOptional()
  @IsString()
  planId?: string;
}
