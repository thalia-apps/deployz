/**
 * CONFIG_UPDATE executor — apply desired configuration to the running
 * application.
 *
 * Two kinds of values, two paths (Task 5.1):
 *   - Secret values are written INTO the customer's Secrets Manager by this
 *     executor (they arrive transiently in the command payload — the control
 *     plane never stores them), then the task definition references them
 *     via a `secrets` entry (`valueFrom`), which ECS injects at task start.
 *   - Plain values are environment variables on the ECS task definition.
 *     A force restart alone does NOT update them — the definition must be
 *     copied, the environment array updated, and a new revision registered
 *     before the service is updated to use it.
 *
 * Idempotent: when the desired plain values and secret bindings already
 * match the running task definition, the answer is success with no new
 * revision registered. Secret values are merged into ONE per-installation
 * Secrets Manager secret — the application template's `AppConfigSecret`
 * (its execution role already grants read, so no new IAM is needed) — so a
 * save that only touched one key leaves the other keys intact.
 *
 * Generated secrets (AI MVP Phase 4): an entry flagged `generated` is an
 * application-internal secret the control plane never holds a value for.
 * The relay mints it here — cryptographic randomness, inside the customer's
 * account, once — and keeps it across every later run. A secret key whose
 * value is absent from the store (a vendor-scope secret entered before the
 * relay existed, whose value the control plane could not keep) is reported
 * as unbound rather than bound: binding a missing key would stop every task
 * from starting.
 *
 * Settlement: a pass that changed a running service reports success only
 * after every affected service completed the rollout it started — the
 * expected task count, the PRIMARY deployment COMPLETED on the target
 * revision, and every ALB target healthy (the deploy executor's gates). The
 * target revision and the ECS deployment id of each rollout ride the pending
 * marker, so a later invocation resumes the wait. A circuit-breaker rollback
 * to the previous revision fails the operation. A secret-only change (same
 * bindings, new value) forces fresh tasks, because ECS reads a secret only at
 * task start. A service at zero tasks (an install that waits for its first
 * start) only gets its task definition re-pointed: delivery is complete
 * there, and the first deploy starts it.
 */

import { randomBytes } from 'node:crypto';

import {
  GetSecretValueCommand,
  PutSecretValueCommand,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';

import type { CommandExecutor, RelayCommandResult } from './commands.js';
import type { CloudFormationReader, StackResource } from './verify.js';
import {
  CRASH_LOOP_THRESHOLD,
  crashedTasksOfRevision,
  deploymentTargetsHealthy,
  primaryRolloutCompleted,
  rolloutFailed,
  sameRegistration,
  type EcsDeployClient,
  type EcsTaskDefinition,
  type RegisterTaskDefinitionInput,
} from './deploy.js';
import type { TargetHealthReader } from './ecs-health.js';
import { essentialContainerNames } from './ecs-observe.js';
import { pruneSupersededRevisions } from './task-revisions.js';
import {
  reportSettled,
  saveMarker,
  settledResultOf,
  settleMarker,
  type CheckAuthority,
  type PendingStore,
} from './pending.js';

/** One entry from the control plane's effective configuration. */
export interface EffectiveConfigEntry {
  readonly key: string;
  readonly isSecret: boolean;
  /** Present only for plain values; secrets are write-only in the control plane. */
  readonly value?: string;
  readonly source: 'vendor' | 'customer' | 'generated';
  /** Deployz mints this secret inside the customer's account when it is absent. */
  readonly generated?: boolean;
}

/**
 * Secrets Manager write surface for customer config secrets (injectable seam
 * for testing). The relay talks only to secrets the customer's own
 * application stack created (`AppConfigSecret`) or the relay itself created.
 */
export interface ConfigSecretsWriter {
  getSecretValue(params: { SecretId: string }): Promise<{
    /** The secret's ARN as Secrets Manager reports it. */
    arn: string;
    secretString: string | undefined;
  }>;
  putSecretValue(params: { SecretId: string; secretString: string }): Promise<void>;
}

export interface ConfigUpdateDeps {
  readonly cfn: CloudFormationReader;
  readonly ecs: EcsDeployClient;
  /** Writes customer config secrets into the customer's Secrets Manager. */
  readonly secrets: ConfigSecretsWriter;
  /** Fetches the effective desired config over the authenticated channel. */
  readonly fetchEffectiveConfig: () => Promise<EffectiveConfigEntry[]>;
  readonly stackName: string;
  readonly installationId: string;
  /** Mints a generated secret value (injectable for tests). */
  readonly generateSecret?: (key: string) => string;
  /** ALB target-health reader behind the settle gate (the deploy executor's gate). */
  readonly elb: TargetHealthReader;
  /** Carries the rollouts to a later invocation while they run. */
  readonly pending: PendingStore;
  /** Whether the control plane still owns the command; an unowned one writes nothing. */
  readonly checkAuthority?: CheckAuthority;
  readonly now?: () => string;
}

/** The deps that settling already-started rollouts needs (no config fetch, no secret store). */
export type ConfigRolloutDeps = Pick<ConfigUpdateDeps, 'cfn' | 'ecs' | 'elb' | 'pending' | 'stackName'>;

/** One service rollout a CONFIG_UPDATE started and must see complete. */
export interface ConfigRollout {
  /** The task-definition revision the service must run when the rollout completes. */
  readonly taskDefinition: string;
  /** The ECS deployment the update created, when ECS reported it. */
  readonly deploymentId?: string;
  /** The update registered this revision, so its own crashed tasks are evidence. */
  readonly newRevision: boolean;
}

/** What one configuration pass did with the secret store. */
export interface ConfigSecretReport {
  /** Keys minted in this run. */
  readonly generatedKeys: string[];
  /** Secret keys the effective config names but the store has no value for — left unbound. */
  readonly unboundSecretKeys: string[];
}

type ConfigUpdateOutcome =
  | { readonly state: 'succeeded'; readonly alreadyApplied: boolean; readonly report: ConfigSecretReport }
  | { readonly state: 'failed'; readonly reason: string }
  | {
      readonly state: 'updating';
      readonly report: ConfigSecretReport;
      /** Keyed by ECS service ARN. */
      readonly rollouts: Readonly<Record<string, ConfigRollout>>;
    };

/**
 * 256 bits of randomness, URL-safe — usable as any session/JWT/encryption secret.
 * Laravel reads APP_KEY as raw bytes unless it starts with `base64:`, and its
 * AES-256 encrypter needs exactly 32 bytes, so APP_KEY gets that form.
 */
export function generateSecretValue(key?: string): string {
  return key === 'APP_KEY' ? `base64:${randomBytes(32).toString('base64')}` : randomBytes(32).toString('base64url');
}

/**
 * Computes the environment-array delta: which plain entries need to be
 * added or changed on the task definition. Pure, so the comparison rules
 * are testable without AWS.
 */
export function computeEnvChanges(
  desired: readonly EffectiveConfigEntry[],
  currentEnvironment: readonly { name?: string | undefined; value?: string | undefined }[],
  removedKeys: readonly string[] = [],
): { changes: { name: string; value: string }[]; removals: string[] } | null {
  const desiredPlain = desired.filter((entry) => !entry.isSecret && entry.value !== undefined);
  const currentByName = new Map(
    currentEnvironment
      .filter((env) => typeof env.name === 'string')
      .map((env) => [env.name as string, env.value ?? '']),
  );

  const changes: { name: string; value: string }[] = [];
  for (const entry of desiredPlain) {
    const current = currentByName.get(entry.key);
    if (current !== entry.value) {
      changes.push({ name: entry.key, value: entry.value! });
    }
  }
  // Only the keys the vendor explicitly removed are stripped — everything
  // else in the environment (install-time values the template baked in) is
  // not Deployz-managed and must survive untouched.
  const removals = removedKeys.filter((key) => currentByName.has(key));
  return changes.length > 0 || removals.length > 0 ? { changes, removals } : null;
}

/**
 * Computes the task-definition `secrets` delta: which secret keys need to
 * be (re)bound to the customer's config secret, and which explicitly removed
 * keys leave the array. Pure and testable without AWS.
 */
export function computeSecretChanges(
  desired: readonly EffectiveConfigEntry[],
  currentSecrets: readonly { name?: string | undefined; valueFrom?: string | undefined }[],
  secretArn: string,
  removedKeys: readonly string[] = [],
  availableKeys?: ReadonlySet<string>,
): { bindings: { name: string; valueFrom: string }[]; removals: string[] } | null {
  const currentByName = new Map(
    currentSecrets
      .filter((secret) => typeof secret.name === 'string' && typeof secret.valueFrom === 'string')
      .map((secret) => [secret.name as string, secret.valueFrom as string]),
  );

  const bindings: { name: string; valueFrom: string }[] = [];
  for (const entry of desired) {
    if (!entry.isSecret) continue;
    // A key the store holds no value for is never bound (ECS would refuse
    // to start the task); the caller reports it instead.
    if (availableKeys !== undefined && !availableKeys.has(entry.key)) continue;
    // Deterministic ECS keyed-json reference into the config secret. The
    // secret ARN can change across re-creates, so a re-point is a change.
    const valueFrom = `${secretArn}:${entry.key}::`;
    if (currentByName.get(entry.key) !== valueFrom) {
      bindings.push({ name: entry.key, valueFrom });
    }
  }
  const removals = removedKeys.filter((key) => currentByName.has(key));
  return bindings.length > 0 || removals.length > 0 ? { bindings, removals } : null;
}

/**
 * The application template's runtime-secrets resource, discovered by logical
 * id — the physical id is its Secrets Manager ARN. Null when the stack does
 * not contain it (an old template), which the caller fails on honestly.
 */
export function findAppConfigSecretArn(resources: readonly StackResource[]): string | null {
  // compiler-v2 names it by its stable semantic id (`ApplicationConfigSecret`).
  // A CDK stack appends a hash to an L2 construct's logical id
  // (`AppConfigSecret251CAC1E`), so that match is on the construct-id prefix,
  // never on equality — an exact match found nothing in every real stack
  // (DEPLOY-010).
  const secret = resources.find(
    (resource) =>
      resource.type === 'AWS::SecretsManager::Secret' &&
      (resource.logicalId === 'ApplicationConfigSecret' || resource.logicalId.startsWith('AppConfigSecret')),
  );
  return secret?.physicalId ?? null;
}

/**
 * The application container: the one with environment variables, or the
 * first one — the same heuristic the deploy executor uses.
 */
function applicationContainer(definition: EcsTaskDefinition): Record<string, unknown> | undefined {
  return (
    definition.containerDefinitions.find(
      (container) =>
        Array.isArray(container['environment']) && (container['environment'] as unknown[]).length > 0,
    ) ?? definition.containerDefinitions[0]
  );
}

/** The config secret's stored key/value object (empty when it holds no JSON object). */
async function readStoredSecrets(deps: Pick<ConfigUpdateDeps, 'secrets'>, arn: string): Promise<Record<string, unknown>> {
  const existing = await deps.secrets.getSecretValue({ SecretId: arn });
  if (existing.secretString === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(existing.secretString);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return { ...(parsed as Record<string, unknown>) };
    }
  } catch {
    // Not a JSON object — treat as empty rather than corrupting what the
    // application stack manages with a lost merge.
  }
  return {};
}

/**
 * The keys of the effective configuration `definition` does not carry yet —
 * what a CONFIG_UPDATE pass would still change on it (DEPLOY-009). Empty
 * means the revision is configured. Read-only: the secret store is read,
 * never written. A secret the pass would make available (a value it
 * delivers, a key it mints) counts as required; a key no pass can bind is
 * left out, exactly as the pass leaves it unbound.
 */
export async function unappliedConfigurationKeys(
  deps: Pick<ConfigUpdateDeps, 'cfn' | 'secrets' | 'fetchEffectiveConfig' | 'stackName'>,
  definition: EcsTaskDefinition,
): Promise<string[]> {
  const desired = await deps.fetchEffectiveConfig();
  if (desired.length === 0) return [];
  const appContainer = applicationContainer(definition);
  if (!appContainer) return desired.map((entry) => entry.key);

  const currentEnv = (appContainer['environment'] as { name?: string; value?: string }[]) ?? [];
  const unapplied = computeEnvChanges(desired, currentEnv)?.changes.map((change) => change.name) ?? [];

  const desiredSecrets = desired.filter((entry) => entry.isSecret);
  if (desiredSecrets.length > 0) {
    const secretArn = findAppConfigSecretArn(await deps.cfn.describeStackResources(deps.stackName));
    if (secretArn === null) return [...unapplied, ...desiredSecrets.map((entry) => entry.key)];
    const stored = await readStoredSecrets(deps, secretArn);
    const available = new Set(
      desiredSecrets
        .filter(
          (entry) =>
            entry.generated === true ||
            (typeof entry.value === 'string' && entry.value.length > 0) ||
            (typeof stored[entry.key] === 'string' && (stored[entry.key] as string).length > 0),
        )
        .map((entry) => entry.key),
    );
    const currentSecrets = (appContainer['secrets'] as { name?: string; valueFrom?: string }[]) ?? [];
    const secretDelta = computeSecretChanges(desired, currentSecrets, secretArn, [], available);
    unapplied.push(...(secretDelta?.bindings.map((binding) => binding.name) ?? []));
  }
  return unapplied;
}

async function settleConfigUpdate(
  deps: ConfigUpdateDeps,
  removedKeys: readonly string[] = [],
  secretValues: Readonly<Record<string, string>> = {},
): Promise<ConfigUpdateOutcome> {
  const desired = await deps.fetchEffectiveConfig();

  const resources = await deps.cfn.describeStackResources(deps.stackName);
  // Phase 4A: one service per persistent workload — the desired config
  // reaches EVERY workload (each task definition bakes the same env/secrets),
  // never just the first service found.
  const serviceArns = resources
    .filter((resource) => resource.type === 'AWS::ECS::Service' && resource.physicalId !== undefined)
    .map((resource) => resource.physicalId!);
  if (serviceArns.length === 0) {
    return { state: 'failed', reason: `No ECS service found in stack "${deps.stackName}"` };
  }
  const cluster = serviceArns[0]!.split('/')[1] ?? null;
  if (!cluster) {
    return { state: 'failed', reason: `Malformed service ARN "${serviceArns[0]!}"` };
  }

  const { services } = await deps.ecs.describeServices({ cluster, services: serviceArns });
  // DescribeServices answers in request order; zip each answer to the ARN
  // that asked for it. A service that cannot be described fails the pass —
  // config that silently skips a workload would leave two sources of truth.
  const live: { arn: string; taskDefinition: string; desiredCount: number }[] = [];
  for (let i = 0; i < serviceArns.length; i++) {
    const service = services[i];
    if (!service || service.taskDefinition === undefined) {
      return { state: 'failed', reason: `ECS service "${serviceArns[i]}" could not be described` };
    }
    live.push({ arn: serviceArns[i]!, taskDefinition: service.taskDefinition, desiredCount: service.desiredCount ?? 0 });
  }

  // ── Secret reconciliation ──────────────────────────────────────────────
  // Newly-entered values ride the command payload transiently; previously
  // entered values already live in the customer's config secret. Merge the
  // new values in and remove deleted keys; binding follows the effective
  // config's secret keys (all of them, not just the changed ones). The store
  // is shared by every workload, so this runs ONCE.
  const desiredSecrets = desired.filter((entry) => entry.isSecret);
  const hasIncomingValues = Object.keys(secretValues).length > 0;
  const generatedKeys: string[] = [];
  const unboundSecretKeys: string[] = [];
  const availableSecretKeys = new Set<string>();
  let secretArn: string | null = null;
  let storeChanged = false;
  if (desiredSecrets.length > 0 || hasIncomingValues || removedKeys.length > 0) {
    const arn = findAppConfigSecretArn(resources);
    if (arn === null) {
      return {
        state: 'failed',
        reason: `Stack "${deps.stackName}" has no AppConfigSecret to write config secrets into`,
      };
    }
    secretArn = arn;

    const merged = await readStoredSecrets(deps, arn);
    let changed = false;
    // Pending pre-relay values arrive in the desired entries (the vault
    // overlay on /api/relay/config), not the command payload. A same-key
    // value in the payload is the newer vendor intent and wins over it.
    for (const entry of desiredSecrets) {
      if (typeof entry.value === 'string' && entry.value.length > 0 && merged[entry.key] !== entry.value) {
        merged[entry.key] = entry.value;
        changed = true;
      }
    }
    for (const [key, value] of Object.entries(secretValues)) {
      if (merged[key] !== value) {
        merged[key] = value;
        changed = true;
      }
    }
    for (const key of removedKeys) {
      if (key in merged) {
        delete merged[key];
        changed = true;
      }
    }
    // Mint each generated secret exactly once: a value already in the store
    // (an earlier pass, or a value the vendor chose to set) is kept.
    for (const entry of desiredSecrets) {
      if (entry.generated === true && !(typeof merged[entry.key] === 'string' && (merged[entry.key] as string).length > 0)) {
        merged[entry.key] = (deps.generateSecret ?? generateSecretValue)(entry.key);
        generatedKeys.push(entry.key);
        changed = true;
      }
    }
    if (changed) {
      await deps.secrets.putSecretValue({ SecretId: arn, secretString: JSON.stringify(merged) });
      storeChanged = true;
    }
    for (const entry of desiredSecrets) {
      if (typeof merged[entry.key] === 'string' && (merged[entry.key] as string).length > 0) {
        availableSecretKeys.add(entry.key);
      } else {
        unboundSecretKeys.push(entry.key);
      }
    }
  }

  const report: ConfigSecretReport = { generatedKeys, unboundSecretKeys };

  // Per-workload deltas: each task definition carries its own current
  // env/secrets arrays, so each computes its own delta against the same
  // desired config.
  interface ServiceDelta {
    readonly arn: string;
    readonly desiredCount: number;
    readonly taskDefinition: Awaited<ReturnType<EcsDeployClient['describeTaskDefinition']>>['taskDefinition'];
    readonly envDelta: ReturnType<typeof computeEnvChanges>;
    readonly secretDelta: ReturnType<typeof computeSecretChanges>;
    readonly appContainer: Record<string, unknown>;
  }
  const deltas: ServiceDelta[] = [];
  // Running services whose task definition stays the same but whose bound
  // secret values changed: ECS reads a secret only at task start.
  const restarts: { arn: string; taskDefinition: string }[] = [];
  for (const liveService of live) {
    const { taskDefinition } = await deps.ecs.describeTaskDefinition({
      taskDefinition: liveService.taskDefinition,
    });

    const appContainer = applicationContainer(taskDefinition);
    if (!appContainer) {
      return { state: 'failed', reason: 'Task definition has no container definitions' };
    }

    const currentEnv = (appContainer['environment'] as { name?: string; value?: string }[]) ?? [];
    const currentSecrets = (appContainer['secrets'] as { name?: string; valueFrom?: string }[]) ?? [];
    const envDelta = computeEnvChanges(desired, currentEnv, removedKeys);
    const secretDelta =
      secretArn === null
        ? null
        : computeSecretChanges(desired, currentSecrets, secretArn, removedKeys, availableSecretKeys);
    if (envDelta === null && secretDelta === null) {
      const bindsConfigSecret =
        secretArn !== null && currentSecrets.some((secret) => secret.valueFrom?.startsWith(`${secretArn}:`) === true);
      if (storeChanged && bindsConfigSecret && liveService.desiredCount > 0) {
        restarts.push({ arn: liveService.arn, taskDefinition: liveService.taskDefinition });
      }
      continue;
    }
    deltas.push({
      arn: liveService.arn,
      desiredCount: liveService.desiredCount,
      taskDefinition,
      envDelta,
      secretDelta,
      appContainer: appContainer as Record<string, unknown>,
    });
  }

  if (deltas.length === 0 && restarts.length === 0) {
    return { state: 'succeeded', alreadyApplied: true, report };
  }
  const rollouts: Record<string, ConfigRollout> = {};

  // Apply the deltas: per service, merge changes into the environment array
  // and the secrets array, strip the explicitly removed keys, register a new
  // revision of that workload's task definition, and point its service at it.
  for (const delta of deltas) {
    const currentEnv =
      (delta.appContainer['environment'] as { name?: string; value?: string }[]) ?? [];
    const currentSecrets =
      (delta.appContainer['secrets'] as { name?: string; valueFrom?: string }[]) ?? [];

    const envByName = new Map(currentEnv.map((env) => [env.name ?? '', env.value ?? '']));
    if (delta.envDelta !== null) {
      for (const change of delta.envDelta.changes) {
        envByName.set(change.name, change.value);
      }
      for (const removed of delta.envDelta.removals) {
        envByName.delete(removed);
      }
    }
    const nextEnvironment = [...envByName.entries()].map(([name, value]) => ({ name, value }));

    const secretsByName = new Map(currentSecrets.map((secret) => [secret.name ?? '', secret.valueFrom ?? '']));
    if (delta.secretDelta !== null) {
      for (const binding of delta.secretDelta.bindings) {
        secretsByName.set(binding.name, binding.valueFrom);
      }
      for (const removed of delta.secretDelta.removals) {
        secretsByName.delete(removed);
      }
    }
    const nextSecrets = [...secretsByName.entries()].map(([name, valueFrom]) => ({ name, valueFrom }));

    const updatedContainers = delta.taskDefinition.containerDefinitions.map((container) =>
      container === delta.appContainer
        ? {
            ...container,
            environment: delta.envDelta === null ? container['environment'] : nextEnvironment,
            ...(delta.secretDelta !== null ? { secrets: nextSecrets } : {}),
          }
        : { ...container },
    );

    const nextDefinition: RegisterTaskDefinitionInput = {
      family: delta.taskDefinition.family,
      cpu: delta.taskDefinition.cpu,
      memory: delta.taskDefinition.memory,
      networkMode: delta.taskDefinition.networkMode,
      requiresCompatibilities: delta.taskDefinition.requiresCompatibilities,
      executionRoleArn: delta.taskDefinition.executionRoleArn,
      taskRoleArn: delta.taskDefinition.taskRoleArn,
      containerDefinitions: updatedContainers,
      ...(delta.taskDefinition.volumes ? { volumes: delta.taskDefinition.volumes } : {}),
      // The relay's ecs:RegisterTaskDefinition grant is request-tag scoped —
      // an untagged register is AccessDenied (verified live), same as the
      // deploy executor's register.
      tags: [{ key: 'deployz:installation', value: deps.installationId }],
    };

    // A replayed pass whose earlier attempt registered this exact revision
    // but never attached it reuses that revision instead of registering a
    // duplicate.
    const { taskDefinition: latest } =
      delta.taskDefinition.family !== undefined
        ? await deps.ecs.describeTaskDefinition({ taskDefinition: delta.taskDefinition.family })
        : { taskDefinition: undefined };
    const configuredArn =
      latest?.taskDefinitionArn !== undefined && sameRegistration(latest, nextDefinition)
        ? latest.taskDefinitionArn
        : (await deps.ecs.registerTaskDefinition(nextDefinition)).taskDefinitionArn;
    await deps.ecs.updateService({
      cluster,
      service: delta.arn,
      taskDefinition: configuredArn,
    });
    // A service at zero tasks has nothing to roll: the re-pointed definition
    // is what its first start runs.
    if (delta.desiredCount > 0) {
      rollouts[delta.arn] = { taskDefinition: configuredArn, newRevision: true };
    }
  }
  for (const restart of restarts) {
    await deps.ecs.updateService({ cluster, service: restart.arn, forceNewDeployment: true });
    rollouts[restart.arn] = { taskDefinition: restart.taskDefinition, newRevision: false };
  }

  const rolloutArns = Object.keys(rollouts);
  if (rolloutArns.length === 0) {
    return { state: 'succeeded', alreadyApplied: false, report };
  }
  // The PRIMARY deployment right after the update is the rollout this pass
  // started — its id is what a later poll waits for.
  const { services: started } = await deps.ecs.describeServices({ cluster, services: rolloutArns });
  for (let i = 0; i < rolloutArns.length; i++) {
    const id = started[i]?.deployments?.find((deployment) => deployment.status === 'PRIMARY')?.id;
    if (id !== undefined) rollouts[rolloutArns[i]!] = { ...rollouts[rolloutArns[i]!]!, deploymentId: id };
  }
  return { state: 'updating', report, rollouts };
}

export type RolloutVerdict =
  | { readonly state: 'succeeded' }
  | { readonly state: 'in-progress' }
  | { readonly state: 'failed'; readonly reason: string; readonly failureCode: string };

/**
 * Whether every rollout a CONFIG_UPDATE started has completed. Reads before
 * it decides, and never mutates. A rollout is complete when its service's
 * PRIMARY deployment is the one this update created, runs the target
 * revision, reached COMPLETED with the expected task count, and every ALB
 * target is healthy. A circuit-breaker rollback, a PRIMARY on another
 * revision or deployment, or a crash loop of the new revision fails it.
 */
export async function settleConfigRollouts(
  deps: ConfigRolloutDeps,
  rollouts: Readonly<Record<string, ConfigRollout>>,
  operation: 'configuration update' | 'restart' = 'configuration update',
): Promise<RolloutVerdict> {
  const arns = Object.keys(rollouts);
  const cluster = arns[0]?.split('/')[1];
  if (cluster === undefined) return { state: 'failed', reason: 'No rollout to settle', failureCode: 'UNKNOWN' };
  const { services } = await deps.ecs.describeServices({ cluster, services: arns });
  const failures: { reason: string; failureCode: string }[] = [];
  let inProgress = false;
  for (let i = 0; i < arns.length; i++) {
    const arn = arns[i]!;
    const rollout = rollouts[arn]!;
    const service = services[i];
    if (!service || service.taskDefinition === undefined) {
      failures.push({ reason: `ECS service "${arn}" could not be described`, failureCode: 'AWS_PERMISSION_DENIED' });
      continue;
    }
    const deployments = service.deployments ?? [];
    const primary = deployments.find((deployment) => deployment.status === 'PRIMARY');
    const ours =
      rollout.deploymentId !== undefined
        ? deployments.find((deployment) => deployment.id === rollout.deploymentId)
        : undefined;
    const rolledBack =
      (rollout.deploymentId !== undefined ? ours?.rolloutState === 'FAILED' : rolloutFailed(deployments)) ||
      (primary?.taskDefinition !== undefined && primary.taskDefinition !== rollout.taskDefinition) ||
      (rollout.deploymentId !== undefined && primary?.id !== undefined && primary.id !== rollout.deploymentId);
    if (rolledBack) {
      failures.push({
        reason: `ECS rolled service "${arn}" back to ${primary?.taskDefinition ?? 'its previous revision'}; the ${operation} never became healthy.${
          operation === 'restart'
            ? ''
            : ' Secret values already written to the configuration secret were not restored.'
        }`,
        failureCode: 'ECS_DEPLOYMENT_FAILED',
      });
      continue;
    }
    if (rollout.newRevision) {
      const { taskDefinition } = await deps.ecs.describeTaskDefinition({ taskDefinition: rollout.taskDefinition });
      const crashed = await crashedTasksOfRevision(
        deps,
        cluster,
        arn,
        rollout.taskDefinition,
        essentialContainerNames(taskDefinition.containerDefinitions),
      );
      if (crashed.count >= CRASH_LOOP_THRESHOLD) {
        failures.push({
          reason: `${crashed.count} tasks of the new configuration revision exited with code ${crashed.exitCode} (${crashed.stoppedReason})`,
          failureCode: 'CONTAINER_START_FAILED',
        });
        continue;
      }
    }
    const desired = service.desiredCount ?? 0;
    const settled =
      primaryRolloutCompleted(deployments) && desired > 0 && (service.runningCount ?? 0) >= desired;
    if (!settled) inProgress = true;
  }
  if (failures.length > 0) {
    return {
      state: 'failed',
      reason: failures.map((failure) => failure.reason).join('; '),
      failureCode: failures[0]!.failureCode,
    };
  }
  if (inProgress || !(await deploymentTargetsHealthy(deps))) return { state: 'in-progress' };
  if (operation === 'configuration update') {
    await pruneSupersededRevisions(
      deps,
      Object.values(rollouts).map((rollout) => rollout.taskDefinition),
    );
  }
  return { state: 'succeeded' };
}

/** The rollouts a CONFIG_UPDATE marker carries, or null when it carries none. */
export function readConfigRollouts(payload: Record<string, unknown>): Record<string, ConfigRollout> | null {
  const raw = payload['configRollouts'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const rollouts: Record<string, ConfigRollout> = {};
  for (const [arn, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) return null;
    const entry = value as Record<string, unknown>;
    if (typeof entry['taskDefinition'] !== 'string') return null;
    rollouts[arn] = {
      taskDefinition: entry['taskDefinition'],
      newRevision: entry['newRevision'] === true,
      ...(typeof entry['deploymentId'] === 'string' ? { deploymentId: entry['deploymentId'] } : {}),
    };
  }
  return Object.keys(rollouts).length > 0 ? rollouts : null;
}

function reportFromMarker(payload: Record<string, unknown>): ConfigSecretReport {
  const keys = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((key): key is string => typeof key === 'string') : [];
  return { generatedKeys: keys(payload['generatedKeys']), unboundSecretKeys: keys(payload['unboundSecretKeys']) };
}

/** The result for a settled rollout verdict, or null while it still runs. */
function rolloutResult(
  commandId: string,
  idempotencyKey: string,
  verdict: RolloutVerdict,
  report: ConfigSecretReport,
): RelayCommandResult | null {
  if (verdict.state === 'in-progress') return null;
  if (verdict.state === 'failed') {
    return { commandId, idempotencyKey, success: false, error: verdict.reason, failureCode: verdict.failureCode };
  }
  return {
    commandId,
    idempotencyKey,
    success: true,
    output: {
      executed: true,
      type: 'CONFIG_UPDATE',
      alreadyApplied: false,
      // Key names only — never a value.
      generatedKeys: report.generatedKeys,
      unboundSecretKeys: report.unboundSecretKeys,
    },
  };
}

/** Finishes a CONFIG_UPDATE rollout an earlier invocation started. */
export function createConfigUpdateResumer(deps: ConfigRolloutDeps): () => Promise<RelayCommandResult[]> {
  return async () => {
    const current = await deps.pending.inspect();
    if (current.state !== 'present' || current.marker.type !== 'CONFIG_UPDATE') return [];
    const pending = current.marker;
    const stored = settledResultOf(pending);
    if (stored !== null) return [stored];

    const rollouts = readConfigRollouts(pending.payload);
    const result =
      rollouts === null
        ? {
            commandId: pending.commandId,
            idempotencyKey: pending.idempotencyKey,
            success: false,
            error: 'Pending configuration update lost its rollouts',
          }
        : rolloutResult(
            pending.commandId,
            pending.idempotencyKey,
            await settleConfigRollouts(deps, rollouts),
            reportFromMarker(pending.payload),
          );
    if (result === null) return [];
    // A newer command owns the marker now: this answer is obsolete.
    if (!(await settleMarker(deps.pending, pending, result, false))) return [];
    return [result];
  };
}

export function createConfigUpdateExecutor(deps: ConfigUpdateDeps): CommandExecutor {
  return async (command) => {
    console.log(
      JSON.stringify({
        event: 'relay:command-executed',
        commandId: command.id,
        type: command.type,
        deploymentId: command.deploymentId,
        idempotencyKey: command.idempotencyKey,
      }),
    );

    const payload = command.payload as { removedKeys?: unknown; secrets?: unknown };
    const payloadRemoved = payload.removedKeys;
    const removedKeys = Array.isArray(payloadRemoved)
      ? payloadRemoved.filter((key): key is string => typeof key === 'string')
      : [];

    const payloadSecrets = payload.secrets;
    const secretValues: Record<string, string> = {};
    if (Array.isArray(payloadSecrets)) {
      for (const entry of payloadSecrets) {
        if (typeof entry !== 'object' || entry === null) continue;
        const key = (entry as { key?: unknown }).key;
        const value = (entry as { value?: unknown }).value;
        if (typeof key === 'string' && key.length > 0 && typeof value === 'string') {
          secretValues[key] = value;
        }
      }
    }
    // Values never surface in a log line — count only.
    console.log(
      JSON.stringify({
        event: 'relay:config-update-payload',
        commandId: command.id,
        removedKeyCount: removedKeys.length,
        secretValueCount: Object.keys(secretValues).length,
      }),
    );

    const base = { commandId: command.id, idempotencyKey: command.idempotencyKey };
    const marker = {
      ...base,
      type: command.type,
      stackName: deps.stackName,
      startedAt: (deps.now ?? (() => new Date().toISOString()))(),
    };

    let outcome: ConfigUpdateOutcome;
    try {
      const current = await deps.pending.inspect();
      // The marker cannot be read, so whether this update already ran is
      // unknown: write nothing and let the control plane offer it again.
      if (current.state === 'unreadable') return { ...base, success: false, deferred: true };
      const existing = current.state === 'present' && current.marker.commandId === command.id ? current.marker : null;

      // A settled marker holds the answer: report it, never apply again.
      const stored = existing === null ? null : settledResultOf(existing);
      if (stored !== null) return stored;

      // A re-offered command whose rollouts are already on its own marker
      // only waits for them; it never applies the configuration twice.
      const existingRollouts = existing?.type === 'CONFIG_UPDATE' ? readConfigRollouts(existing.payload) : null;
      if (existing !== null && existingRollouts !== null) {
        const result = rolloutResult(
          command.id,
          command.idempotencyKey,
          await settleConfigRollouts(deps, existingRollouts),
          reportFromMarker(existing.payload),
        );
        if (result === null) return { ...base, success: false, deferred: true };
        return await reportSettled(deps.pending, existing, result);
      }

      const authority = deps.checkAuthority ? await deps.checkAuthority(command.id) : undefined;
      if (authority === false) {
        return { ...base, success: false, error: 'Configuration command is no longer active — not applying it' };
      }
      if (authority === null) return { ...base, success: false, deferred: true };

      outcome = await settleConfigUpdate(deps, removedKeys, secretValues);
    } catch (err) {
      return await reportSettled(deps.pending, marker, {
        ...base,
        success: false,
        error: String(err),
        failureCode: 'AWS_PERMISSION_DENIED',
      });
    }

    if (outcome.state === 'failed') {
      return await reportSettled(deps.pending, marker, { ...base, success: false, error: outcome.reason });
    }

    if (outcome.state === 'updating') {
      // Record the debt BEFORE deferring. The marker carries the rollouts
      // and key names only — never a secret value.
      const recorded = await saveMarker(deps.pending, {
        ...marker,
        payload: {
          configRollouts: outcome.rollouts,
          generatedKeys: outcome.report.generatedKeys,
          unboundSecretKeys: outcome.report.unboundSecretKeys,
        },
      });
      if (!recorded) {
        return {
          ...base,
          success: false,
          error: 'Configuration rollout started, but the relay could not record that it must report back',
        };
      }
      return { ...base, success: false, deferred: true };
    }

    return await reportSettled(deps.pending, marker, {
      ...base,
      success: true,
      output: {
        executed: true,
        type: command.type,
        alreadyApplied: outcome.alreadyApplied,
        // Key names only — never a value.
        generatedKeys: outcome.report.generatedKeys,
        unboundSecretKeys: outcome.report.unboundSecretKeys,
      },
    });
  };
}

/**
 * Production Secrets Manager writer — credentials come from the standard SDK
 * chain, exactly like the other relay clients.
 */
export function createRealConfigSecretsWriter(): ConfigSecretsWriter {
  const client = new SecretsManagerClient({});
  return {
    async getSecretValue({ SecretId }) {
      const response = await client.send(new GetSecretValueCommand({ SecretId }));
      return { arn: response.ARN ?? SecretId, secretString: response.SecretString };
    },
    async putSecretValue({ SecretId, secretString }) {
      await client.send(new PutSecretValueCommand({ SecretId, SecretString: secretString }));
    },
  };
}