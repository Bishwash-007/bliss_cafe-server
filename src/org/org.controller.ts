import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { MINUTE, ONBOARDING_LIMIT } from '../rate-limits';
import { hash } from 'bcryptjs';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { OnboardingDto } from './dto/onboarding.dto';
import {
  TenantOnboardingBuilder,
  type TenantOnboardingResult,
} from './tenant-onboarding.builder';

@Controller('onboarding')
@UseGuards(ThrottlerGuard)
export class OrgController {
  constructor(private readonly tenantContext: TenantRequestContext) {}

  @Throttle({ default: { limit: ONBOARDING_LIMIT, ttl: MINUTE } })
  @Post()
  @HttpCode(201)
  async onboard(@Body() dto: OnboardingDto): Promise<TenantOnboardingResult> {
    const passwordHash = await hash(dto.owner.password, 10);

    return new TenantOnboardingBuilder(this.tenantContext.getConnection())
      .withOrgDetails(dto.orgName, dto.slug)
      .withPlan(dto.planId?.trim())
      .withFirstBranch(dto.firstBranch.name, dto.firstBranch.address)
      .withDefaultTables(dto.defaultTables ?? 0)
      .withOwnerAccount(dto.owner.email, passwordHash)
      .build();
  }
}
