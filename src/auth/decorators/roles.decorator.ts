import { SetMetadata } from '@nestjs/common';
import { ROLES_KEY } from '../auth.constants';

/** Declaratively restrict a route to the listed roles. Mirrors `@SetMetadata(ROLES_KEY, roles)`. */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);
