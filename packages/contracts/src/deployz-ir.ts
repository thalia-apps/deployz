import { z } from 'zod';

import { regionSchema } from './regions.js';
import { manifestEnvBindingSchema } from './manifest.js';
import { resourceLifecycleSchema, resourceScopeSchema } from './capability-registry.js';
import { bindingAccessSchema } from './application-graph.js';
import { scheduleExpressionSchema, scheduleRetryPolicySchema, scheduleTimezoneSchema } from './schedule.js';

// ---------------------------------------------------------------------------
// DeployzIR — Phase 1 authoritative provisioning intent.
//
// DeployzIR is what Deployz intends to provision after repository
// understanding, capability resolution, vendor/customer choices, region
// selection, sizing, and policy. It is derived from ApplicationGraph by the
// planner. It is AWS-aware at the capability level but does NOT contain
// CloudFormation details.
// ---------------------------------------------------------------------------

export const DEPLOYZ_IR_SCHEMA_VERSION = 1 as const;

export const irWorkloadKindSchema = z.enum([
  'web',
  'worker',
  'private-service',
  'migration',
  'scheduled-job',
  'lambda',
]);
export type IrWorkloadKind = z.infer<typeof irWorkloadKindSchema>;

export const irWorkloadSchema = z
  .object({
    /** Stable component ID from the ApplicationGraph. */
    componentId: z.string().min(1),
    kind: irWorkloadKindSchema,
    label: z.string().min(1),
    /** Reference to a build artifact / image. */
    buildArtifactId: z.string().min(1),
    command: z.string().nullable(),
    port: z.number().int().nullable(),
    /** Whether the workload is public-facing. */
    public: z.boolean().nullable(),
    healthCheck: z
      .object({
        path: z.string().min(1),
        mode: z.enum(['explicit', 'root', 'vendor_required']).optional(),
        /** The app rejects a Host header it does not know (Django ALLOWED_HOSTS): the ALB health check, which sends the task IP, gets 400. */
        hostChecked: z.boolean().optional(),
      })
      .strict()
      .nullable(),
    desiredCount: z.number().int().min(1),
    compute: z
      .object({
        provider: z.literal('aws'),
        /** Capability key for the compute target. */
        capabilityKey: z.string().min(1),
        cpuUnits: z.number().int(),
        memoryMiB: z.number().int(),
        sizeLabel: z.string().min(1),
        /** CPU architecture when explicit. */
        architecture: z.enum(['x86_64', 'arm64']).nullable(),
      })
      .strict(),
    /** Capability refs the workload depends on. */
    dependencyCapabilityKeys: z.array(z.string().min(1)),
  })
  .strict();
export type IrWorkload = z.infer<typeof irWorkloadSchema>;

export const irResourceSchema = z
  .object({
    /** Stable component ID from the ApplicationGraph. */
    componentId: z.string().min(1),
    /** Capability key that will provision this resource. */
    capabilityKey: z.string().min(1),
    label: z.string().min(1),
    quantity: z.number().int().min(1),
    /** Sizing/configuration resolved by the planner from the size profile. */
    configuration: z.record(z.string(), z.unknown()),
    lifecycle: resourceLifecycleSchema,
    /** Placement scope for future global/fixed-region capabilities. */
    scope: resourceScopeSchema,
    /** Environment bindings this resource injects. */
    envBindings: z.array(manifestEnvBindingSchema),
  })
  .strict();
export type IrResource = z.infer<typeof irResourceSchema>;

export const irBindingSchema = z
  .object({
    id: z.string().min(1),
    sourceId: z.string().min(1),
    targetId: z.string().min(1),
    envBindings: z.array(manifestEnvBindingSchema),
    /** IAM actions the source requires against the target capability. */
    iamActions: z.array(z.string().min(1)),
    /** Edge role from the graph (Phase 5B) — absent on pre-Phase-5 edges. */
    access: bindingAccessSchema.optional(),
    /** Redrive threshold for a queue → queue dead-letter edge. */
    maxReceiveCount: z.number().int().min(1).max(1000).optional(),
  })
  .strict();
export type IrBinding = z.infer<typeof irBindingSchema>;

export const irIngressSchema = z
  .object({
    public: z.boolean(),
    capabilityKey: z.string().min(1).nullable(),
    /** Component IDs that receive public ingress. */
    targetWorkloadIds: z.array(z.string().min(1)),
  })
  .strict();
export type IrIngress = z.infer<typeof irIngressSchema>;

/**
 * A resolved schedule (Phase 5C). `targetWorkloadId` / `deadLetterQueueId`
 * are the planner's resolution of the schedule's graph edges; the matching
 * IR bindings carry the IAM those edges need.
 */
export const irScheduleSchema = z
  .object({
    id: z.string().min(1),
    /** Capability that provisions the schedule (e.g. 'aws.eventbridge-scheduler'). */
    capabilityKey: z.string().min(1),
    label: z.string().min(1),
    expression: scheduleExpressionSchema,
    timezone: scheduleTimezoneSchema.nullable(),
    targetWorkloadId: z.string().min(1),
    retry: scheduleRetryPolicySchema,
    deadLetterQueueId: z.string().min(1).nullable(),
    enabled: z.boolean(),
  })
  .strict();
export type IrSchedule = z.infer<typeof irScheduleSchema>;

export const irPolicySchema = z
  .object({
    /** Whether unsupported topology changes are allowed on update. */
    allowTopologyChanges: z.boolean(),
    /** Default retention for stateful resources without an explicit policy. */
    defaultRetention: z.enum(['retain', 'delete']),
  })
  .strict();
export type IrPolicy = z.infer<typeof irPolicySchema>;

export const irMetadataSchema = z
  .object({
    /** Source ApplicationGraph schema version that produced this IR. */
    graphSchemaVersion: z.number().int(),
    /** Capability registry version used to resolve capabilities. */
    capabilityRegistryVersion: z.string().min(1),
    /** Size profile id/version used for sizing. */
    sizeProfileId: z.string().min(1),
    /** Region the IR is planned for. */
    region: regionSchema.nullable(),
  })
  .strict();
export type IrMetadata = z.infer<typeof irMetadataSchema>;

export const deployzIrSchema = z
  .object({
    schemaVersion: z.literal(DEPLOYZ_IR_SCHEMA_VERSION).default(DEPLOYZ_IR_SCHEMA_VERSION),
    workloads: z.array(irWorkloadSchema),
    resources: z.array(irResourceSchema),
    bindings: z.array(irBindingSchema),
    ingress: irIngressSchema,
    schedules: z.array(irScheduleSchema),
    policies: irPolicySchema,
    metadata: irMetadataSchema,
  })
  .strict();
export type DeployzIR = z.infer<typeof deployzIrSchema>;

export const deployzIrSummarySchema = z
  .object({
    schemaVersion: z.literal(DEPLOYZ_IR_SCHEMA_VERSION),
    workloadCount: z.number().int().min(0),
    resourceCount: z.number().int().min(0),
    managedResourceCount: z.number().int().min(0),
    hasUnresolvedCapabilities: z.boolean(),
  })
  .strict();
export type DeployzIRSummary = z.infer<typeof deployzIrSummarySchema>;

export function summarizeDeployzIR(ir: DeployzIR): DeployzIRSummary {
  return {
    schemaVersion: DEPLOYZ_IR_SCHEMA_VERSION,
    workloadCount: ir.workloads.length,
    resourceCount: ir.resources.length,
    managedResourceCount: ir.resources.filter((r) => r.lifecycle !== 'delete' || r.scope !== 'GLOBAL').length,
    hasUnresolvedCapabilities: ir.resources.some((r) => !r.capabilityKey),
  };
}
