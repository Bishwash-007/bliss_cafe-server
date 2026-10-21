import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { OrderType } from '../events/order-events';

/**
 * Order write payloads.
 *
 * The transport layer now rejects missing/wrongly-typed fields. The
 * *semantic* rules (is that a real menu item? is that status known? is that
 * transition legal?) stay in `OrderService`, where they can be tested directly
 * and reused by non-HTTP callers.
 *
 * ## Money is NOT accepted from the client
 *
 * There is deliberately no `unitPrice`, `subtotal` or `total` field anywhere in
 * these DTOs. Every monetary figure is derived server-side from `menu_items`
 * and `menu_item_modifiers` at order time (see `OrderService.price`), and the
 * result is frozen onto the order row — which is why historic orders keep
 * showing what they were sold at after the menu is edited. A client that could
 * post its own `totalAmount` would be a client that can sell a flat white for
 * one cent.
 */
export class CreateOrderModifierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  optionName!: string;

  @IsOptional()
  @IsString()
  modifierId?: string | null;
}

export class CreateOrderItemDto {
  @IsString()
  @IsNotEmpty()
  menuItemId!: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string | null;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOrderModifierDto)
  modifiers?: CreateOrderModifierDto[];
}

export class CreateOrderDto {
  /** Which branch's kitchen this ticket belongs to (the KDS room). */
  @IsString()
  @IsNotEmpty()
  branchId!: string;

  /** Required for `dine_in`; the service enforces that pairing. */
  @IsOptional()
  @IsString()
  tableId?: string | null;

  @IsOptional()
  @IsString()
  customerId?: string | null;

  @IsOptional()
  @IsString()
  orderType?: OrderType;

  /**
   * Idempotency key from the mobile offline action queue.
   *
   * Supplying it makes creation safe to retry: a second POST carrying the same
   * key returns the ORIGINAL order instead of failing on the
   * `idx_orders_client_action` unique index.
   */
  @IsOptional()
  @IsString()
  @MaxLength(150)
  clientActionId?: string | null;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  /**
   * Known gap, called out here so nobody mistakes it for a finished feature:
   * the schema has no tenant-level tax rate or currency setting yet (the
   * `tax_amount` column exists, `tenants` has no `tax_rate`), so there is no
   * server-side source of truth to compute tax from. Until that settings
   * column lands, callers may pass the amount their POS already calculated;
   * when omitted it is 0. Same story for `discountAmount` — a real
   * implementation belongs with the per-tenant tax/discount rules and the
   * audit log the design calls for.
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  taxAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountAmount?: number;
}

/** Requested target status for `POST /orders/:id/transition`. */
export class TransitionOrderDto {
  @IsString()
  @IsNotEmpty()
  status!: string;
}
