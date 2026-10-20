import { z } from 'zod';

import { manifestEnvBindingSchema } from './manifest.js';
import { scheduleExpressionSchema, scheduleRetryPolicySchema, scheduleTimezoneSchema } from './schedule.js';

// ---------------------------------------------------------------------------
// ApplicationGraph — Phase 1 generalized application-requirements model.
//
// This is the AWS-independent representation of what the application needs.
// It is derived from repository evidence + vendor overrides + bounded AI
// reconciliation. It does NOT contain provisioning details.
// ---------------------------------------------------------------------------

export const APPLICATION_GRAPH_SCHEMA_VERSION = 1 as const;

export const resourceOwnershipSchema = z.enum([
  'DEPLOYZ_MANAGED',
  'CUSTOMER_EXISTING',
  'CUSTOMER_PROVIDED',
  'VENDOR_PROVIDED',
  'EXTERNAL_SAAS',
  'OPTIONAL',
  'UNRESOLVED',
]);
export type ResourceOwnership = z.infer<typeof resourceOwnershipSchema>;

export const relationshipTypeSchema = z.enum(['PROVISIONING', 'RUNTIME', 'BINDING', 'STARTUP']);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

export const evidenceSourceTypeSchema = z.enum([
  'dockerfile',
  'docker_compose',
  'package_manifest',
  'orm_configuration',
  'environment_declaration',
  'runtime_read',
  'procfile',
  'terraform',
  'cloudformation',
  'cdk',
  'pulumi',
  'kubernetes',
  'helm',
  'sam',
  'ci_configuration',
  'documentation',
  'source_import',
  'framework_configuration',
  'vendor_override',
  'ai_reconciliation',
]);
export type EvidenceSourceType = z.infer<typeof evidenceSourceTypeSchema>;

export const evidenceItemSchema = z
  .object({
    sourceType: evidenceSourceTypeSchema,
    /** File path or document identifier that produced this evidence. */
    path: z.string().min(1),
    /** Snippet or concrete value observed (redacted for secrets). */
    snippet: z.string().optional(),
    /** Human-readable description of what the evidence means. */
    description: z.string().min(1),
    /** Confidence when the source is AI reconciliation or ambiguous inference. */
    confidence: z.enum(['high', 'medium', 'low']).optional(),
  })
  .strict();
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export const provenanceSchema = z
  .object({
    detected: z.boolean(),
    overridden: z.boolean(),
    evidence: z.array(evidenceItemSchema),
  })
  .strict();
export type Provenance = z.infer<typeof provenanceSchema>;

export const buildArtifactSchema = z
  .object({
    /** Stable identifier within the graph. */
    id: z.string().min(1),
    /** Repository path the artifact is built from. */
    sourceRoot: z.string().min(1),
    /** Path to the Dockerfile, relative to the repository root. */
    dockerfilePath: z.string().nullable(),
    /** Build context directory, relative to the repository root. */
    buildContext: z.string().min(1),
    /** Target platform architecture when known. */
    architecture: z.enum(['linux/amd64', 'linux/arm64']).nullable(),
    /** Multi-stage Dockerfile target, when explicit. */
    target: z.string().nullable(),
    /** Detected build command (e.g. `npm run build`). */
    buildCommand: z.string().nullable(),
    provenance: provenanceSchema,
  })
  .strict();
export type BuildArtifact = z.infer<typeof buildArtifactSchema>;

export const workloadKindSchema = z.enum([
  'web',
  'worker',
  'private-service',
  'migration',
  'scheduled-job',
  'lambda',
]);
export type WorkloadKind = z.infer<typeof workloadKindSchema>;

export const workloadSchema = z
  .object({
    /** Stable component ID (e.g. 'web', 'email-worker', 'migration'). */
    id: z.string().min(1),
    kind: workloadKindSchema,
    /** Human-readable label. */
    label: z.string().min(1),
    /** Repository path the workload runs from. */
    sourceRoot: z.string().min(1),
    /** Reference to a BuildArtifact id. */
    buildArtifactId: z.string().min(1),
    /** Start/command the workload runs. */
    command: z.string().nullable(),
    /** TCP port the workload listens on, when relevant. */
    port: z.number().int().nullable(),
    /** Whether the workload is reachable from the public internet. */
    public: z.boolean().nullable(),
    /** Health check path, when applicable. */
    healthCheck: z
      .object({
        path: z.string().min(1),
        mode: z.enum(['explicit', 'root', 'vendor_required']).optional(),
        /** The app rejects a Host header it does not know (Django ALLOWED_HOSTS): the ALB health check, which sends the task IP, gets 400. */
        hostChecked: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    /** Desired instance/task count. */
    desiredCount: z.number().int().min(1),
    /** Runtime family (e.g. 'node'). */
    runtime: z.string().min(1).nullable(),
    /** Detected framework, when any. */
    framework: z.string().nullable(),
    provenance: provenanceSchema,
  })
  .strict();
export type Workload = z.infer<typeof workloadSchema>;

export const resourceKindSchema = z.enum([
  'relational_database',
  'document_database',
  'key_value_database',
  'cache',
  'queue',
  'object_storage',
  'filesystem',
  'search',
  'event_bus',
  'vector_store',
  'external_service',
  'generic_service',
]);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const resourceSchema = z
  .object({
    /** Stable component ID (e.g. 'primary-db', 'redis-cache', 'email-queue'). */
    id: z.string().min(1),
    kind: resourceKindSchema,
    /** Human-readable label. */
    label: z.string().min(1),
    /** Who owns/provides this resource. */
    ownership: resourceOwnershipSchema,
    /** Multiplicity — schema supports N even when product initially limits to 1. */
    quantity: z.number().int().min(1),
    /** Environment bindings this resource injects into workloads. */
    envBindings: z.array(manifestEnvBindingSchema),
    /** Optional engine/version hint for data services (e.g. 'postgres', 'mysql', 'valkey', 'standard'). */
    engine: z.string().nullable(),
    /** Connection URL scheme for the app's driver (relational databases only); absent means the engine's standard scheme. */
    urlScheme: z.enum(['mysql+pymysql']).optional(),
    /** Message-queue settings (kind `queue` only); absent means the planner defaults. */
    queue: z
      .object({
        messageRetentionSeconds: z.number().int().min(60).max(1209600).optional(),
        visibilityTimeoutSeconds: z.number().int().min(0).max(43200).optional(),
      })
      .strict()
      .optional(),
    provenance: provenanceSchema,
  })
  .strict();
export type Resource = z.infer<typeof resourceSchema>;

/**
 * What a relationship edge does (Phase 5B), independent of any cloud:
 *   produce     — workload → queue: the workload sends messages.
 *   consume     — workload → queue: the workload receives and deletes messages.
 *   dead-letter — queue → queue (redrive) or schedule → queue (undeliverable
 *                 invocations): the source hands failures to the target.
 *   invoke      — schedule → workload: the schedule starts the workload.
 * Edges without an access keep the pre-Phase-5 meaning of their relationship.
 */
export const bindingAccessSchema = z.enum(['produce', 'consume', 'dead-letter', 'invoke']);
export type BindingAccess = z.infer<typeof bindingAccessSchema>;

export const bindingSchema = z
  .object({
    /** Stable ID for this binding. */
    id: z.string().min(1),
    /** Source component ID (workload or resource). */
    sourceId: z.string().min(1),
    /** Target component ID (workload or resource). */
    targetId: z.string().min(1),
    /** Relationship semantics. */
    relationship: relationshipTypeSchema,
    /** Environment variables / configuration the source receives for the target. */
    envBindings: z.array(manifestEnvBindingSchema),
    /** IAM permission intent (e.g. 'read', 'write', 'admin') — planner translates to concrete actions. */
    permission: z.enum(['read', 'write', 'admin', 'none']).optional(),
    /** Edge role (Phase 5B); the planner derives the edge's permissions from it. */
    access: bindingAccessSchema.optional(),
    /** Receives before a message moves to the dead-letter queue (queue → queue `dead-letter` edges only). */
    maxReceiveCount: z.number().int().min(1).max(1000).optional(),
    provenance: provenanceSchema,
  })
  .strict();
export type Binding = z.infer<typeof bindingSchema>;

/**
 * A schedule (Phase 5C): WHEN a scheduled-job workload runs. Its target is
 * the schedule's one `invoke` edge and its optional dead-letter queue is its
 * `dead-letter` edge — relationships live in `bindings`, never here.
 */
export const scheduleSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    expression: scheduleExpressionSchema,
    /** IANA timezone; null means UTC. */
    timezone: scheduleTimezoneSchema.nullable(),
    retry: scheduleRetryPolicySchema,
    enabled: z.boolean(),
    provenance: provenanceSchema,
  })
  .strict();
export type Schedule = z.infer<typeof scheduleSchema>;

export const externalServiceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Why this is considered external rather than Deployz-managed. */
    reason: z.enum(['saas', 'customer_provided', 'vendor_provided', 'unknown']),
    provenance: provenanceSchema,
  })
  .strict();
export type ExternalService = z.infer<typeof externalServiceSchema>;

export const unresolvedRequirementSchema = z
  .object({
    id: z.string().min(1),
    /** What is unresolved (e.g. 'database_engine', 'queue_purpose'). */
    field: z.string().min(1),
    /** Human question to present to the vendor. */
    question: z.string().min(1),
    /** Evidence that led to the ambiguity. */
    evidence: z.array(evidenceItemSchema),
    /** Whether the ambiguity blocks deployment. */
    blocking: z.boolean(),
  })
  .strict();
export type UnresolvedRequirement = z.infer<typeof unresolvedRequirementSchema>;

export const applicationGraphSchema = z
  .object({
    schemaVersion: z.literal(APPLICATION_GRAPH_SCHEMA_VERSION).default(APPLICATION_GRAPH_SCHEMA_VERSION),
    /** Repository path the application lives in (e.g. '.', 'apps/web'). */
    applicationRoot: z.string().min(1),
    buildArtifacts: z.array(buildArtifactSchema),
    workloads: z.array(workloadSchema),
    resources: z.array(resourceSchema),
    bindings: z.array(bindingSchema),
    /** Schedules (Phase 5C, optional/additive — absent when none, so older graphs hash unchanged). */
    schedules: z.array(scheduleSchema).optional(),
    externalServices: z.array(externalServiceSchema),
    unresolved: z.array(unresolvedRequirementSchema),
  })
  .strict();
export type ApplicationGraph = z.infer<typeof applicationGraphSchema>;

export const applicationGraphSummarySchema = z
  .object({
    schemaVersion: z.literal(APPLICATION_GRAPH_SCHEMA_VERSION),
    workloadCount: z.number().int().min(0),
    resourceCount: z.number().int().min(0),
    managedResourceCount: z.number().int().min(0),
    unresolvedCount: z.number().int().min(0),
    hasBlockingUnresolved: z.boolean(),
  })
  .strict();
export type ApplicationGraphSummary = z.infer<typeof applicationGraphSummarySchema>;

export function summarizeApplicationGraph(graph: ApplicationGraph): ApplicationGraphSummary {
  return {
    schemaVersion: APPLICATION_GRAPH_SCHEMA_VERSION,
    workloadCount: graph.workloads.length,
    resourceCount: graph.resources.length,
    managedResourceCount: graph.resources.filter((r) => r.ownership === 'DEPLOYZ_MANAGED').length,
    unresolvedCount: graph.unresolved.length,
    hasBlockingUnresolved: graph.unresolved.some((u) => u.blocking),
  };
}
