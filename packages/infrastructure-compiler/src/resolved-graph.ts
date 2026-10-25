import type { DeploymentFootprint, InfrastructureComponentKind, Region } from '@deployz/contracts';

// ---------------------------------------------------------------------------
// The resolved AWS graph — dynamic-compiler-v2's core output model.
//
// The compiler turns a DeployzIR into an explicit, ordered list of logical
// resources, each carrying BOTH the CloudFormation surface it serializes to
// and the semantic identity/lifecycle metadata that verification, ownership,
// footprint and presentation all derive from. Everything downstream reads
// this one model — nothing re-derives infrastructure from raw CloudFormation.
// ---------------------------------------------------------------------------

/** CloudFormation DeletionPolicy / UpdateReplacePolicy surface. */
export type DeletionPolicy = 'Delete' | 'Retain';

/** Semantic retention lifecycle for a resource. */
export type Retention = 'retain' | 'delete';

/** Purge strategy a stateful resource declares. */
export type PurgeStrategy = 'delete' | 'require_manual' | 'skip' | null;

/** One compiler-emitted logical resource. */
export interface ResolvedResource {
  /** Stable semantic logical id (componentId + resourceRole). */
  readonly logicalId: string;
  /** Graph component id the resource belongs to (e.g. 'web', 'primary-db', 'network'). */
  readonly componentId: string;
  /** Deployz component kind for ownership/verification/tags. */
  readonly componentKind: InfrastructureComponentKind;
  /** Capability key that owns the resource (e.g. 'aws.rds-postgres'). */
  readonly capability: string;
  /** Stable role token (e.g. 'instance', 'secret', 'service', 'vpc'). */
  readonly resourceRole: string;
  /** CloudFormation resource type. */
  readonly cfnType: string;
  /** Whether the resource is stateful (data survives stack deletion). */
  readonly stateful: boolean;
  readonly deletionPolicy: DeletionPolicy;
  readonly updateReplacePolicy: DeletionPolicy;
  /** Semantic retention lifecycle (retain/delete). */
  readonly retention: Retention;
  /** Purge strategy for stateful resources; null when stateless. */
  readonly purgeStrategy: PurgeStrategy;
  /** Verification check name when this resource is a component's primary proof. */
  readonly verificationCheck?: string;
  /** True when the resource may not exist in a stack (a slot the region cannot fill). */
  readonly conditional?: boolean;
  /** CloudFormation properties (Fn::Ref/GetAtt tokens are plain JSON). */
  readonly properties: Record<string, unknown>;
  /** Logical ids this resource depends on (in dependency order). */
  readonly dependsOn?: readonly string[];
}

/** One CloudFormation parameter. */
export interface ResolvedParameter {
  readonly id: string;
  readonly type: string;
  readonly noEcho: boolean;
  readonly defaultValue?: unknown;
  readonly description?: string;
  readonly allowedPattern?: string;
}

/** One CloudFormation output. */
export interface ResolvedOutput {
  readonly id: string;
  readonly value: unknown;
}

/** One CloudFormation condition. */
export interface ResolvedCondition {
  readonly id: string;
  readonly expression: unknown;
}

/** The resolved AWS graph — the authoritative compiled infrastructure model. */
export interface ResolvedAwsGraph {
  readonly resources: readonly ResolvedResource[];
  readonly parameters: readonly ResolvedParameter[];
  readonly outputs: readonly ResolvedOutput[];
  readonly conditions: readonly ResolvedCondition[];
}

/** A compiler-emitted verification contract check (component/capability-driven). */
export interface VerificationCheck {
  readonly componentId: string;
  readonly componentKind: InfrastructureComponentKind;
  readonly capability: string;
  /** Relay check name (compute/ingress/database/storage/cache). */
  readonly check: string;
  /** CFN resource type whose COMPLETE presence proves the component exists. */
  readonly primaryResourceType: string;
  readonly logicalId: string;
}

/** The verification contract — what must exist, per component. */
export interface VerificationContract {
  readonly checks: readonly VerificationCheck[];
}

/** One resource ownership record (installation → … → purge strategy). */
export interface OwnershipRecord {
  readonly componentId: string;
  readonly componentKind: InfrastructureComponentKind;
  readonly capability: string;
  readonly logicalResourceId: string;
  /** Physical resource id — resolved at deploy time, null in the compiled artifact. */
  readonly physicalResourceId: string | null;
  readonly stateful: boolean;
  readonly retention: Retention;
  readonly purgeStrategy: PurgeStrategy;
  /** True when the stack may not create the resource. Absent on specs frozen before the flag existed. */
  readonly conditional?: boolean;
}

/** Immutable artifact metadata — the compiler-versioned hashes the spec freezes. */
export interface CompilerArtifactMetadata {
  readonly compilerVersion: string;
  readonly capabilityRegistryVersion: string;
  readonly irHash: string;
  readonly templateHash: string;
}

/** The compiler's full output for one DeployzIR. */
export interface CompilationResult {
  readonly resolvedGraph: ResolvedAwsGraph;
  /** Deterministic CloudFormation template (plain JSON object). */
  readonly template: Record<string, unknown>;
  readonly footprint: DeploymentFootprint;
  readonly verificationContract: VerificationContract;
  readonly ownershipRecords: readonly OwnershipRecord[];
  readonly artifact: CompilerArtifactMetadata;
  readonly region: Region | null;
}
