import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { MenuService } from './menu.service';
import type {
  MenuCategoryRow,
  MenuItemModifierRow,
  MenuItemRow,
} from './menu.repository';
import type { RenderedMenuNode } from './composite/menu-node';
import type {
  CreateCategoryDto,
  CreateItemDto,
  PackagedModifierDto,
  SetItemAvailabilityDto,
  UpdateItemDto,
} from './dto/menu.dto';

/**
 * Write access is restricted to the same three roles that manage branches
 * (`super_admin`, `org_owner`, `branch_manager`) — a waiter or a receptionist
 * must never be able to republish the menu or flip an item's price.
 */
const MENU_WRITE_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Every staff role may READ the menu (the KDS / the counter tablet need it);
 * only MENU_WRITE_ROLES may mutate it. `super_admin` is deliberately present in
 * both lists so a support engineer can inspect a tenant's menu.
 */
const MENU_READ_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'waiter',
  'kitchen_staff',
];

/**
 * `/menu` — the menu module's HTTP surface.
 *
 * Route 1: `GET /menu/public/:branchId` is the CUSTOMER-FACING read. It is
 * deliberately NOT behind `JwtAuthGuard`: an anonymous browser ordering from a
 * café's storefront has no auth token. It is still fully TENANT + BRANCH
 * scoped — the tenant comes from the `X-Tenant-Id` the tenant middleware
 * resolved onto `TenantRequestContext`, and `:branchId` from the path — and the
 * repository still filters every statement by `tenant_id` (plus Postgres RLS as
 * the second layer). So "public" means "unauthenticated", never
 * "unscoped".
 *
 * Routes 2..n are the staff CRUD surface, gated by RBAC.
 */
@Controller('menu')
export class MenuController {
  constructor(
    private readonly menuService: MenuService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  private get connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  private get tenantId(): string {
    const tenantId = this.tenantContext.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is missing');
    }
    return tenantId;
  }

  /**
   * Customer-facing, unauthenticated, tenant+branch scoped. The org-wide tree is
   * merged with this branch's overrides and every item's price is decorated
   * (base + Σ modifier extras) before it is rendered.
   */
  @Get('public/:branchId')
  async publicMenu(
    @Param('branchId') branchId: string,
  ): Promise<RenderedMenuNode[]> {
    return this.menuService.getFullMenu(this.connection, branchId);
  }

  /** Staff read of the same merged+decorated tree for one branch. */
  @Get('branches/:branchId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_READ_ROLES)
  async branchMenu(
    @Param('branchId') branchId: string,
  ): Promise<RenderedMenuNode[]> {
    return this.menuService.getFullMenu(this.connection, branchId);
  }

  /** Org owners preview the pure org-wide (template) menu, branch rows excluded. */
  @Get('org-wide')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('super_admin', 'org_owner')
  async orgWideMenu(): Promise<RenderedMenuNode[]> {
    return this.menuService.getFullMenu(this.connection, null);
  }

  /**
   * Create a category. `branchId` omitted → org-wide (applies to every branch);
   * supplied → that branch's override.
   */
  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  @HttpCode(201)
  createCategory(@Body() dto: CreateCategoryDto): Promise<MenuCategoryRow> {
    return this.menuService.createCategory(this.connection, null, dto);
  }

  @Post('branches/:branchId/categories')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  @HttpCode(201)
  createBranchCategory(
    @Param('branchId') branchId: string,
    @Body() dto: CreateCategoryDto,
  ): Promise<MenuCategoryRow> {
    return this.menuService.createCategory(this.connection, branchId, dto);
  }

  @Post('items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  @HttpCode(201)
  createItem(@Body() dto: CreateItemDto): Promise<MenuItemRow> {
    return this.menuService.createItem(this.connection, null, dto);
  }

  @Post('branches/:branchId/items')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  @HttpCode(201)
  createBranchItem(
    @Param('branchId') branchId: string,
    @Body() dto: CreateItemDto,
  ): Promise<MenuItemRow> {
    return this.menuService.createItem(this.connection, branchId, dto);
  }

  /** Attach a priced modifier variant ("Large", "oat milk", "extra shot"). */
  @Post('items/:itemId/modifiers')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  @HttpCode(201)
  addModifier(
    @Param('itemId') itemId: string,
    @Body() dto: PackagedModifierDto,
  ): Promise<MenuItemModifierRow> {
    return this.menuService.addModifier(this.connection, itemId, dto);
  }

  @Patch('items/:itemId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  updateItem(
    @Param('itemId') itemId: string,
    @Body() dto: UpdateItemDto,
  ): Promise<MenuItemRow> {
    return this.menuService.updateItem(this.connection, itemId, dto);
  }

  /**
   * Soft-delete: flips `is_available` instead of deleting the row, so historic
   * `order_items` keep resolving the name/price they were sold at.
   */
  @Patch('items/:itemId/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(...MENU_WRITE_ROLES)
  setAvailability(
    @Param('itemId') itemId: string,
    @Body() dto: SetItemAvailabilityDto,
  ): Promise<MenuItemRow> {
    return this.menuService.setAvailable(
      this.connection,
      itemId,
      dto.isAvailable,
    );
  }
}
