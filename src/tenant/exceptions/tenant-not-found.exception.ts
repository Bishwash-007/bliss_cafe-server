import { NotFoundException } from '@nestjs/common';

/** Thrown by the tenant chain when no resolver could resolve a tenant. */
export class TenantNotFoundException extends NotFoundException {
  constructor(reference?: string) {
    super(
      reference
        ? `Tenant "${reference}" could not be resolved.`
        : 'Tenant could not be resolved for this request.',
    );
  }
}
