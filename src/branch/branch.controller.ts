import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { assertBranchAccess, isOrgWide } from '../auth/branch-scope';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { BranchService } from './branch.service';
import type { BranchRow, TableRow } from './branch.repository';
import { CreateBranchDto } from './dto/create-branch.dto';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateBranchDto } from './dto/update-branch.dto';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/** Who may create, edit and retire branches. */
const BRANCH_STAFF_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Who may read the branch and table list.
 *
 * Every staff role needs the branch list (the counter tablet has to know which
 * branch it is); a `customer` token does not, and a customer token is the one
 * credential that reaches this API without a staff role.
 */
const BRANCH_READ_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
  'kitchen_staff',
];

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

  /**
   * The tenant's branches.
   *
   * A branch-confined account sees only its own branch: the list is the
   * cheapest way to discover the other branches of the café, so it is scoped
   * exactly like the routes that read a single branch.
   */
  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_READ_ROLES)
  async list(@Req() req: AuthedRequest): Promise<BranchRow[]> {
    const user = req.user;
    const branchId =
      user && !isOrgWide(user) && user.branchId ? user.branchId : undefined;
    return this.branchService.listBranches(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
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
  async update(
    @Param('id') branchId: string,
    @Body() dto: UpdateBranchDto,
    @Req() req: AuthedRequest,
  ): Promise<BranchRow> {
    assertBranchAccess(req.user, branchId, 'The branch');
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
  async deactivate(
    @Param('id') branchId: string,
    @Req() req: AuthedRequest,
  ): Promise<BranchRow> {
    assertBranchAccess(req.user, branchId, 'The branch');
    return this.branchService.deactivateBranch(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
    );
  }

  @Get(':id/tables')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...BRANCH_READ_ROLES)
  async listTables(
    @Param('id') branchId: string,
    @Req() req: AuthedRequest,
  ): Promise<TableRow[]> {
    assertBranchAccess(req.user, branchId, 'The branch');
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
  async createTable(
    @Param('id') branchId: string,
    @Body() dto: CreateTableDto,
    @Req() req: AuthedRequest,
  ): Promise<TableRow> {
    assertBranchAccess(req.user, branchId, 'The branch');
    return this.branchService.createTable(
      this.tenantContext.getConnection(),
      this.tenantId,
      branchId,
      dto,
    );
  }
}
