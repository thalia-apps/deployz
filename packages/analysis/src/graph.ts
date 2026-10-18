/**
 * ApplicationGraph — pure, deterministic translation of a validated
 * DeploymentManifest (+ vendor overrides + analysis result) into the
 * AWS-independent application-requirements model.
 *
 * This is the production compile path: compiler-v2 derives the graph, plans
 * it into the IR, and freezes the DeploymentSpecV2 every install executes.
 */

import {
  DEFAULT_SCHEDULE_RETRY_POLICY,
  applicationGraphSchema,
  type ApplicationGraph,
  type Binding,
  type BuildArtifact,
  type DeploymentManifest,
  type DeploymentManifestOverrides,
  type EvidenceItem,
  type ExternalService,
  type ManifestEnvBinding,
  type ManifestWorker,
  type Provenance,
  type Resource,
  type Schedule,
  type UnresolvedRequirement,
  type Workload,
} from '@deployz/contracts';

import type { AnalysisResult } from './analyser.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function detectedProvenance(evidence: EvidenceItem[]): Provenance {
  return { detected: true, overridden: false, evidence };
}

function fileEvidence(path: string, description: string, sourceType: EvidenceItem['sourceType'] = 'dockerfile'): EvidenceItem {
  return { sourceType, path, description };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// ── Build artifacts ─────────────────────────────────────────────────────────

function buildArtifacts(manifest: DeploymentManifest): BuildArtifact[] {
  const dockerfilePath = manifest.application.dockerfilePath;
  const evidence: EvidenceItem[] = dockerfilePath
    ? [fileEvidence(dockerfilePath, `Dockerfile at ${dockerfilePath}`)]
    : [fileEvidence(manifest.application.root, `Application root ${manifest.application.root}`, 'source_import')];

  return [
    {
      id: 'app',
      sourceRoot: manifest.application.root,
      dockerfilePath,
      buildContext: manifest.build.context,
      buildCommand: manifest.build.command,
      architecture: null,
      target: null,
      provenance: detectedProvenance(evidence),
    },
  ];
}

// ── Workloads ───────────────────────────────────────────────────────────────

/** The manifest's declared workers, normalizing the legacy single slot. */
function manifestWorkers(manifest: DeploymentManifest): readonly ManifestWorker[] {
  if (manifest.workers !== undefined) return manifest.workers;
  // Legacy manifest written before `workers[]` existed: the single slot
  // normalizes to one `worker` entry.
  return manifest.worker.command !== null
    ? [{ id: 'worker', command: manifest.worker.command, source: 'package.json' }]
    : [];
}

/** The evidence source type for the file that declared a worker process. */
function workerSourceType(source: string): EvidenceItem['sourceType'] {
  if (/Procfile$/.test(source)) return 'procfile';
  if (/compose/i.test(source)) return 'docker_compose';
  return 'source_import';
}

function buildWorkloads(manifest: DeploymentManifest): Workload[] {
  const workloads: Workload[] = [];

  // Web workload — always present.
  workloads.push({
    id: 'web',
    kind: 'web',
    label: 'Web service',
    sourceRoot: manifest.application.root,
    buildArtifactId: 'app',
    command: manifest.web.command,
    port: manifest.web.port,
    public: true,
    healthCheck: manifest.health,
    desiredCount: 1,
    runtime: manifest.application.runtime,
    framework: manifest.application.framework,
    provenance: detectedProvenance(
      manifest.web.command
        ? [fileEvidence(manifest.application.root, `Web start command: ${manifest.web.command}`, 'source_import')]
        : [fileEvidence(manifest.application.root, 'Web workload (no start command detected)', 'source_import')],
    ),
  });

  // Worker workloads — one per declared process (Phase 4A). Weak evidence
  // never reaches the manifest as a worker, so everything here is a declared
  // run process with its own frozen command.
  for (const worker of manifestWorkers(manifest)) {
    workloads.push({
      id: worker.id,
      kind: 'worker',
      label: worker.id === 'worker' ? 'Background worker' : `Worker ${worker.id}`,
      sourceRoot: manifest.application.root,
      buildArtifactId: 'app',
      command: worker.command,
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: manifest.application.runtime,
      framework: manifest.application.framework,
      provenance: detectedProvenance([
        fileEvidence(
          manifest.application.root,
          `Worker ${worker.id} command: ${worker.command}`,
          workerSourceType(worker.source),
        ),
      ]),
    });
  }

  // Migration workload — only when the manifest has a migration command.
  if (manifest.migration.command) {
    workloads.push({
      id: 'migration',
      kind: 'migration',
      label: 'Database migration',
      sourceRoot: manifest.application.root,
      buildArtifactId: 'app',
      command: manifest.migration.command,
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: manifest.application.runtime,
      framework: manifest.application.framework,
      provenance: detectedProvenance([
        fileEvidence(manifest.application.root, `Migration command: ${manifest.migration.command}`, 'source_import'),
      ]),
    });
  }

  // Scheduled-job workloads (Phase 5D) — asynchronous recurring one-shot
  // tasks, each with its own frozen command. Never deployment-gating.
  for (const job of manifest.scheduledJobs ?? []) {
    workloads.push({
      id: job.id,
      kind: 'scheduled-job',
      label: `Scheduled job ${job.id}`,
      sourceRoot: manifest.application.root,
      buildArtifactId: 'app',
      command: job.command,
      port: null,
      public: false,
      healthCheck: null,
      desiredCount: 1,
      runtime: manifest.application.runtime,
      framework: manifest.application.framework,
      provenance: detectedProvenance([
        fileEvidence(job.source, `Scheduled job ${job.id} command: ${job.command}`, scheduleSourceType(job.source)),
      ]),
    });
  }

  return workloads;
}

/** The evidence source type for a file that declared a schedule. */
function scheduleSourceType(source: string): EvidenceItem['sourceType'] {
  return /render\.ya?ml$/.test(source) ? 'framework_configuration' : 'kubernetes';
}

// ── Queues and schedules (Phase 5) ──────────────────────────────────────────

/** 'orders-queue' → 'Orders queue'. */
function humanize(id: string): string {
  const words = id.split('-').filter(Boolean).join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The dead-letter queue component id of a queue. */
function deadLetterQueueId(queueId: string): string {
  return `${queueId}-dlq`;
}

/** The schedule component id of a scheduled job. */
function scheduleId(jobId: string): string {
  return `${jobId}-schedule`;
}

function queueResource(
  id: string,
  label: string,
  envBindings: ManifestEnvBinding[],
  settings: Resource['queue'],
  evidence: EvidenceItem[],
): Resource {
  return {
    id,
    kind: 'queue',
    label,
    ownership: 'DEPLOYZ_MANAGED',
    quantity: 1,
    engine: 'standard',
    envBindings,
    ...(settings !== undefined ? { queue: settings } : {}),
    provenance: detectedProvenance(evidence),
  };
}

function buildQueueResources(manifest: DeploymentManifest): Resource[] {
  const resources: Resource[] = [];
  for (const queue of manifest.queues ?? []) {
    const settings =
      queue.messageRetentionSeconds !== undefined || queue.visibilityTimeoutSeconds !== undefined
        ? {
            ...(queue.messageRetentionSeconds !== undefined ? { messageRetentionSeconds: queue.messageRetentionSeconds } : {}),
            ...(queue.visibilityTimeoutSeconds !== undefined ? { visibilityTimeoutSeconds: queue.visibilityTimeoutSeconds } : {}),
          }
        : undefined;
    const evidence = [fileEvidence(queue.source, `Message queue ${queue.id} (${queue.envBindings.map((b) => b.name).join(', ')})`, 'source_import')];
    resources.push(queueResource(queue.id, humanize(queue.id), queue.envBindings, settings, evidence));
    if (queue.deadLetter !== undefined) {
      resources.push(
        queueResource(deadLetterQueueId(queue.id), `${humanize(queue.id)} dead-letter queue`, queue.deadLetter.envBindings, undefined, [
          fileEvidence(queue.source, `Dead-letter queue for ${queue.id}`, 'source_import'),
        ]),
      );
    }
  }
  for (const job of manifest.scheduledJobs ?? []) {
    if (job.deadLetter !== true) continue;
    resources.push(
      queueResource(deadLetterQueueId(scheduleId(job.id)), `Scheduled job ${job.id} dead-letter queue`, [], undefined, [
        fileEvidence(job.source, `Dead-letter queue for the ${job.id} schedule`, scheduleSourceType(job.source)),
      ]),
    );
  }
  return resources;
}

function buildSchedules(manifest: DeploymentManifest): Schedule[] {
  return (manifest.scheduledJobs ?? []).map((job) => ({
    id: scheduleId(job.id),
    label: `Schedule for ${job.id}`,
    expression: job.schedule,
    timezone: job.timezone,
    retry: job.retry ?? DEFAULT_SCHEDULE_RETRY_POLICY,
    enabled: job.enabled ?? true,
    provenance: detectedProvenance([
      fileEvidence(job.source, `Schedule for ${job.id}`, scheduleSourceType(job.source)),
    ]),
  }));
}

/**
 * The explicit relationship edges of Phase 5: producer/consumer edges from
 * workloads to queues, queue → dead-letter redrive edges, and schedule →
 * workload / schedule → dead-letter edges. Appended after every pre-Phase-5
 * binding so older graphs keep their binding ids.
 */
function asyncBindings(manifest: DeploymentManifest, nextId: () => string): Binding[] {
  const bindings: Binding[] = [];
  const edge = (
    sourceId: string,
    targetId: string,
    access: NonNullable<Binding['access']>,
    envBindings: ManifestEnvBinding[],
    source: string,
    maxReceiveCount?: number,
  ): Binding => ({
    id: nextId(),
    sourceId,
    targetId,
    relationship: access === 'produce' || access === 'consume' ? 'BINDING' : 'RUNTIME',
    envBindings,
    access,
    ...(maxReceiveCount !== undefined ? { maxReceiveCount } : {}),
    provenance: detectedProvenance([fileEvidence(source, `${sourceId} ${access} ${targetId}`, 'source_import')]),
  });

  for (const queue of manifest.queues ?? []) {
    for (const producer of queue.producers) bindings.push(edge(producer, queue.id, 'produce', queue.envBindings, queue.source));
    for (const consumer of queue.consumers) bindings.push(edge(consumer, queue.id, 'consume', queue.envBindings, queue.source));
    const deadLetter = queue.deadLetter;
    if (deadLetter === undefined) continue;
    const dlqId = deadLetterQueueId(queue.id);
    bindings.push(edge(queue.id, dlqId, 'dead-letter', [], queue.source, deadLetter.maxReceiveCount));
    for (const producer of deadLetter.producers) bindings.push(edge(producer, dlqId, 'produce', deadLetter.envBindings, queue.source));
    for (const consumer of deadLetter.consumers) bindings.push(edge(consumer, dlqId, 'consume', deadLetter.envBindings, queue.source));
  }
  for (const job of manifest.scheduledJobs ?? []) {
    bindings.push(edge(scheduleId(job.id), job.id, 'invoke', [], job.source));
    if (job.deadLetter === true) {
      bindings.push(edge(scheduleId(job.id), deadLetterQueueId(scheduleId(job.id)), 'dead-letter', [], job.source));
    }
  }
  return bindings;
}

// ── Resources ───────────────────────────────────────────────────────────────

const STANDARD_POSTGRES_BINDINGS: ManifestEnvBinding[] = [
  { name: 'DATABASE_URL', kind: 'url' },
  { name: 'DB_HOST', kind: 'host' },
  { name: 'DB_PORT', kind: 'port' },
  { name: 'DB_NAME', kind: 'database' },
  { name: 'DB_USER', kind: 'username' },
  { name: 'DB_PASSWORD', kind: 'password' },
];

const DEFAULT_STORAGE_BINDINGS: ManifestEnvBinding[] = [{ name: 'AWS_S3_BUCKET', kind: 'bucket' }];

function buildResources(manifest: DeploymentManifest): Resource[] {
  const resources: Resource[] = [];

  if (manifest.database.postgres) {
    // Phase 4B — one managed relational database per deployment; the engine
    // comes from the manifest (absent = the historical default, postgres).
    const engine = manifest.database.engine === 'mysql' ? 'mysql' : 'postgres';
    resources.push({
      id: 'primary-db',
      kind: 'relational_database',
      label: engine === 'mysql' ? 'MySQL database' : 'PostgreSQL database',
      ownership: 'DEPLOYZ_MANAGED',
      quantity: 1,
      engine,
      ...(manifest.database.urlScheme !== undefined ? { urlScheme: manifest.database.urlScheme } : {}),
      envBindings: manifest.database.envBindings ?? STANDARD_POSTGRES_BINDINGS,
      provenance: detectedProvenance([
        {
          sourceType: 'orm_configuration',
          path: manifest.application.root,
          description:
            engine === 'mysql' ? 'MySQL requirement detected' : 'PostgreSQL requirement detected',
        },
      ]),
    });
  }

  if (manifest.redis.required) {
    resources.push({
      id: 'cache',
      kind: 'cache',
      label: 'Valkey cache',
      ownership: 'DEPLOYZ_MANAGED',
      quantity: 1,
      engine: 'valkey',
      envBindings: manifest.redis.envBindings,
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: 'Redis/Valkey cache requirement detected' },
      ]),
    });
  }

  // S3 storage — always present.
  resources.push({
    id: 'storage',
    kind: 'object_storage',
    label: 'S3 bucket',
    ownership: 'DEPLOYZ_MANAGED',
    quantity: 1,
    engine: null,
    envBindings: manifest.storage.envBindings.length > 0 ? manifest.storage.envBindings : DEFAULT_STORAGE_BINDINGS,
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: 'Object storage (S3 bucket)' },
    ]),
  });

  // ALB endpoint — always present.
  resources.push({
    id: 'endpoint',
    kind: 'generic_service',
    label: 'Application load balancer',
    ownership: 'DEPLOYZ_MANAGED',
    quantity: 1,
    engine: null,
    envBindings: [],
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: 'ALB endpoint for public traffic' },
    ]),
  });

  // Standard queues and dead-letter queues (Phase 5A).
  resources.push(...buildQueueResources(manifest));

  // External services.
  for (const serviceName of manifest.externalServices) {
    resources.push({
      id: `ext-${slugify(serviceName) || 'service'}`,
      kind: 'external_service',
      label: serviceName,
      ownership: 'EXTERNAL_SAAS',
      quantity: 1,
      engine: null,
      envBindings: [],
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: `External service: ${serviceName}` },
      ]),
    });
  }

  return resources;
}

// ── Bindings ────────────────────────────────────────────────────────────────

function buildBindings(manifest: DeploymentManifest, workloads: Workload[], resources: Resource[]): Binding[] {
  const bindings: Binding[] = [];
  const resourceMap = new Map(resources.map((r) => [r.id, r]));

  // Managed resource IDs workloads bind to.
  const managedResourceIds: string[] = [];
  if (manifest.database.postgres) managedResourceIds.push('primary-db');
  if (manifest.redis.required) managedResourceIds.push('cache');
  managedResourceIds.push('storage');

  let bindingIndex = 0;
  for (const workload of workloads) {
    for (const resourceId of managedResourceIds) {
      const resource = resourceMap.get(resourceId);
      if (!resource) continue;
      bindings.push({
        id: `binding-${bindingIndex++}`,
        sourceId: workload.id,
        targetId: resourceId,
        relationship: 'BINDING',
        envBindings: resource.envBindings,
        provenance: detectedProvenance([
          { sourceType: 'source_import', path: manifest.application.root, description: `${workload.id} → ${resourceId}` },
        ]),
      });
    }
  }

  // RUNTIME binding from web to every worker.
  const web = workloads.find((w) => w.kind === 'web');
  if (web !== undefined) {
    for (const worker of workloads.filter((w) => w.kind === 'worker')) {
      bindings.push({
        id: `binding-${bindingIndex++}`,
        sourceId: web.id,
        targetId: worker.id,
        relationship: 'RUNTIME',
        envBindings: [],
        provenance: detectedProvenance([
          { sourceType: 'source_import', path: manifest.application.root, description: `${web.id} ↔ ${worker.id} runtime relationship` },
        ]),
      });
    }
  }

  // STARTUP binding from migration to primary-db.
  if (workloads.some((w) => w.id === 'migration') && manifest.database.postgres) {
    bindings.push({
      id: `binding-${bindingIndex++}`,
      sourceId: 'migration',
      targetId: 'primary-db',
      relationship: 'STARTUP',
      envBindings: resourceMap.get('primary-db')?.envBindings ?? [],
      provenance: detectedProvenance([
        { sourceType: 'source_import', path: manifest.application.root, description: 'Migration → primary-db startup dependency' },
      ]),
    });
  }

  bindings.push(...asyncBindings(manifest, () => `binding-${bindingIndex++}`));

  return bindings;
}

// ── External services (graph-level list) ────────────────────────────────────

function buildExternalServices(manifest: DeploymentManifest): ExternalService[] {
  return manifest.externalServices.map((name) => ({
    id: `ext-${slugify(name) || 'service'}`,
    name,
    reason: 'saas' as const,
    provenance: detectedProvenance([
      { sourceType: 'source_import', path: manifest.application.root, description: `External service: ${name}` },
    ]),
  }));
}

// ── Unresolved requirements ─────────────────────────────────────────────────

function buildUnresolved(manifest: DeploymentManifest): UnresolvedRequirement[] {
  const unresolved: UnresolvedRequirement[] = [];

  // Unsupported reasons are blocking.
  for (let i = 0; i < manifest.unsupported.length; i++) {
    const reason = manifest.unsupported[i]!;
    unresolved.push({
      id: `unsupported-${i}`,
      field: 'compatibility',
      question: reason,
      evidence: [
        { sourceType: 'source_import', path: manifest.application.root, description: reason },
      ],
      blocking: true,
    });
  }

  // A managed relational database without migration strategy.
  if (
    manifest.database.postgres &&
    !manifest.migration.command &&
    manifest.migration.mode === 'unknown'
  ) {
    const engineName = manifest.database.engine === 'mysql' ? 'MySQL' : 'PostgreSQL';
    unresolved.push({
      id: 'migration-strategy',
      field: 'migration_strategy',
      question: `This application uses ${engineName} but has no detected migration command. How should the database schema be updated on deploy?`,
      evidence: [
        {
          sourceType: 'orm_configuration',
          path: manifest.application.root,
          description: `${engineName} detected but no migration command or strategy found`,
        },
      ],
      blocking: false,
    });
  }

  // Worker-like code with no declared start command — needs input, never
  // auto-provisioned (Phase 4A).
  if (manifest.worker.needsCommand === true) {
    unresolved.push({
      id: 'worker-command',
      field: 'worker_command',
      question:
        'This application appears to run background jobs, but no command was found that starts a worker process. What command should Deployz run for the background worker?',
      evidence: [
        {
          sourceType: 'source_import',
          path: manifest.application.root,
          description: 'Worker-like code detected but no worker start command declared',
        },
      ],
      blocking: false,
    });
  }

  // Ambiguous queue/schedule evidence (Phase 5) — needs input, never provisioned.
  for (const question of manifest.questions ?? []) {
    unresolved.push({
      id: question.id,
      field: question.field,
      question: question.question,
      evidence: [{ sourceType: 'source_import', path: question.source, description: question.question }],
      blocking: false,
    });
  }

  // External services (Stripe, OpenAI, …) are never a question: Deployz
  // never provisions them. They stay `EXTERNAL_SAAS` resources, and their
  // credentials are environment variables.

  return unresolved;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** The graph's schedules — omitted when none, so pre-Phase-5 graphs hash unchanged. */
function withSchedules(manifest: DeploymentManifest): { schedules?: Schedule[] } {
  const schedules = buildSchedules(manifest);
  return schedules.length > 0 ? { schedules } : {};
}

/**
 * Build an ApplicationGraph from a validated manifest, analysis result, and
 * vendor overrides. The overrides parameter is accepted for interface
 * completeness; the manifest is the authoritative input (overrides are
 * already baked in by normalizeDeploymentManifest).
 */
export function buildApplicationGraph(input: {
  analysisResult: AnalysisResult;
  manifest: DeploymentManifest;
  overrides: DeploymentManifestOverrides;
}): ApplicationGraph {
  const { manifest } = input;
  const workloads = buildWorkloads(manifest);
  const resources = buildResources(manifest);

  const graph: ApplicationGraph = {
    schemaVersion: 1,
    applicationRoot: manifest.application.root,
    buildArtifacts: buildArtifacts(manifest),
    workloads,
    resources,
    bindings: buildBindings(manifest, workloads, resources),
    ...withSchedules(manifest),
    externalServices: buildExternalServices(manifest),
    unresolved: buildUnresolved(manifest),
  };

  return applicationGraphSchema.parse(graph);
}

/**
 * Build an ApplicationGraph from an existing manifest alone (no analysis
 * result or overrides). Used where the frozen manifest is the only input to
 * the compile pipeline.
 */
export function manifestToApplicationGraph(manifest: DeploymentManifest): ApplicationGraph {
  const workloads = buildWorkloads(manifest);
  const resources = buildResources(manifest);

  const graph: ApplicationGraph = {
    schemaVersion: 1,
    applicationRoot: manifest.application.root,
    buildArtifacts: buildArtifacts(manifest),
    workloads,
    resources,
    bindings: buildBindings(manifest, workloads, resources),
    ...withSchedules(manifest),
    externalServices: buildExternalServices(manifest),
    unresolved: buildUnresolved(manifest),
  };

  return applicationGraphSchema.parse(graph);
}
