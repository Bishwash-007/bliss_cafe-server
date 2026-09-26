import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { BranchService } from './branch.service';
import type { BranchRow, TableRow } from './branch.repository';
import { CreateBranchDto } from './dto/create-branch.dto';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

const BRANCH_STAFF_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

@Controller('branches')
export class BranchController {
  constructor(
    private readonly branchService: BranchService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private get tenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is missing');
    }
    return tenantId;
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  async list(): Promise<BranchRow[]> {
    return this.branchService.listBranches(
      this.tenantContext.getConnection(),
      this.tenantId,
    );
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_STAFF_ROLES)
  @HttpCode(201)
  create(@Body() dto: CreateBranchDto): Promise<BranchRow> {
    return this.branchService.createBranch(
      this.tenantContext.getConnection(),
      this.tenantId,
      dto,
    );
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_STAFF_ROLES)
  update(
    @Param('id') branchId: string,
    @Body() dto: UpdateBranchDto,
  ): Promise<BranchRow> {
    return this.branchService.updateBranch(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
      dto,
    );
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_STAFF_ROLES)
  deactivate(@Param('id') branchId: string): Promise<BranchRow> {
    return this.branchService.deactivateBranch(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
    );
  }

  @Get(':id/tables')
  @UseGuards(JwtAuthGuard)
  async listTables(@Param('id') branchId: string): Promise<TableRow[]> {
    return this.branchService.listTables(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
    );
  }

  @Post(':id/tables')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_STAFF_ROLES)
  @HttpCode(201)
  createTable(
    @Param('id') branchId: string,
    @Body() dto: CreateTableDto,
  ): Promise<TableRow> {
    return this.branchService.createTable(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
      dto,
    );
  }
}
