import { z } from 'zod';

import { INFRASTRUCTURE_COMPONENT_DISPLAY } from './infrastructure.js';
import { INFRASTRUCTURE_COMPONENTS, requiredInfrastructureComponents } from './components.js';
import { deploymentPlanAwsResourceSchema, requiredAwsResources, toPlanAwsResource } from './aws-resources.js';
import type { DeploymentPlanAwsResource } from './aws-resources.js';
import { declaredParts, resolveDeploymentFootprint, deploymentFootprintSchema } from './footprint.js';
import type { DeclaredPart, DeploymentFootprint } from './footprint.js';
import { estimateFootprintCost, footprintCostEstimateSchema } from './pricing.js';
import type { FootprintCostEstimate } from './pricing.js';
import type { InfrastructureComponentDefinition } from './components.js';
import type { ApplicationGraph } from './application-graph.js';
import { PLAN_COMPONENT_GROUP_BY_KIND } from './plan-components.js';
import type { DeploymentManifest } from './manifest.js';
// Value imports from './index.js' are used ONLY inside function bodies below
// (never at this module's top level) — `plan.ts` is re-exported from
// `index.ts`, so a top-level reference to a value still being initialized
// there (e.g. `regionSchema`) would throw. `regionSchema` itself is only
// reachable from a lazy schema for the same reason.
import { regionSchema } from './index.js';
import type { InfrastructureRequirements, Region } from './index.js';
import type { InfrastructureSizeProfile } from './profile.js';

// A deployment plan — the deterministic, derived-only description of what
// INSTALL/UPDATE/DESTROY will do to a deployment's infrastructure. Built
// entirely from the manifest's requirement booleans (the same two values the
// graph→planner chain reads), the component catalog (`components.ts`) and the
// AWS resource catalog (`aws-resources.ts`); never from AWS, never from an
// LLM. When the deployment carries a compiled spec, its persisted compiler
// footprint is used verbatim so display and provisioning cannot disagree.
// See docs/architecture.md "Deployment plans".

/** The graph-shaping requirement booleans, straight from the manifest. */
function manifestRequirements(manifest: Pick<DeploymentManifest, 'database' | 'redis'>): InfrastructureRequirements {
  return { postgres: manifest.database.postgres, redis: manifest.redis.required };
}

export const DEPLOYMENT_PLAN_SCHEMA_VERSION = 1 as const;

export const planActionSchema = z.enum(['INSTALL', 'UPDATE', 'DESTROY']);
export type PlanAction = z.infer<typeof planActionSchema>;

export const planComponentActionSchema = z.enum(['CREATE', 'UPDATE', 'UNCHANGED', 'DELETE', 'RETAIN']);
export type PlanComponentAction = z.infer<typeof planComponentActionSchema>;

// 'worker', 'queue' and 'schedule' describe a manifest's declared workers,
// queues and scheduled jobs (asyncPlanEntries) and the spec-derived
// component builder (plan-components.ts).
export const planComponentKindSchema = z.enum([
  'application',
  'endpoint',
  'database',
  'cache',
  'storage',
  'worker',
  'queue',
  'schedule',
]);
export type PlanComponentKind = z.infer<typeof planComponentKindSchema>;

/** Presentation grouping for plan components, in display order. */
export const planComponentGroupSchema = z.enum([
  'application',
  'data',
  'cache',
  'storage',
  'messaging',
  'networking',
  'edge',
  'security',
]);
export type PlanComponentGroup = z.infer<typeof planComponentGroupSchema>;

/** Group headings in display order — the one source the UI renders plan groups from. */
export const PLAN_COMPONENT_GROUP_ORDER: readonly PlanComponentGroup[] = [
  'application',
  'data',
  'cache',
  'storage',
  'messaging',
  'networking',
  'edge',
  'security',
];

/** Human names for plan component groups (wording matches the footprint categories). */
export const PLAN_COMPONENT_GROUP_DISPLAY: Readonly<Record<PlanComponentGroup, string>> = {
  application: 'Application',
  data: 'Data',
  cache: 'Cache',
  storage: 'Storage',
  messaging: 'Messaging',
  networking: 'Networking',
  edge: 'Edge',
  security: 'Security',
};

export const deploymentPlanComponentSchema = z
  .object({
    kind: planComponentKindSchema,
    name: z.string(),
    action: planComponentActionSchema,
    lifecycle: z.enum(['delete', 'retain']),
    /** IR component id when the plan is derived from a frozen spec; absent on manifest-derived plans. */
    componentId: z.string().optional(),
    /** Presentation grouping — derived from kind via PLAN_COMPONENT_GROUP_BY_KIND. */
    group: planComponentGroupSchema.optional(),
  })
  .strict();
export type DeploymentPlanComponent = z.infer<typeof deploymentPlanComponentSchema>;

/**
 * Release-vs-infrastructure statement. 'none': the release changes code only.
 * 'unsupported': the release's topology differs from the deployed frozen spec
 * and automatic infrastructure upgrades are not supported — deployments must
 * fail closed. The reason currently carries 'topology_changed'.
 */
export const infrastructureChangeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('none') }).strict(),
  z.object({ status: z.literal('unsupported'), reason: z.string().min(1) }).strict(),
]);
export type InfrastructureChange = z.infer<typeof infrastructureChangeSchema>;

const planRequirementDriftSchema = z
  .object({
    kind: z.enum(['database', 'cache', 'engine', 'workload', 'queue', 'schedule']),
    /** The component the entry names — absent for database/cache. For `engine`, the desired engine. */
    name: z.string().optional(),
    deployed: z.boolean(),
    desired: z.boolean(),
  })
  .strict();

export const deploymentPlanSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_PLAN_SCHEMA_VERSION),
    action: planActionSchema,
    region: z.lazy(() => regionSchema).nullable(),
    components: z.array(deploymentPlanComponentSchema),
    /** The meaningful AWS resources behind `components` — the "AWS
     *  infrastructure details" preview. Same profile rule as the components,
     *  so the two lists can never disagree. */
    awsResources: z.array(deploymentPlanAwsResourceSchema),
    /** The resolved Deployment Footprint (workloads + managed resources with
     *  exact sizing) for the same manifest — optional so payloads built
     *  before the field existed stay valid. Lazy for the same init-order
     *  reason as `region`: footprint.ts is initialized through the
     *  index.ts cycle and must not be read while plan.ts is evaluating. */
    footprint: z.lazy(() => deploymentFootprintSchema).nullable().optional(),
    /** Baseline monthly AWS cost estimate for `footprint`. Optional for the
     *  same reason; display stays approximate and never blocks deployment. */
    costEstimate: z.lazy(() => footprintCostEstimateSchema).nullable().optional(),
    /** UPDATE only — requirement differences the current architecture cannot apply in place. Empty otherwise. */
    requirementDrift: z.array(planRequirementDriftSchema),
    /** Release-vs-infrastructure statement — absent on plans built before the field existed. */
    infrastructureChange: infrastructureChangeSchema.optional(),
  })
  .strict();
export type DeploymentPlan = z.infer<typeof deploymentPlanSchema>;

// The five catalog components only ever carry 'delete' or 'retain' (the
// other two InfrastructureLifecycle values describe supporting resources
// outside this catalog) — narrow rather than widen the plan schema for them.
function toPlanComponent(
  component: InfrastructureComponentDefinition,
  action: PlanComponentAction,
): DeploymentPlanComponent {
  return {
    kind: component.kind,
    name: INFRASTRUCTURE_COMPONENT_DISPLAY[component.kind].name,
    action,
    lifecycle: component.lifecycle === 'retain' ? 'retain' : 'delete',
  };
}

/** Requirement drift for one catalog kind — null when the two profiles agree. */
function driftFor(
  kind: 'database' | 'cache',
  deployedProfile: InfrastructureRequirements,
  desiredProfile: InfrastructureRequirements,
): DeploymentPlan['requirementDrift'][number] | null {
  const component = INFRASTRUCTURE_COMPONENTS.find((candidate) => candidate.kind === kind)!;
  const deployed = component.requiredBy(deployedProfile);
  const desired = component.requiredBy(desiredProfile);
  return deployed === desired ? null : { kind, deployed, desired };
}

/** Requirement drift between two profiles — shared by buildUpdatePlan and the readiness API's per-deployment summary. */
export function requirementDriftFor(
  deployedProfile: InfrastructureRequirements,
  desiredProfile: InfrastructureRequirements,
): DeploymentPlan['requirementDrift'] {
  return [driftFor('database', deployedProfile, desiredProfile), driftFor('cache', deployedProfile, desiredProfile)].filter(
    (entry): entry is DeploymentPlan['requirementDrift'][number] => entry !== null,
  );
}

function idSetDrift(
  kind: 'workload' | 'queue' | 'schedule',
  deployed: ReadonlySet<string>,
  desired: ReadonlySet<string>,
): DeploymentPlan['requirementDrift'] {
  return [...new Set([...deployed, ...desired])]
    .filter((name) => deployed.has(name) !== desired.has(name))
    .sort()
    .map((name) => ({ kind, name, deployed: deployed.has(name), desired: desired.has(name) }));
}

/**
 * Topology differences between a deployment's frozen graph and the graph the
 * application wants now, beyond database/cache presence: the database engine,
 * the workload set (the migration step is governed by the migration policy,
 * not by topology), queues and schedules. A frozen stack cannot apply any of
 * them in place.
 */
export function topologyDriftFor(deployed: ApplicationGraph, desired: ApplicationGraph): DeploymentPlan['requirementDrift'] {
  const engineOf = (graph: ApplicationGraph): string | null =>
    graph.resources.find((resource) => resource.kind === 'relational_database')?.engine ?? null;
  const ids = (items: readonly { id: string }[]): ReadonlySet<string> => new Set(items.map((item) => item.id));
  const workloads = (graph: ApplicationGraph): ReadonlySet<string> =>
    ids(graph.workloads.filter((workload) => workload.kind !== 'migration'));
  const queues = (graph: ApplicationGraph): ReadonlySet<string> =>
    ids(graph.resources.filter((resource) => resource.kind === 'queue'));
  const deployedEngine = engineOf(deployed);
  const desiredEngine = engineOf(desired);
  return [
    ...(deployedEngine !== null && desiredEngine !== null && deployedEngine !== desiredEngine
      ? [{ kind: 'engine' as const, name: desiredEngine, deployed: false, desired: true }]
      : []),
    ...idSetDrift('workload', workloads(deployed), workloads(desired)),
    ...idSetDrift('queue', queues(deployed), queues(desired)),
    ...idSetDrift('schedule', ids(deployed.schedules ?? []), ids(desired.schedules ?? [])),
  ];
}

/**
 * The footprint + baseline cost estimate every plan carries. The compiler's
 * persisted footprint is used verbatim when given; otherwise it is derived
 * from the SAME manifest and region as the plan itself, so the displayed
 * sizing can never disagree with the plan's components. Pricing is
 * decorative — nothing in provisioning reads it, and a pricing adapter gap
 * degrades the estimate, never the plan.
 */
function footprintFor(input: {
  manifest: DeploymentManifest;
  region: Region | null;
  infraVersion: string | null;
  profile?: InfrastructureSizeProfile;
  compiledFootprint?: DeploymentFootprint;
}): {
  footprint: DeploymentFootprint;
  costEstimate: FootprintCostEstimate;
} {
  const footprint =
    input.compiledFootprint ??
    resolveDeploymentFootprint({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
    });
  return { footprint, costEstimate: estimateFootprintCost(footprint) };
}

const ASYNC_PART_PLAN: Readonly<
  Record<DeclaredPart['kind'], { kind: 'worker' | 'queue' | 'schedule'; awsSuffix: string; purpose: string }>
> = {
  worker: { kind: 'worker', awsSuffix: 'ECS Fargate', purpose: 'Runs the background process and restarts it if it stops' },
  'scheduled-job': {
    kind: 'worker',
    awsSuffix: 'ECS Fargate task',
    purpose: 'Runs the scheduled job each time its schedule starts it',
  },
  queue: { kind: 'queue', awsSuffix: 'SQS', purpose: 'Holds messages for the application to process in the background' },
  'dead-letter-queue': {
    kind: 'queue',
    awsSuffix: 'SQS',
    purpose: 'Keeps messages that could not be processed so they can be inspected',
  },
  schedule: {
    kind: 'schedule',
    awsSuffix: 'EventBridge Scheduler',
    purpose: 'Starts the scheduled job at the times the application declares',
  },
};

/**
 * The components and AWS resources of the manifest's declared workers,
 * scheduled jobs, queues and schedules. Ids match the footprint, so a row
 * finds its cost item. Empty for an application without any of them.
 */
function asyncPlanEntries(manifest: DeploymentManifest): {
  components: DeploymentPlanComponent[];
  awsResources: DeploymentPlanAwsResource[];
} {
  const parts = declaredParts(manifest).map((part) => ({ part, plan: ASYNC_PART_PLAN[part.kind] }));
  return {
    components: parts.map(({ part, plan }) => ({
      kind: plan.kind,
      name: part.name,
      action: 'CREATE',
      lifecycle: 'delete',
      componentId: part.id,
      group: PLAN_COMPONENT_GROUP_BY_KIND[plan.kind],
    })),
    awsResources: parts.map(({ part, plan }) => ({
      id: part.id,
      name: `${part.name} (${plan.awsSuffix})`,
      purpose: plan.purpose,
      group: plan.kind === 'queue' ? 'data' : 'compute_networking',
      componentKind: plan.kind === 'worker' ? 'application' : plan.kind,
      lifecycle: 'delete',
    })),
  };
}

/** INSTALL plan — every required component is CREATE. */
export function buildInstallPlan(input: {
  manifest: DeploymentManifest;
  region: Region | null;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const profile = manifestRequirements(input.manifest);
  const asyncEntries = asyncPlanEntries(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'INSTALL',
    region: input.region,
    components: [
      ...requiredInfrastructureComponents(profile).map((component) => toPlanComponent(component, 'CREATE')),
      ...asyncEntries.components,
    ],
    awsResources: [...requiredAwsResources(profile).map(toPlanAwsResource), ...asyncEntries.awsResources],
    ...footprintFor({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: [],
  };
}

/**
 * UPDATE plan — the MVP boundary means topology never changes on an
 * existing deployment: application is UPDATE when a newer release exists,
 * every other component of the DEPLOYED profile is UNCHANGED, and any
 * difference between the deployed and desired profiles is reported as
 * `requirementDrift`, never as a CREATE/DELETE action.
 */
export function buildUpdatePlan(input: {
  deployedManifest: DeploymentManifest;
  desiredManifest: DeploymentManifest;
  region: Region;
  newRelease: boolean;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const deployedProfile = manifestRequirements(input.deployedManifest);
  const desiredProfile = manifestRequirements(input.desiredManifest);
  const components = requiredInfrastructureComponents(deployedProfile).map((component) =>
    toPlanComponent(component, component.kind === 'application' && input.newRelease ? 'UPDATE' : 'UNCHANGED'),
  );
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'UPDATE',
    region: input.region,
    components,
    awsResources: requiredAwsResources(deployedProfile).map(toPlanAwsResource),
    ...footprintFor({
      manifest: input.deployedManifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: requirementDriftFor(deployedProfile, desiredProfile),
  };
}

/** DESTROY plan — required components DELETE (lifecycle 'delete') or RETAIN (lifecycle 'retain'). */
export function buildDestroyPlan(input: {
  manifest: DeploymentManifest;
  region: Region;
  infraVersion?: string | null;
  profile?: InfrastructureSizeProfile;
  /** The compiler's persisted footprint (spec_v2.footprint) when known. */
  compiledFootprint?: DeploymentFootprint;
}): DeploymentPlan {
  const profile = manifestRequirements(input.manifest);
  return {
    schemaVersion: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    action: 'DESTROY',
    region: input.region,
    components: requiredInfrastructureComponents(profile).map((component) =>
      toPlanComponent(component, component.lifecycle === 'delete' ? 'DELETE' : 'RETAIN'),
    ),
    awsResources: requiredAwsResources(profile).map(toPlanAwsResource),
    ...footprintFor({
      manifest: input.manifest,
      region: input.region,
      infraVersion: input.infraVersion ?? null,
      ...(input.profile !== undefined ? { profile: input.profile } : {}),
      ...(input.compiledFootprint !== undefined ? { compiledFootprint: input.compiledFootprint } : {}),
    }),
    requirementDrift: [],
  };
}
