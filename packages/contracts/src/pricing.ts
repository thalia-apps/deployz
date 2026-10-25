import { z } from 'zod';

import { FOOTPRINT_ENGINE_DISPLAY } from './footprint.js';
import type { DeploymentFootprint } from './footprint.js';

// Baseline monthly AWS cost estimate for a Deployment Footprint. Deliberately
// approximate: on-demand, single-instance baseline prices, heavily rounded
// ranges — never an exact bill. Adapters are keyed by the footprint's
// `service` values, so a future resource type degrades to
// `pricingStatus: 'unavailable'` (and `complete: false`) instead of being
// silently dropped. Pricing can never block a deployment: this module is
// pure, and nothing in the provisioning path consumes it.

export const footprintCostItemStatusSchema = z.enum(['estimated', 'usage_based', 'unavailable']);
export type FootprintCostItemStatus = z.infer<typeof footprintCostItemStatusSchema>;

export const footprintCostItemSchema = z
  .object({
    resourceId: z.string(),
    label: z.string(),
    monthlyMin: z.number().optional(),
    monthlyMax: z.number().optional(),
    pricingStatus: footprintCostItemStatusSchema,
  })
  .strict();
export type FootprintCostItem = z.infer<typeof footprintCostItemSchema>;

export const footprintCostEstimateSchema = z
  .object({
    currency: z.literal('USD'),
    monthlyMin: z.number().nullable(),
    monthlyMax: z.number().nullable(),
    /** False when any material item lacks a pricing adapter — the total is then incomplete. */
    complete: z.boolean(),
    items: z.array(footprintCostItemSchema),
    /** The variable, usage-billed costs the baseline deliberately excludes. */
    usageDependent: z.array(z.string()),
  })
  .strict();
export type FootprintCostEstimate = z.infer<typeof footprintCostEstimateSchema>;

/**
 * One pricing adapter: the baseline monthly range for ONE instance of the
 * service at the baseline region, plus — for usage-billed services — the
 * customer-facing sentence naming what varies. `monthly: null` marks a
 * service billed by usage only. Ranges are coarse on purpose (Linux,
 * on-demand, 730 h/month); do not add false precision.
 */
interface PricingAdapter {
  readonly monthly: { readonly min: number; readonly max: number } | null;
  readonly usageNote?: string;
}

// us-east-1 baseline values. Sourced from public AWS on-demand pricing;
// when AWS changes prices these stay deliberately stale until someone
// refreshes them — the UI always says "estimate". A sized service (Fargate,
// RDS, Valkey) carries one range per size the profile registry publishes,
// keyed by `sizeKey`; a size with no range prices as unavailable.
const BASELINE_PRICING: Readonly<Record<string, PricingAdapter>> = {
  alb: { monthly: { min: 15, max: 25 }, usageNote: 'Load balancer capacity (LCUs)' },
  'nat-gateway': { monthly: { min: 30, max: 40 }, usageNote: 'Data processed by the NAT gateway' },
  s3: { monthly: null, usageNote: 'Files stored in S3 and data transfer' },
  sqs: { monthly: null, usageNote: 'Messages sent to and received from queues' },
  'eventbridge-scheduler': { monthly: null, usageNote: 'Scheduled invocations' },
};

const RDS_PRICING: Readonly<Record<string, { readonly min: number; readonly max: number }>> = {
  'db.t4g.micro': { min: 14, max: 19 },
  'db.t3.micro': { min: 14, max: 19 },
  'db.t3.medium': { min: 50, max: 60 },
  'db.t3.large': { min: 100, max: 115 },
};

const SIZED_PRICING: Readonly<Record<string, { readonly sizes: Readonly<Record<string, { readonly min: number; readonly max: number }>>; readonly usageNote?: string }>> = {
  // Keyed by `${cpuUnits}/${memoryMiB}`.
  'ecs-fargate': {
    sizes: {
      '256/512': { min: 8, max: 11 },
      '1024/2048': { min: 33, max: 40 },
      '2048/4096': { min: 68, max: 80 },
    },
  },
  'rds-postgres': { sizes: RDS_PRICING, usageNote: 'Database storage growth and backups' },
  'rds-mysql': { sizes: RDS_PRICING, usageNote: 'Database storage growth and backups' },
  'elasticache-valkey': {
    sizes: {
      'cache.t4g.micro': { min: 12, max: 15 },
      'cache.t4g.small': { min: 18, max: 24 },
      'cache.t4g.medium': { min: 36, max: 45 },
    },
  },
};

/** The pricing adapter for one service at one size; `undefined` when there is none. */
function adapterFor(service: string, sizeKey: string | undefined): PricingAdapter | undefined {
  const sized = SIZED_PRICING[service];
  if (sized === undefined) return BASELINE_PRICING[service];
  const monthly = sizeKey === undefined ? undefined : sized.sizes[sizeKey];
  if (monthly === undefined) return undefined;
  return { monthly, ...(sized.usageNote !== undefined ? { usageNote: sized.usageNote } : {}) };
}

/**
 * Coarse per-region price buckets for the supported regions, relative to the
 * us-east-1 baseline (1.0). Approximation only — wide enough to stay honest
 * for a rounded range, never presented as exact regional pricing.
 */
const REGION_PRICE_FACTOR: Readonly<Record<string, number>> = {
  'us-east-1': 1.0,
  'us-east-2': 1.0,
  'us-west-1': 1.1,
  'us-west-2': 1.0,
  'ca-central-1': 1.1,
  'sa-east-1': 1.5,
  'eu-west-1': 1.1,
  'eu-west-2': 1.2,
  'eu-west-3': 1.2,
  'eu-central-1': 1.1,
  'eu-north-1': 1.1,
  'ap-northeast-1': 1.2,
  'ap-northeast-2': 1.2,
  'ap-northeast-3': 1.2,
  'ap-south-1': 1.1,
  'ap-southeast-1': 1.1,
  'ap-southeast-2': 1.3,
};

/** The size of a managed resource: its RDS instance type or cache node type. */
function resourceSizeKey(configuration: Record<string, unknown>): string | undefined {
  const size = configuration['instanceType'] ?? configuration['nodeType'];
  return typeof size === 'string' ? size : undefined;
}

/** Engine names make breakdown rows readable ("PostgreSQL" not "Database"). */
function itemLabel(entry: { label: string; configuration: Record<string, unknown> }, engineDisplay: Readonly<Record<string, string>>): string {
  const engine = typeof entry.configuration['engine'] === 'string' ? engineDisplay[entry.configuration['engine']] : undefined;
  return engine ?? entry.label;
}

const ONE_SHOT_WORKLOAD_ROLES: ReadonlySet<string> = new Set(['migration', 'scheduled-job']);

/**
 * The baseline monthly estimate for a footprint. Sums every workload and
 * resource item, applies the region bucket, rounds items to whole dollars
 * and the total to five-dollar steps. Unknown services become
 * `unavailable` items and flip `complete` to false — they are never
 * dropped and never guessed.
 */
export function estimateFootprintCost(footprint: DeploymentFootprint): FootprintCostEstimate {
  const factor = footprint.region === null ? 1 : (REGION_PRICE_FACTOR[footprint.region] ?? 1);
  const items: FootprintCostItem[] = [];
  const usageDependent = new Set<string>(['Outbound internet data transfer', 'Cross-AZ data transfer']);
  let minSum = 0;
  let maxSum = 0;
  let complete = true;

  const price = (entry: {
    id: string;
    label: string;
    service: string;
    sizeKey: string | undefined;
    quantity: number;
    configuration: Record<string, unknown>;
  }): void => {
    const label = itemLabel(entry, FOOTPRINT_ENGINE_DISPLAY);
    const adapter = adapterFor(entry.service, entry.sizeKey);
    if (adapter === undefined) {
      items.push({ resourceId: entry.id, label, pricingStatus: 'unavailable' });
      complete = false;
      return;
    }
    if (adapter.monthly === null) {
      items.push({ resourceId: entry.id, label, pricingStatus: 'usage_based' });
    } else {
      const min = Math.round(adapter.monthly.min * entry.quantity * factor);
      const max = Math.round(adapter.monthly.max * entry.quantity * factor);
      items.push({ resourceId: entry.id, label, monthlyMin: min, monthlyMax: max, pricingStatus: 'estimated' });
      minSum += min;
      maxSum += max;
    }
    if (adapter.usageNote !== undefined) usageDependent.add(adapter.usageNote);
  };

  for (const workload of footprint.workloads) {
    if (ONE_SHOT_WORKLOAD_ROLES.has(workload.role)) {
      items.push({ resourceId: workload.id, label: workload.label, pricingStatus: 'usage_based' });
      usageDependent.add('One-off tasks such as migrations and scheduled jobs');
      continue;
    }
    price({
      id: workload.id,
      label: workload.label,
      service: workload.compute.service,
      sizeKey: `${workload.compute.cpuUnits}/${workload.compute.memoryMiB}`,
      quantity: workload.quantity,
      configuration: {},
    });
  }
  for (const resource of footprint.resources) {
    price({
      id: resource.id,
      label: resource.label,
      service: resource.service,
      sizeKey: resourceSizeKey(resource.configuration),
      quantity: resource.quantity,
      configuration: resource.configuration,
    });
  }

  const hasEstimates = minSum > 0 || maxSum > 0;
  return {
    currency: 'USD',
    monthlyMin: hasEstimates ? Math.floor(minSum / 5) * 5 : null,
    monthlyMax: hasEstimates ? Math.ceil(maxSum / 5) * 5 : null,
    complete,
    items,
    usageDependent: [...usageDependent],
  };
}
