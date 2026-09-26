import { ForbiddenException } from '@nestjs/common';

/** Thrown when a request resolves to a tenant whose status is not 'active'. */
export class TenantInactiveException extends ForbiddenException {
  constructor(status: string) {
    super(
      `Tenant is currently "${status}". It has been suspended or cancelled and cannot serve requests.`,
    );
  }
}
