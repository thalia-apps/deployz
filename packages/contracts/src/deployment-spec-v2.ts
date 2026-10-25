import { z } from 'zod';

import { applicationGraphSchema } from './application-graph.js';
import { deployzIrSchema } from './deployz-ir.js';
import { deploymentFootprintSchema } from './footprint.js';
import { infrastructureComponentKindSchema, type ResourceClassification } from './infrastructure.js';

// ---------------------------------------------------------------------------
// DeploymentSpecV2 — the frozen deployment envelope.
//
// DeploymentSpecV2 freezes the v2 deployment contract: the ApplicationGraph,
// the DeployzIR, version and hash metadata, and (once compiled) the compiler's
// outputs — verification contract, ownership records, footprint and the
// published artifact location. It does not contain CloudFormation.
// ---------------------------------------------------------------------------

export const DEPLOYMENT_SPEC_V2_SCHEMA_VERSION = 1 as const;

/** Infrastructure generation values. */
export const INFRA_VERSION_RUNTIME_V1 = 'runtime-v1' as const;
export const INFRA_VERSION_DYNAMIC_COMPILER_V2 = 'dynamic-compiler-v2' as const;

/** One compiler-emitted verification check (what proves a component exists). */
export const deploymentVerificationCheckSchema = z
  .object({
    componentId: z.string().min(1),
    componentKind: infrastructureComponentKindSchema,
    capability: z.string().min(1),
    /** Relay check name (compute/ingress/database/storage/cache). */
    check: z.string().min(1),
    /** CFN resource type whose COMPLETE presence proves the component exists. */
    primaryResourceType: z.string().min(1),
    logicalId: z.string().min(1),
  })
  .strict();
export type DeploymentVerificationCheck = z.infer<typeof deploymentVerificationCheckSchema>;

/** The verification contract — what must exist, per component. */
export const deploymentVerificationContractSchema = z
  .object({
    checks: z.array(deploymentVerificationCheckSchema).readonly(),
  })
  .strict();
export type DeploymentVerificationContract = z.infer<typeof deploymentVerificationContractSchema>;

/** One resource ownership record (installation → … → purge strategy). */
export const deploymentOwnershipRecordSchema = z
  .object({
    componentId: z.string().min(1),
    componentKind: infrastructureComponentKindSchema,
    capability: z.string().min(1),
    logicalResourceId: z.string().min(1),
    /** Physical resource id — resolved at deploy time, null in the compiled artifact. */
    physicalResourceId: z.string().nullable(),
    stateful: z.boolean(),
    retention: z.enum(['retain', 'delete']),
    purgeStrategy: z.enum(['delete', 'require_manual', 'skip']).nullable(),
    /** True when the stack may not create the resource; absent on specs frozen before the flag existed. */
    conditional: z.boolean().optional(),
  })
  .strict();
export type DeploymentOwnershipRecord = z.infer<typeof deploymentOwnershipRecordSchema>;

/**
 * The completed-compilation fields a spec carries once the compiler has run
 * and the template artifact has been published. Structurally satisfied by the
 * compiler's CompilationResult, so callers can pass its fields straight in.
 */
export interface DeploymentSpecCompilation {
  readonly compilerVersion: string;
  readonly templateHash: string;
  readonly artifactLocation: string;
  readonly verificationContract: DeploymentVerificationContract;
  readonly ownershipRecords: readonly DeploymentOwnershipRecord[];
  readonly footprint: z.infer<typeof deploymentFootprintSchema>;
}

/**
 * The requirement booleans the spec's verification contract proves, or null
 * when the contract is absent (an uncompiled spec — never a guessed false).
 */
export function requirementsFromSpec(spec: DeploymentSpecV2): {
  databaseRequired: boolean;
  redisRequired: boolean;
} | null {
  if (spec.verificationContract === null) return null;
  const checks = new Set(spec.verificationContract.checks.map((check) => check.check));
  return { databaseRequired: checks.has('database'), redisRequired: checks.has('cache') };
}

/** One persistent workload the spec's verification contract proves, with the
 *  CloudFormation logical id of the ECS service that backs it. */
export interface WorkloadService {
  readonly id: string;
  readonly serviceLogicalId: string;
}

/**
 * The workloads the spec's verification contract carries — one entry per
 * `compute` check (componentId = workload id, logicalId = its ECS service).
 * Null when the contract is absent (an uncompiled spec), empty only when the
 * contract proves no compute at all.
 */
export function workloadServicesFromSpec(spec: DeploymentSpecV2): readonly WorkloadService[] | null {
  if (spec.verificationContract === null) return null;
  return spec.verificationContract.checks
    .filter((check) => check.check === 'compute')
    .map((check) => ({ id: check.componentId, serviceLogicalId: check.logicalId }));
}

/**
 * CFN logical id of the compiled template's task-family suffix parameter.
 * The control plane passes `taskFamilySuffix(installationId)` at INSTALL, so
 * every task family the stack creates is unique to its installation.
 */
export const TASK_FAMILY_SUFFIX_PARAMETER = 'paramTaskFamilySuffix';

/**
 * Compiler versions that named every task family `DeployzApp<Pascal>` with no
 * suffix — one family shared by every installation in an AWS account and
 * Region. Their frozen artifacts keep those names.
 */
const SHARED_TASK_FAMILY_COMPILER_VERSIONS: ReadonlySet<string> = new Set([
  'dynamic-compiler-v2-1',
  'dynamic-compiler-v2-2',
]);

/** An installation's task-family suffix: its id's letters and digits, lower-cased. */
export function taskFamilySuffix(installationId: string): string {
  return installationId.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The suffix a deployment's compiled stack appends to every task family:
 * empty for a shared-family compiler version (and an uncompiled spec, which
 * has no task family), the installation's suffix otherwise. Null when the
 * stack needs a suffix and no installation is known — no family can be named.
 */
export function taskFamilySuffixForSpec(spec: DeploymentSpecV2, installationId: string | null): string | null {
  if (spec.compilerVersion === null || SHARED_TASK_FAMILY_COMPILER_VERSIONS.has(spec.compilerVersion)) return '';
  const suffix = installationId === null ? '' : taskFamilySuffix(installationId);
  return suffix.length > 0 ? suffix : null;
}

/** The ECS task-definition family the compiler bakes for a component id
 *  (`DeployzApp${Pascal(componentId)}` + the stack's task-family suffix —
 *  mirrors compile.ts's Family field; pinned equal by both packages' golden
 *  tests). */
export function deployzTaskFamily(componentId: string, suffix: string): string {
  const pascal = componentId
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
  return `DeployzApp${pascal}${suffix}`;
}

/** The container `Command` a worker command compiles to. It is an argument list
 *  for the image ENTRYPOINT, which is kept. */
export function workloadContainerCommand(command: string): string[] {
  return ['sh', '-c', command];
}

/** The container `EntryPoint` and `Command` a one-shot task (a migration or a
 *  scheduled job) compiles to. A one-shot command is a full command line, so it
 *  replaces the image ENTRYPOINT: an ENTRYPOINT that starts a server would hang
 *  or ignore it, and one that runs a fixed program would take `sh -c` as its
 *  arguments. The compiler bakes it into the task definition, and the relay
 *  encodes a migration correction with the same function, so both always agree.
 *  The image must contain `sh`. */
export function oneShotContainerCommand(command: string): { entryPoint: string[]; command: string[] } {
  return { entryPoint: ['sh', '-c'], command: [command] };
}

/** The frozen one-shot migration the spec compiled, with the CloudFormation
 *  logical id and ECS task-definition family the relay runs. Null when the
 *  spec is uncompiled or carries no one-shot workload.
 *
 *  The migration is the IR's `migration` workload (Phase 5: a scheduled job
 *  is ALSO a one-shot task definition without a compute check, so the kind —
 *  never subtraction — decides), proven compiled by its ownership record. */
export function migrationTaskFromSpec(spec: DeploymentSpecV2, familySuffix: string): {
  id: string;
  taskLogicalId: string;
  family: string;
} | null {
  return oneShotTasksFromSpec(spec, 'migration', familySuffix)[0] ?? null;
}

/**
 * The compiled one-shot task definitions of one workload kind (`migration`,
 * `scheduled-job`), each with its CloudFormation logical id and the ECS
 * family the relay registers release images into (`familySuffix` from
 * `taskFamilySuffixForSpec`). Empty on an uncompiled spec.
 */
export function oneShotTasksFromSpec(
  spec: DeploymentSpecV2,
  kind: 'migration' | 'scheduled-job',
  familySuffix: string,
): { id: string; taskLogicalId: string; family: string }[] {
  if (spec.ownershipRecords === null || spec.verificationContract === null) return [];
  const records = spec.ownershipRecords;
  return spec.ir.workloads
    .filter((workload) => workload.kind === kind)
    .flatMap((workload) => {
      const record = records.find(
        (entry) => entry.componentId === workload.componentId && entry.logicalResourceId.endsWith('TaskDefinition'),
      );
      return record === undefined
        ? []
        : [{ id: workload.componentId, taskLogicalId: record.logicalResourceId, family: deployzTaskFamily(workload.componentId, familySuffix) }];
    });
}

/** The fixed catalog check names the relay already verifies with dedicated
 *  per-capability logic (compute/ingress/database/storage/cache). */
const CATALOG_CHECK_NAMES: ReadonlySet<string> = new Set([
  'compute',
  'ingress',
  'database',
  'storage',
  'cache',
]);

/** One verification-contract check the relay verifies generically — a stack
 *  resource with this logical id and type in a complete state. */
export interface ResourceCheck {
  readonly componentId: string;
  readonly check: string;
  readonly logicalId: string;
  readonly resourceType: string;
}

/**
 * The verification-contract checks whose `check` name is NOT one of the
 * fixed catalog checks (Phase 5: `queue`, `schedule`, and any future
 * resource-shaped check) — sent to the relay so it can verify them
 * structurally, with no per-capability relay code. Empty on an uncompiled
 * spec or a spec whose contract carries only catalog checks.
 */
export function resourceChecksFromSpec(spec: DeploymentSpecV2): ResourceCheck[] {
  if (spec.verificationContract === null) return [];
  return spec.verificationContract.checks
    .filter((check) => !CATALOG_CHECK_NAMES.has(check.check))
    .map((check) => ({
      componentId: check.componentId,
      check: check.check,
      logicalId: check.logicalId,
      resourceType: check.primaryResourceType,
    }));
}

/**
 * Inventory classification by CFN logical id, from the spec's ownership
 * records: a record's kind and retention, with the verification contract
 * naming the component's primary proof resource. Null on an uncompiled spec.
 */
export function ownershipClassificationsFromSpec(
  spec: DeploymentSpecV2,
): Map<string, ResourceClassification> | null {
  if (spec.ownershipRecords === null || spec.verificationContract === null) return null;
  const primaryLogicalIds = new Set(spec.verificationContract.checks.map((check) => check.logicalId));
  const classifications = new Map<string, ResourceClassification>();
  for (const record of spec.ownershipRecords) {
    classifications.set(record.logicalResourceId, {
      componentKind: record.componentKind,
      role: primaryLogicalIds.has(record.logicalResourceId) ? 'primary' : 'supporting',
      lifecycle: record.retention,
    });
  }
  return classifications;
}

export const deploymentSpecV2Schema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION).default(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION),
    /** Infrastructure generation this spec belongs to. */
    infraVersion: z.literal(INFRA_VERSION_DYNAMIC_COMPILER_V2),
    /** Source graph — what the application needs. */
    graph: applicationGraphSchema,
    /** Resolved provisioning intent. */
    ir: deployzIrSchema,
    /** Graph canonical hash for identity/diff. */
    graphHash: z.string().min(1),
    /** IR canonical hash for identity/diff. */
    irHash: z.string().min(1),
    /** Capability registry version used to resolve the IR. */
    capabilityRegistryVersion: z.string().min(1),
    /** Size profile id used for sizing. */
    sizeProfileId: z.string().min(1),
    /** Compiler version — null until the spec has been compiled. */
    compilerVersion: z.string().nullable(),
    /** Template hash — null until the spec has been compiled. */
    templateHash: z.string().nullable(),
    /** https URL of the frozen compiled artifact — null until published. */
    artifactLocation: z.string().nullable(),
    /** What must exist, per component — from the compiled artifact. */
    verificationContract: deploymentVerificationContractSchema.nullable(),
    /** One ownership record per compiled logical resource. */
    ownershipRecords: z.array(deploymentOwnershipRecordSchema).nullable(),
    /** The compiler-resolved footprint (sizing + resources). */
    footprint: z.lazy(() => deploymentFootprintSchema).nullable(),
    /** When the spec was frozen. */
    frozenAt: z.string().datetime(),
  })
  .strict();
export type DeploymentSpecV2 = z.infer<typeof deploymentSpecV2Schema>;

export const deploymentSpecV2SummarySchema = z
  .object({
    schemaVersion: z.literal(DEPLOYMENT_SPEC_V2_SCHEMA_VERSION),
    infraVersion: z.literal(INFRA_VERSION_DYNAMIC_COMPILER_V2),
    graphHash: z.string().min(1),
    irHash: z.string().min(1),
    capabilityRegistryVersion: z.string().min(1),
    compilerVersion: z.string().nullable(),
    templateHash: z.string().nullable(),
  })
  .strict();
export type DeploymentSpecV2Summary = z.infer<typeof deploymentSpecV2SummarySchema>;

export function summarizeDeploymentSpecV2(spec: DeploymentSpecV2): DeploymentSpecV2Summary {
  return {
    schemaVersion: DEPLOYMENT_SPEC_V2_SCHEMA_VERSION,
    infraVersion: spec.infraVersion,
    graphHash: spec.graphHash,
    irHash: spec.irHash,
    capabilityRegistryVersion: spec.capabilityRegistryVersion,
    compilerVersion: spec.compilerVersion,
    templateHash: spec.templateHash,
  };
}
