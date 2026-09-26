import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedUser } from '../auth/interfaces/auth.interface';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TenantRequestContext } from '../tenant/connection/tenant-request-context';
import type { TenantScopedConnection } from '../tenant/connection/tenant-scoped-connection';
import type {
  AdjustStockDto,
  CreateInventoryItemDto,
  CreateSupplierDto,
  ListDiscrepanciesQueryDto,
  SetRecipeIngredientDto,
  StockInDto,
  UpdateReorderThresholdDto,
  UpdateSupplierDto,
} from './dto/inventory.dto';
import { BranchAccessDeniedException } from './exceptions/inventory.exceptions';
import { InventoryService } from './inventory.service';
import type { InventoryActor, UpdateSupplierInput } from './inventory.types';

type AuthedRequest = Request & { user?: AuthenticatedUser };

/**
 * Stock is a management concern: a waiter should not be able to declare that 40 kg
 * of flour arrived, and a customer certainly should not be able to adjust their
 * own order's ingredient usage. The same three roles that manage the menu and the
 * branch floor write inventory.
 */
const INVENTORY_WRITE_ROLES = ['super_admin', 'org_owner', 'branch_manager'];

/**
 * Reads are open to the staff who need them for their own work — the kitchen
 * needs today's remaining stock to know what it can still cook — plus a manager
 * reconciling counts.
 */
const INVENTORY_READ_ROLES = [
  'super_admin',
  'org_owner',
  'branch_manager',
  'receptionist',
  'kitchen_staff',
];

/**
 * `/inventory` — the inventory module's HTTP surface.
 *
 * Every handler takes the request's connection from `TenantRequestContext`, so a
 * controller method can never run against a pool connection that has no
 * `app.tenant_id` set (and therefore no RLS protection).
 *
 * Nothing here starts or commits a transaction: the stock write and the matching
 * `stock_movements` row share the request transaction, which the
 * `TenantCommitInterceptor` commits before the response is written. A handler
 * that returned before the commit would let a client see a success for a movement
 * that later rolled back.
 */
@Controller('inventory')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InventoryController {
  constructor(
    private readonly service: InventoryService,
    private readonly tenantContext: TenantRequestContext,
  ) {}

  // ------------------------------------------------------------- suppliers

  @Post('suppliers')
  @Roles(...INVENTORY_WRITE_ROLES)
  async createSupplier(@Body() body: CreateSupplierDto) {
    return this.service.createSupplier(this.connection(), {
      name: body.name,
      contactPhone: body.contactPhone ?? null,
      contactEmail: body.contactEmail ?? null,
    });
  }

  @Get('suppliers')
  @Roles(...INVENTORY_READ_ROLES)
  listSuppliers() {
    return this.service.listSuppliers(this.connection());
  }

  @Get('suppliers/:id')
  @Roles(...INVENTORY_READ_ROLES)
  getSupplier(@Param('id') id: string) {
    return this.service.getSupplier(this.connection(), id);
  }

  /**
   * A partial supplier change.
   *
   * Only the keys actually present in the body are forwarded. Copying every field
   * with `?? null` would turn "rename this supplier" into "also erase both contact
   * details", which is the kind of data loss a PATCH must never cause.
   */
  @Patch('suppliers/:id')
  @Roles(...INVENTORY_WRITE_ROLES)
  updateSupplier(@Param('id') id: string, @Body() body: UpdateSupplierDto) {
    const patch: UpdateSupplierInput = {};
    if ('name' in body) {
      patch.name = body.name;
    }
    if ('contactPhone' in body) {
      patch.contactPhone = body.contactPhone;
    }
    if ('contactEmail' in body) {
      patch.contactEmail = body.contactEmail;
    }
    return this.service.updateSupplier(this.connection(), id, patch);
  }

  /**
   * `204`, not `200 {}`: there is no representation left to return, and a body
   * claiming success would be the only thing a client could check.
   */
  @Delete('suppliers/:id')
  @HttpCode(204)
  @Roles(...INVENTORY_WRITE_ROLES)
  async deleteSupplier(@Param('id') id: string): Promise<void> {
    await this.service.deleteSupplier(this.connection(), id);
  }

  // -------------------------------------------------------- inventory items

  @Post('items')
  @Roles(...INVENTORY_WRITE_ROLES)
  async createItem(
    @Body() body: CreateInventoryItemDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.createItem(this.connection(), this.actor(req), {
      branchId: body.branchId,
      name: body.name,
      unit: body.unit,
      quantityOnHand: body.quantityOnHand,
      reorderThreshold: body.reorderThreshold,
      supplierId: body.supplierId ?? null,
    });
  }

  @Get('items')
  @Roles(...INVENTORY_READ_ROLES)
  listItems(
    @Query('branchId') branchId: string | undefined,
    @Req() req: AuthedRequest,
  ) {
    return this.service.listItems(this.connection(), this.actor(req), branchId);
  }

  @Get('items/:id')
  @Roles(...INVENTORY_READ_ROLES)
  getItem(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.getItem(this.connection(), this.actor(req), id);
  }

  /**
   * Receiving stock.
   *
   * `201` is not used: the movement is a sub-action on an existing item, and the
   * response is the item's new state, so `200` is the honest code.
   */
  @Post('items/:id/stock-in')
  @HttpCode(200)
  @Roles(...INVENTORY_WRITE_ROLES)
  stockIn(
    @Param('id') id: string,
    @Body() body: StockInDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.stockIn(
      this.connection(),
      this.actor(req),
      id,
      body.quantity,
      {
        note: body.note ?? null,
        // Who physically received it, for the audit trail. `null` rather than a
        // fabricated id if the request has no user, so a missing user is visible
        // in the data instead of hidden behind a placeholder.
        createdBy: req.user?.userId ?? null,
      },
    );
  }

  /**
   * A stocktake correction. See `AdjustStockDto` for why the note is mandatory
   * and why the delta is signed.
   */
  @Post('items/:id/adjust')
  @HttpCode(200)
  @Roles(...INVENTORY_WRITE_ROLES)
  adjustStock(
    @Param('id') id: string,
    @Body() body: AdjustStockDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.adjustStock(
      this.connection(),
      this.actor(req),
      id,
      body.quantity,
      body.note,
      req.user?.userId ?? null,
    );
  }

  @Get('items/:id/movements')
  @Roles(...INVENTORY_READ_ROLES)
  listMovements(@Param('id') id: string, @Req() req: AuthedRequest) {
    return this.service.listMovements(this.connection(), this.actor(req), id);
  }

  @Patch('items/:id/reorder-threshold')
  @Roles(...INVENTORY_WRITE_ROLES)
  setReorderThreshold(
    @Param('id') id: string,
    @Body() body: UpdateReorderThresholdDto,
    @Req() req: AuthedRequest,
  ) {
    return this.service.setReorderThreshold(
      this.connection(),
      this.actor(req),
      id,
      body.reorderThreshold,
    );
  }

  // --------------------------------------------------------------- recipes

  /**
   * The branch a recipe edit is happening at.
   *
   * A branch manager's token already carries their `branchId`, and it is the
   * branch they are standing in, so it is used directly. A tenant-wide operator
   * (`branchId === null`) has no such anchor, so they must name the branch — and
   * without it the request is refused rather than guessed, because guessing would
   * let a recipe be attached to an arbitrary branch's stock.
   */
  private recipeBranch(req: AuthedRequest, explicit?: string): string {
    const actor = this.actor(req);
    // The caller's SCOPE decides when they have one. An earlier version preferred
    // `explicit`, which handed a branch manager a one-parameter bypass: name
    // another branch in the query string and wire its stock into a recipe. A caller
    // confined to a branch can only ever act on that branch.
    if (actor.branchId !== null) {
      if (explicit !== undefined && explicit !== actor.branchId) {
        throw new BranchAccessDeniedException(
          'branch',
          actor.branchId,
          explicit,
        );
      }
      return actor.branchId;
    }
    // Tenant-wide: no branch to infer, so the caller must name one. Guessing would
    // attach a recipe to an arbitrary branch's stock.
    if (!explicit) {
      throw new BadRequestException(
        'A branch must be identified for this request: send ?branchId=... when the ' +
          'caller has no branch in their token.',
      );
    }
    return explicit;
  }

  @Post('recipes/ingredients')
  @HttpCode(204)
  @Roles(...INVENTORY_WRITE_ROLES)
  async setRecipeIngredient(
    @Body() body: SetRecipeIngredientDto,
    @Req() req: AuthedRequest,
    @Query('branchId') branchId?: string,
  ): Promise<void> {
    await this.service.setRecipeIngredient(
      this.connection(),
      this.actor(req),
      body,
      this.recipeBranch(req, branchId),
    );
  }

  @Delete('recipes/ingredients/:id')
  @HttpCode(204)
  @Roles(...INVENTORY_WRITE_ROLES)
  async removeRecipeIngredient(
    @Param('id') id: string,
    @Req() req: AuthedRequest,
  ): Promise<void> {
    await this.service.removeRecipeIngredient(
      this.connection(),
      this.actor(req),
      id,
    );
  }

  // --------------------------------------------------------- discrepancies

  /**
   * The review queue: deductions that did not fully happen.
   *
   * Defaults to `failed` + `partial` rather than every row, because the useful
   * question is "what do I need to fix?", and a list of 40,000 settled
   * deductions does not answer it.
   */
  @Get('discrepancies')
  @Roles(...INVENTORY_READ_ROLES)
  listDiscrepancies(
    @Req() req: AuthedRequest,
    @Query() query: ListDiscrepanciesQueryDto,
  ) {
    return this.service.listDiscrepancies(
      this.connection(),
      this.actor(req),
      query.status,
    );
  }

  /**
   * The request's tenant-scoped connection.
   *
   * Not a parameter anywhere: `TenantRequestContext` is request-scoped, so there
   * is exactly one connection per request and a handler cannot be handed the
   * wrong one.
   *
   * The tenant is not extracted here. The service reads it off this same
   * connection, so the value used for a write cannot disagree with the
   * `app.tenant_id` the RLS policies are actually enforcing.
   */
  private connection(): TenantScopedConnection {
    return this.tenantContext.getConnection();
  }

  /**
   * Who is asking, and how far they may reach.
   *
   * The scope comes from the ROLE, not from the presence of a branch in the token.
   * Onboarding creates the `org_owner` against the tenant's default branch, so
   * `org_owner.branchId` is a real branch id even though the role runs the whole
   * org. Keying the scope off the id would therefore confine the owner to the first
   * branch and refuse them everywhere else — which is how this check was first
   * written, and the e2e caught it immediately.
   *
   * `branch_manager` is the role that is confined to one branch, and there the
   * token's branch is authoritative. It is never taken from a request parameter:
   * a parameter is caller-controlled, so it would be a one-query bypass.
   */
  private actor(req: AuthedRequest): InventoryActor {
    const user = req.user;
    const runsTheOrg =
      user?.role === 'org_owner' || user?.role === 'super_admin';
    return { branchId: runsTheOrg ? null : (user?.branchId ?? null) };
  }
}
