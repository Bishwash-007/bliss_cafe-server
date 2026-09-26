import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ReorderAlertStrategy } from './reorder-alert.strategy';

/**
 * Multi-provider token: every registered strategy, in registration order.
 *
 * An array token rather than a single `REORDER_ALERT_STRATEGY` provider, because
 * that is what makes "swap the strategy" a data change instead of a code change.
 * Adding `PredictiveAlertStrategy` to `providers` makes it resolvable by name
 * immediately, with no edit to the registry, the service, or any call site.
 */
export const REORDER_ALERT_STRATEGIES = 'REORDER_ALERT_STRATEGIES';

/** Strategy used when a tenant has no explicit choice. */
export const DEFAULT_REORDER_STRATEGY = 'threshold';

/**
 * Token for the `ReorderStrategyConfig` implementation.
 *
 * Required, not optional sugar: an interface parameter emits `design:type` as
 * `Object`, which Nest cannot resolve, so the constructor parameter needs an
 * explicit token or the module fails to boot.
 */
export const REORDER_STRATEGY_CONFIG = 'REORDER_STRATEGY_CONFIG';

/**
 * Where a tenant's chosen strategy name comes from.
 *
 * Deliberately a seam with no real implementation behind it yet: there is no
 * tenant settings table in the schema, and inventing one is out of scope for
 * this module. Everything downstream asks this interface, so nothing downstream
 * changes when a real source arrives — this is the only thing that would.
 */
export interface ReorderStrategyConfig {
  /** Strategy name configured for this tenant, or `null` to use the default. */
  strategyFor(tenantId: string): string | null;
}

/** Config used until a tenant settings store exists: everyone gets the default. */
@Injectable()
export class DefaultReorderStrategyConfig implements ReorderStrategyConfig {
  strategyFor(): string | null {
    return null;
  }
}

/**
 * Resolves the strategy in force for a tenant.
 *
 * Every call site asks the registry, never a strategy directly. That is what
 * keeps the "swapped in via tenant config" promise honest: exactly one place
 * decides which implementation runs, so a new strategy cannot be added in a way
 * that only some call sites honour.
 */
@Injectable()
export class ReorderStrategyRegistry {
  private readonly logger = new Logger(ReorderStrategyRegistry.name);
  private readonly byName: Map<string, ReorderAlertStrategy>;
  private readonly fallback: ReorderAlertStrategy;

  constructor(
    @Inject(REORDER_ALERT_STRATEGIES)
    strategies: readonly ReorderAlertStrategy[],
    @Inject(REORDER_STRATEGY_CONFIG)
    private readonly config: ReorderStrategyConfig,
  ) {
    for (const duplicate of findDuplicateNames(strategies)) {
      // Two strategies claiming one name would make a tenant's saved choice
      // resolve to whichever the DI container happened to build last.
      throw new Error(
        `Duplicate ReorderAlertStrategy name '${duplicate}'. Strategy names are the tenant-config key and must be unique.`,
      );
    }

    this.byName = new Map(strategies.map((s) => [s.name, s]));

    const fallback = this.byName.get(DEFAULT_REORDER_STRATEGY);
    if (!fallback) {
      // Failing loudly at boot beats every low-stock alert silently never firing.
      throw new Error(
        `No ReorderAlertStrategy named '${DEFAULT_REORDER_STRATEGY}' is registered.`,
      );
    }
    this.fallback = fallback;
  }

  /** Names available for tenant configuration, for an admin surface to list. */
  availableStrategies(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * The strategy for a tenant.
   *
   * A configured name that is not registered also falls back, and says so: a typo
   * in tenant config must degrade to the default rather than take reordering
   * offline.
   */
  forTenant(tenantId: string): ReorderAlertStrategy {
    const configured = this.config.strategyFor(tenantId);
    if (configured === null) {
      return this.fallback;
    }
    return (
      this.byName.get(configured) ?? this.warnAndFallBack(tenantId, configured)
    );
  }

  private warnAndFallBack(
    tenantId: string,
    configured: string,
  ): ReorderAlertStrategy {
    this.logger.warn(
      `Tenant ${tenantId} configured unknown reorder strategy '${configured}'; ` +
        `falling back to '${DEFAULT_REORDER_STRATEGY}'.`,
    );
    return this.fallback;
  }
}

function findDuplicateNames(
  strategies: readonly ReorderAlertStrategy[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const strategy of strategies) {
    if (seen.has(strategy.name)) {
      duplicates.add(strategy.name);
    }
    seen.add(strategy.name);
  }
  return [...duplicates];
}
