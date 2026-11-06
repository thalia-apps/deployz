import { z } from 'zod';

// Immutable infrastructure-size profile registry (MVP Readiness 2, Phase 1).
//
// A profile is the ONE source of truth for the AWS sizing of a deployment's
// application stack: how many vCPU/MiB the web/worker containers get, what
// RDS instance class and storage the managed PostgreSQL uses, and what
// ElastiCache node type/count the managed Valkey cache uses. It is
// deliberately DISTINCT from the graph-shaping `InfrastructureRequirements`
// (`{ postgres, redis }`) in `index.ts`, which selects the template variant;
// the size profile selects the sizes within that variant.
//
// Profiles are immutable: a published `id`+`version` never changes its values.
// A topology- or sizing-changing option (a future `minimal` profile, a
// different RDS class) requires a NEW version plus a new `infra_version` and a
// security review — it never mutates a published entry. `small-v1` is the
// original published profile. The current version of each size tier
// (`small-v2`, `medium-v1`, `large-v1`) is what new deployments freeze.

export const INFRASTRUCTURE_SIZE_PROFILE_SCHEMA_VERSION = 1 as const;

export interface InfrastructureSizeProfile {
  readonly id: string;
  readonly version: number;
  readonly label: string;
  readonly description: string;
  readonly workload: {
    readonly cpuUnits: number;
    readonly memoryMiB: number;
    readonly desiredCount: number;
  };
  readonly database: {
    readonly instanceClass: string;
    readonly storageGb: number;
    readonly maxStorageGb: number;
    readonly storageType: string;
  };
  readonly cache: {
    readonly nodeType: string;
    readonly nodeCount: number;
  };
}

export const SMALL_PROFILE: InfrastructureSizeProfile = {
  id: 'small',
  version: 1,
  label: 'Small',
  description:
    'A single web container (0.25 vCPU / 512 MiB), a db.t4g.micro PostgreSQL 16 or MySQL 8.0 instance (20 GB, gp2), and a single-node Valkey cache when the application needs one.',
  workload: {
    cpuUnits: 256,
    memoryMiB: 512,
    desiredCount: 1,
  },
  database: {
    instanceClass: 'db.t4g.micro',
    storageGb: 20,
    maxStorageGb: 100,
    storageType: 'gp2',
  },
  cache: {
    nodeType: 'cache.t4g.micro',
    nodeCount: 1,
  },
};

export const SMALL_V2_PROFILE: InfrastructureSizeProfile = {
  id: 'small',
  version: 2,
  label: 'Small',
  description:
    'A single web container (0.25 vCPU / 512 MiB), a db.t3.micro PostgreSQL 16 or MySQL 8.0 instance (20 GB, gp3), and a single-node Valkey cache when the application needs one.',
  workload: {
    cpuUnits: 256,
    memoryMiB: 512,
    desiredCount: 1,
  },
  database: {
    instanceClass: 'db.t3.micro',
    storageGb: 20,
    maxStorageGb: 100,
    storageType: 'gp3',
  },
  cache: {
    nodeType: 'cache.t4g.micro',
    nodeCount: 1,
  },
};

export const MEDIUM_PROFILE: InfrastructureSizeProfile = {
  id: 'medium',
  version: 1,
  label: 'Medium',
  description:
    'Each container gets 1 vCPU / 2 GiB, a db.t3.medium PostgreSQL 16 or MySQL 8.0 instance (20 GB, gp3), and a single-node cache.t4g.small Valkey cache when the application needs one.',
  workload: {
    cpuUnits: 1024,
    memoryMiB: 2048,
    desiredCount: 1,
  },
  database: {
    instanceClass: 'db.t3.medium',
    storageGb: 20,
    maxStorageGb: 100,
    storageType: 'gp3',
  },
  cache: {
    nodeType: 'cache.t4g.small',
    nodeCount: 1,
  },
};

export const LARGE_PROFILE: InfrastructureSizeProfile = {
  id: 'large',
  version: 1,
  label: 'Large',
  description:
    'Each container gets 2 vCPU / 4 GiB, a db.t3.large PostgreSQL 16 or MySQL 8.0 instance (20 GB, gp3), and a single-node cache.t4g.medium Valkey cache when the application needs one.',
  workload: {
    cpuUnits: 2048,
    memoryMiB: 4096,
    desiredCount: 1,
  },
  database: {
    instanceClass: 'db.t3.large',
    storageGb: 20,
    maxStorageGb: 100,
    storageType: 'gp3',
  },
  cache: {
    nodeType: 'cache.t4g.medium',
    nodeCount: 1,
  },
};

// The published registry. Adding a new profile appends here; it never edits
// a published entry. A new version of a tier also moves that tier's entry in
// `CURRENT_PROFILE_BY_TIER`.
export const INFRASTRUCTURE_SIZE_PROFILES: readonly InfrastructureSizeProfile[] = [
  SMALL_PROFILE,
  SMALL_V2_PROFILE,
  MEDIUM_PROFILE,
  LARGE_PROFILE,
];

/** The size tiers a vendor or customer can choose, smallest first. */
export const INFRASTRUCTURE_SIZE_TIERS = ['small', 'medium', 'large'] as const;
export const infrastructureSizeTierSchema = z.enum(INFRASTRUCTURE_SIZE_TIERS);
export type InfrastructureSizeTier = z.infer<typeof infrastructureSizeTierSchema>;

/**
 * The tiers offered for NEW selections. The pilot offers Small only: Medium and
 * Large are not certified on real AWS. Add a tier here to offer it again.
 * Deployments that already froze a Medium or Large profile are not affected.
 */
export const SELECTABLE_SIZE_TIERS: InfrastructureSizeTier[] = ['small'];

/** The Deployz default tier: the last step of the selection precedence. */
export const DEFAULT_INFRASTRUCTURE_SIZE_TIER: InfrastructureSizeTier = 'small';

// The version of each tier that a NEW deployment freezes.
const CURRENT_PROFILE_BY_TIER: Readonly<Record<InfrastructureSizeTier, InfrastructureSizeProfile>> = {
  small: SMALL_V2_PROFILE,
  medium: MEDIUM_PROFILE,
  large: LARGE_PROFILE,
};

/** The profile a new deployment of `tier` freezes. */
export function currentInfrastructureSizeProfile(tier: InfrastructureSizeTier): InfrastructureSizeProfile {
  return CURRENT_PROFILE_BY_TIER[tier];
}

/** True when `tier` is the same size as `minimum` or bigger. */
export function sizeTierMeetsMinimum(tier: InfrastructureSizeTier, minimum: InfrastructureSizeTier): boolean {
  return INFRASTRUCTURE_SIZE_TIERS.indexOf(tier) >= INFRASTRUCTURE_SIZE_TIERS.indexOf(minimum);
}

/** The selectable tiers a selection may use when `minimum` is the smallest supported size. */
export function allowedSizeTiers(minimum: InfrastructureSizeTier): InfrastructureSizeTier[] {
  return INFRASTRUCTURE_SIZE_TIERS.filter(
    (tier) => SELECTABLE_SIZE_TIERS.includes(tier) && sizeTierMeetsMinimum(tier, minimum),
  );
}

const PROFILES_BY_KEY = new Map<string, InfrastructureSizeProfile>(
  INFRASTRUCTURE_SIZE_PROFILES.map((profile) => [profileKey(profile), profile]),
);

/** The stable registry key for a profile: `small-v1`, `small-v2`, `medium-v1`. */
export function profileKey(profile: InfrastructureSizeProfile): string {
  return `${profile.id}-v${profile.version}`;
}

/** Resolve a published profile by id + version; `undefined` when unknown. */
export function resolveInfrastructureSizeProfile(
  id: string,
  version: number,
): InfrastructureSizeProfile | undefined {
  return PROFILES_BY_KEY.get(`${id}-v${version}`);
}

/** The current default profile for newly created deployments. */
export function defaultInfrastructureSizeProfile(): InfrastructureSizeProfile {
  return currentInfrastructureSizeProfile(DEFAULT_INFRASTRUCTURE_SIZE_TIER);
}

// Deployments created before the registry stored no reference. They were
// built with small-v2 sizing, so they resolve to small-v2 even when the
// default tier or its current version changes later.
const LEGACY_DEPLOYMENT_PROFILE = SMALL_V2_PROFILE;

/** Zod schema for the frozen profile reference stored in a deployment's desired state. */
export const infrastructureSizeProfileRefSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().min(1),
  })
  .strict();
export type InfrastructureSizeProfileRef = z.infer<typeof infrastructureSizeProfileRefSchema>;

/**
 * Resolve the profile a deployment was frozen with, from its desired state.
 * Existing deployments (no stored profile) resolve safely to `small-v2`. A
 * stored reference that does not resolve to a published profile returns
 * `undefined` — callers must fail closed rather than guess a size.
 */
export function resolveStoredInfrastructureSizeProfile(
  desiredState: Record<string, unknown> | null | undefined,
): InfrastructureSizeProfile | undefined {
  const ref = (desiredState as { infrastructureProfile?: unknown } | null | undefined)?.infrastructureProfile;
  if (ref === undefined) return LEGACY_DEPLOYMENT_PROFILE;
  const parsed = infrastructureSizeProfileRefSchema.safeParse(ref);
  if (!parsed.success) return undefined;
  return resolveInfrastructureSizeProfile(parsed.data.id, parsed.data.version);
}
