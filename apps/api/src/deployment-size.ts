import crypto from 'node:crypto';

import {
  allowedSizeTiers,
  currentInfrastructureSizeProfile,
  DEFAULT_INFRASTRUCTURE_SIZE_TIER,
  profileKey,
  SELECTABLE_SIZE_TIERS,
  sizeTierMeetsMinimum,
  type DeploymentFootprint,
  type FootprintCostEstimate,
  type InfrastructureSizeProfile,
  type InfrastructureSizeTier,
} from '@deployz/contracts';
import type * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// Deployment sizing (docs/infrastructure-profiles.md). One resolution serves
// every creation path, so a preview, a price and the compiled stack can never
// use different profiles. Precedence: customer choice → link recommendation →
// application default → Deployz default. The minimum is the link's frozen
// minimum, else the application's current minimum.

type ApplicationRow = typeof schema.applications.$inferSelect;

/** The link-frozen sizing; null fields follow the application's settings. */
export interface LinkSizing {
  readonly recommended: InfrastructureSizeTier | null;
  readonly minimum: InfrastructureSizeTier | null;
}

export interface SizeSelection {
  readonly tier: InfrastructureSizeTier;
  readonly profile: InfrastructureSizeProfile;
  readonly recommended: InfrastructureSizeTier;
  readonly minimum: InfrastructureSizeTier;
}

// A stored setting for a tier that is not selectable now resolves to the Deployz default.
function selectableOrDefault(tier: InfrastructureSizeTier | null | undefined): InfrastructureSizeTier {
  return tier && SELECTABLE_SIZE_TIERS.includes(tier) ? tier : DEFAULT_INFRASTRUCTURE_SIZE_TIER;
}

/** The recommendation and minimum that apply to a new deployment. */
export function sizingBounds(
  application: Pick<ApplicationRow, 'defaultSizeProfile' | 'minimumSizeProfile'>,
  link?: LinkSizing,
): { recommended: InfrastructureSizeTier; minimum: InfrastructureSizeTier } {
  const minimum = selectableOrDefault(link?.minimum ?? application.minimumSizeProfile);
  const preferred = selectableOrDefault(link?.recommended ?? application.defaultSizeProfile);
  return { recommended: sizeTierMeetsMinimum(preferred, minimum) ? preferred : minimum, minimum };
}

/**
 * The size a new deployment freezes. A requested size below the minimum is
 * refused (422), never raised silently: the caller showed a plan for it.
 */
export function resolveSizeSelection(
  application: Pick<ApplicationRow, 'defaultSizeProfile' | 'minimumSizeProfile'>,
  requested: InfrastructureSizeTier | undefined,
  link?: LinkSizing,
): SizeSelection {
  const { recommended, minimum } = sizingBounds(application, link);
  const tier = requested ?? recommended;
  const allowed = allowedSizeTiers(minimum);
  if (!allowed.includes(tier)) {
    throw new ApiError(
      422,
      'SIZE_PROFILE_NOT_ALLOWED',
      sizeTierMeetsMinimum(tier, minimum)
        ? `The ${tier} size is not available yet.`
        : `The ${tier} size is below the minimum size (${minimum}) for this application.`,
      { minimum, allowed },
    );
  }
  return { tier, profile: currentInfrastructureSizeProfile(tier), recommended, minimum };
}

/** Refuses a vendor default below the vendor minimum. */
export function assertSizeSettingsValid(defaultTier: InfrastructureSizeTier, minimumTier: InfrastructureSizeTier): void {
  if (!sizeTierMeetsMinimum(defaultTier, minimumTier)) {
    throw new ApiError(
      422,
      'SIZE_DEFAULT_BELOW_MINIMUM',
      'The recommended size must be the same as the minimum size or bigger.',
    );
  }
}

/** One size the customer or vendor can choose, with its exact resources. */
export interface SizeOption {
  readonly id: InfrastructureSizeTier;
  readonly profileKey: string;
  readonly label: string;
  readonly description: string;
  readonly recommended: boolean;
  readonly workload: InfrastructureSizeProfile['workload'];
  readonly database: Pick<InfrastructureSizeProfile['database'], 'instanceClass' | 'storageGb'>;
  readonly cache: InfrastructureSizeProfile['cache'];
}

/** The permitted sizes for a review page, smallest first. */
export function sizeOptions(bounds: { recommended: InfrastructureSizeTier; minimum: InfrastructureSizeTier }): SizeOption[] {
  return allowedSizeTiers(bounds.minimum).map((tier) => {
    const profile = currentInfrastructureSizeProfile(tier);
    return {
      id: tier,
      profileKey: profileKey(profile),
      label: profile.label,
      description: profile.description,
      recommended: tier === bounds.recommended,
      workload: profile.workload,
      database: { instanceClass: profile.database.instanceClass, storageGb: profile.database.storageGb },
      cache: profile.cache,
    };
  });
}

/**
 * The fingerprint of the plan a customer approves: the link, the Region, the
 * exact profile version, and the compiled footprint and estimate. The server
 * recomputes it at confirmation from its own state; any difference (a stale
 * page, a changed application, an edited request) refuses the confirmation.
 */
export function planFingerprint(input: {
  linkId: string;
  region: string;
  profile: InfrastructureSizeProfile;
  footprint: DeploymentFootprint;
  costEstimate: FootprintCostEstimate;
}): string {
  const canonical = JSON.stringify({
    linkId: input.linkId,
    region: input.region,
    profile: profileKey(input.profile),
    footprint: input.footprint,
    costEstimate: input.costEstimate,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function planChangedError(): ApiError {
  return new ApiError(
    409,
    'PLAN_CHANGED',
    'The installation plan changed after you reviewed it. Review the updated plan and confirm again.',
  );
}
