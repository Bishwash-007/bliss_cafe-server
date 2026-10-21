/**
 * Request shapes for the billing routes.
 *
 * Plain interfaces, matching the rest of the project: the controller validates
 * the few required fields and the service owns the lifecycle rules.
 */
export interface SubscriptionActionDto {
  /** One of: upgrade, downgrade, renew, retry_payment, cancel. */
  action?: string;
  /** Required for upgrade/downgrade. */
  planId?: string;
}

export interface ChangePlanDto {
  planId?: string;
}
