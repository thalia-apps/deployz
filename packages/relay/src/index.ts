/**
 * Relay Lambda handler — the outbound actor in the customer's AWS account.
 *
 * Invoked by EventBridge on a fixed one-minute schedule (defined in the
 * bootstrap stack, todo 8). On each invocation:
 *
 *   1. Reads the bootstrap-generated credential from Secrets Manager
 *   2. Creates/restores the auth state
 *   3. Polls the control plane for pending commands
 *   4. Executes each command (with idempotency)
 *   5. Reports results + observed state back to the control plane (§59)
 *
 * The relay is EGRESS-ONLY: it calls OUT to the control plane; the control
 * plane never reaches INTO the customer account.
 *
 * §16 data boundary: the relay writes operational logs but deliberately
 * CANNOT read them back (no `logs:GetLogEvents` / `logs:FilterLogEvents`).
 * This is enforced at IAM in the bootstrap stack, not in code.
 */

import type { ScheduledEvent } from 'aws-lambda';

import {
  DescribeAvailabilityZonesCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ListTasksCommand,
  DeregisterTaskDefinitionCommand,
  ListTaskDefinitionsCommand,
  RegisterTaskDefinitionCommand,
  RunTaskCommand,
  StopTaskCommand,
  UpdateServiceCommand,
  type RegisterTaskDefinitionCommandInput,
  type RunTaskCommandInput,
} from '@aws-sdk/client-ecs';
import {
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
} from '@aws-sdk/client-elastic-load-balancing-v2';
import { GetSecretValueCommand, SecretsManagerClient as AwsSecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { DeleteStackCommand, CloudFormationClient as AwsCloudFormationClient } from '@aws-sdk/client-cloudformation';
import { buildAuthHeaders, createAuthState, readCredential, type FetchFn, type SecretsClient } from './auth.js';
import {
  IdempotencyStore,
  type CommandExecutor,
  type RelayCommand,
  type RelayCommandResult,
} from './commands.js';
import { createDomainExecutors, createRealDomainAwsClients } from './domain.js';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  type EcsDeployClient,
  type EcsDeployDeps,
  type EcsTaskDefinition,
} from './deploy.js';
import { observeServiceDigests, type EcsTaskReader } from './ecs-observe.js';
import { observeRuntimeHealth, type EcsServiceReader, type TargetHealthReader } from './ecs-health.js';
import { probeHealthUrl } from './http-probe.js';
import { isBootstrapStackUpdating, readBootstrapStackStatus, readRelayIdentity } from './identity.js';
import {
  createDestroyExecutor,
  createDestroyResumer,
  type EcsStandaloneTaskStopper,
  type StackDeleter,
} from './destroy.js';
import {
  createPurgeExecutor,
  createPurgeResumer,
  createRealPurgeClients,
  type AcmPurgeClient,
  type CachePurgeClient,
  type NetworkPurgeClient,
  type PurgeDeps,
  type RdsPurgeClient,
  type S3PurgeClient,
  type SecretsPurgeClient,
  type TaskRevisionPurgeClient,
} from './purge.js';
import {
  createConfigUpdateExecutor,
  createConfigUpdateResumer,
  createRealConfigSecretsWriter,
  unappliedConfigurationKeys,
  type EffectiveConfigEntry,
} from './config-update.js';
import { createRestartExecutor, createRestartResumer } from './restart.js';
import {
  buildInstallParametersFromManifest,
  createStackInstaller,
  describeStoppedTaskEvidence,
  installApplicationStack,
  type InstallCreateMode,
  type InstallOptions,
  type InstallOutcome,
  type StackInstaller,
} from './install.js';
import {
  bindingAliasesFromPayload,
  createBindingAliasApplier,
  manifestBindingAliases,
  type BindingAlias,
  type BindingAliasApplyOutcome,
} from './binding-alias.js';
import {
  createPendingStore,
  memoryPendingStore,
  pendingParameterName,
  reportSettled,
  settledResultOf,
  settleMarker,
  type PendingStore,
} from './pending.js';
import { pollOnce, reportCommandProgress, type PollDependencies } from './poll.js';
import { fetchWithRetry, type SleepFn } from './retry.js';
import {
  createStackEventCollector,
  createStackEventsReader,
  type StackEventCollector,
} from './stack-events.js';
import {
  createRealCacheCleanupClient,
  createRealRdsCleanupClient,
  createRecoveryCloudFormation,
  recoverFailedInstallStack,
  type CacheCleanupClient,
  type RecoveryCloudFormation,
  type RecoveryReport,
  type RdsCleanupClient,
} from './recover.js';
import {
  createCloudFormationReader,
  verifyInstallation,
  type CloudFormationReader,
  type ResourceInventory,
  type VerificationResult,
  type VerifyOptions,
} from './verify.js';
import { buildProvisioningSnapshot, type ProvisioningSnapshot } from './provision-progress.js';
import { withLease } from './lease.js';
import { listAllStackResources } from './stack-resources.js';
import {
  DEFAULT_APPLICATION_STACK_NAME as DEFAULT_STACK_NAME,
  DEFAULT_BOOTSTRAP_STACK_NAME as DEFAULT_BOOTSTRAP_STACK_NAME,
  applicationStackNameForInstallation,
  deploymentManifestSchema,
  type DeploymentManifest,
  type FailureEvidence,
  type InfrastructureRequirements,
} from '@deployz/contracts';

/**
 * This installation's application stack name. Derived from the
 * installation identifier the bootstrap stack minted, so two deployments in
 * the same AWS account/region never collide on `deployz-app` and no
 * control-plane state is needed to agree on the name. Falls back to the
 * fixed default only when the env is absent (unit tests, direct invokes).
 */
export function relayApplicationStackName(): string {
  const installationId = process.env['DEPLOYZ_INSTALLATION_ID'];
  return installationId ? applicationStackNameForInstallation(installationId) : DEFAULT_STACK_NAME;
}

/**
 * The bootstrap stack this relay was deployed by — baked by the stack as
 * Ref AWS::StackName, so it tracks the deployed name even if the customer
 * renames the stack in the console. Purge uses it to remove its own stack.
 */
export function relayBootstrapStackName(): string {
  return process.env['DEPLOYZ_BOOTSTRAP_STACK_NAME'] ?? DEFAULT_BOOTSTRAP_STACK_NAME;
}

// ── Lazy SDK singleton ───────────────────────────────────────────────────────
//
// The CloudFormation reader wraps a real SDK client (full config +
// credential-chain resolution). Following the same lazy-singleton idiom as
// `getAcmSdkClient()` / `getElbSdkClient()` in `./domain.js`, it is
// constructed on first use, not at module load — so importing this module
// never touches AWS, and unit tests that never trigger the INSTALL executor
// or the `observe` hook construct nothing. This matters more here than for
// INSTALL alone: `observe` runs on every poll, once a minute, forever,
// whereas INSTALL runs at most once or twice per container's lifetime.

let cloudFormationReader: CloudFormationReader | undefined;

function getCloudFormationReader(): CloudFormationReader {
  if (!cloudFormationReader) {
    cloudFormationReader = createCloudFormationReader();
  }
  return cloudFormationReader;
}

// Same lazy-singleton idiom for the ECS task reader behind runtime digest
// observation: constructing the client must not happen at module load.
let ecsTaskReader: EcsTaskReader | undefined;

function getEcsTaskReader(): EcsTaskReader {
  if (!ecsTaskReader) {
    const client = new ECSClient({});
    ecsTaskReader = {
      async listTasks(input) {
        const response = await client.send(
          new ListTasksCommand({
            cluster: input.cluster,
            serviceName: input.serviceName,
            nextToken: input.nextToken,
          }),
        );
        return { taskArns: response.taskArns ?? [], nextToken: response.nextToken };
      },
      async describeTasks(input) {
        const response = await client.send(
          new DescribeTasksCommand({ cluster: input.cluster, tasks: input.tasks }),
        );
        return {
          tasks: (response.tasks ?? []).map((task) => ({
            lastStatus: task.lastStatus,
            taskDefinitionArn: task.taskDefinitionArn,
            containers: (task.containers ?? []).map((container) => ({
              name: container.name,
              imageDigest: container.imageDigest,
            })),
          })),
        };
      },
      async describeTaskDefinition(input) {
        const response = await client.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: input.taskDefinition }),
        );
        return {
          taskDefinition: {
            containerDefinitions: (response.taskDefinition?.containerDefinitions ?? []).map(
              (container) => ({ name: container.name, essential: container.essential }),
            ),
          },
        };
      },
    };
  }
  return ecsTaskReader;
}

let stackInstaller: StackInstaller | undefined;

// Lazy CloudFormation deleter for the DESTROY executor — same
// construct-on-first-use rule as everything else AWS-touching here.
let stackDeleter: StackDeleter | undefined;

function createStackDeleter(): StackDeleter {
  const client = new AwsCloudFormationClient({});
  return {
    async deleteStack(stackName, retainResources) {
      await client.send(
        new DeleteStackCommand({
          StackName: stackName,
          ...(retainResources && retainResources.length > 0
            ? { RetainResources: [...retainResources] }
            : {}),
        }),
      );
    },
  };
}

function getStackDeleter(): StackDeleter {
  if (!stackDeleter) {
    stackDeleter = createStackDeleter();
  }
  return stackDeleter;
}

// Purge clients are NOT cached (DZ-AUDIT-009): the optional
// previousInstallationId from the command payload requires fresh clients per
// invocation.  PURGE is not performance-sensitive.
function getPurgeClients(
  installationId: string,
  previousInstallationId?: string,
): {
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  secrets: SecretsPurgeClient;
  acm: AcmPurgeClient;
  network: NetworkPurgeClient;
  taskRevisions: TaskRevisionPurgeClient;
} {
  return createRealPurgeClients(installationId, previousInstallationId);
}

// Lazy readers behind runtime health observation — same construct-on-first-use
// rule as the reader above.
let ecsServiceReader: EcsServiceReader | undefined;
let targetHealthReader: TargetHealthReader | undefined;

function getEcsServiceReader(): EcsServiceReader {
  if (!ecsServiceReader) {
    const client = new ECSClient({});
    ecsServiceReader = {
      async describeServices(input) {
        const response = await client.send(
          new DescribeServicesCommand({ cluster: input.cluster, services: input.services }),
        );
        return {
          services: (response.services ?? []).map((service) => ({
            serviceArn: service.serviceArn ?? undefined,
            desiredCount: service.desiredCount ?? undefined,
            runningCount: service.runningCount ?? undefined,
            deployments: (service.deployments ?? []).map((deployment) => ({
              status: deployment.status ?? undefined,
              rolloutState: deployment.rolloutState ?? undefined,
              taskDefinition: deployment.taskDefinition ?? undefined,
            })),
            loadBalancers: (service.loadBalancers ?? []).map((lb) => ({
              targetGroupArn: lb.targetGroupArn ?? undefined,
            })),
          })),
        };
      },
    };
  }
  return ecsServiceReader;
}

function getTargetHealthReader(): TargetHealthReader {
  if (!targetHealthReader) {
    const client = new ElasticLoadBalancingV2Client({});
    targetHealthReader = {
      async describeTargetHealth(input) {
        const response = await client.send(
          new DescribeTargetHealthCommand({ TargetGroupArn: input.targetGroupArn }),
        );
        return {
          targets: (response.TargetHealthDescriptions ?? []).map((description) => ({
            state: description.TargetHealth?.State ?? undefined,
          })),
        };
      },
    };
  }
  return targetHealthReader;
}

// The ECS write client behind deploy/rollback/restart. Field-by-field
// adaptation between the seam's copy-shape and the SDK's register input —
// AWS owns revision/status/registration fields and rejects them on register.
let ecsDeployClient: EcsDeployClient | undefined;

function getEcsDeployClient(): EcsDeployClient {
  if (!ecsDeployClient) {
    const client = new ECSClient({});
    ecsDeployClient = {
      async describeServices(input) {
        const response = await client.send(
          new DescribeServicesCommand({ cluster: input.cluster, services: input.services }),
        );
        return {
          services: (response.services ?? []).map((service) => ({
            desiredCount: service.desiredCount ?? undefined,
            runningCount: service.runningCount ?? undefined,
            taskDefinition: service.taskDefinition ?? undefined,
            deployments: (service.deployments ?? []).map((deployment) => ({
              id: deployment.id ?? undefined,
              status: deployment.status ?? undefined,
              rolloutState: deployment.rolloutState ?? undefined,
              taskDefinition: deployment.taskDefinition ?? undefined,
            })),
            networkConfiguration: service.networkConfiguration
              ? {
                  awsvpcConfiguration: service.networkConfiguration.awsvpcConfiguration
                    ? {
                        subnets: service.networkConfiguration.awsvpcConfiguration.subnets ?? undefined,
                        securityGroups:
                          service.networkConfiguration.awsvpcConfiguration.securityGroups ?? undefined,
                        assignPublicIp:
                          service.networkConfiguration.awsvpcConfiguration.assignPublicIp ?? undefined,
                      }
                    : undefined,
                }
              : undefined,
          })),
        };
      },
      async describeTaskDefinition(input) {
        const response = await client.send(
          new DescribeTaskDefinitionCommand({ taskDefinition: input.taskDefinition }),
        );
        const taskDefinition = response.taskDefinition;
        return {
          taskDefinition: {
            taskDefinitionArn: taskDefinition?.taskDefinitionArn ?? undefined,
            family: taskDefinition?.family ?? undefined,
            cpu: taskDefinition?.cpu ?? undefined,
            memory: taskDefinition?.memory ?? undefined,
            networkMode: taskDefinition?.networkMode ?? undefined,
            requiresCompatibilities: taskDefinition?.requiresCompatibilities ?? undefined,
            executionRoleArn: taskDefinition?.executionRoleArn ?? undefined,
            taskRoleArn: taskDefinition?.taskRoleArn ?? undefined,
            containerDefinitions: (taskDefinition?.containerDefinitions ?? []).map(
              (container) => ({ ...container }),
            ),
            ...(taskDefinition?.volumes ? { volumes: taskDefinition.volumes } : {}),
          },
        };
      },
      async registerTaskDefinition(input) {
        if (!input.family) throw new Error('Cannot register a task definition without a family');
        // The seam copies fields as plain strings; the SDK narrows them to
        // its enum types. The values came from DescribeTaskDefinition, so
        // they are already valid members — the cast is the seam boundary.
        const response = await client.send(
          new RegisterTaskDefinitionCommand({
            ...input,
            family: input.family,
          } as RegisterTaskDefinitionCommandInput),
        );
        const arn = response.taskDefinition?.taskDefinitionArn;
        if (!arn) throw new Error('RegisterTaskDefinition returned no task definition ARN');
        return { taskDefinitionArn: arn };
      },
      async listTaskDefinitions(input) {
        // Newest first, bounded to a few pages: older revisions are reached
        // on later invocations as newer ones are deregistered.
        const taskDefinitionArns: string[] = [];
        let nextToken: string | undefined;
        for (let page = 0; page < 3; page++) {
          const response = await client.send(
            new ListTaskDefinitionsCommand({
              familyPrefix: input.familyPrefix,
              status: input.status,
              sort: 'DESC',
              ...(nextToken !== undefined ? { nextToken } : {}),
            }),
          );
          taskDefinitionArns.push(...(response.taskDefinitionArns ?? []));
          nextToken = response.nextToken;
          if (nextToken === undefined) break;
        }
        return { taskDefinitionArns };
      },
      async deregisterTaskDefinition(input) {
        await client.send(new DeregisterTaskDefinitionCommand({ taskDefinition: input.taskDefinition }));
      },
      async updateService(input) {
        await client.send(
          new UpdateServiceCommand({
            cluster: input.cluster,
            service: input.service,
            ...(input.taskDefinition !== undefined ? { taskDefinition: input.taskDefinition } : {}),
            ...(input.forceNewDeployment !== undefined
              ? { forceNewDeployment: input.forceNewDeployment }
              : {}),
            ...(input.desiredCount !== undefined ? { desiredCount: input.desiredCount } : {}),
          }),
        );
      },
      async listTasks(input) {
        const response = await client.send(
          new ListTasksCommand({
            cluster: input.cluster,
            serviceName: input.serviceName,
            ...(input.desiredStatus !== undefined ? { desiredStatus: input.desiredStatus } : {}),
          }),
        );
        return { taskArns: response.taskArns ?? [] };
      },
      async describeTasks(input) {
        const response = await client.send(
          new DescribeTasksCommand({ cluster: input.cluster, tasks: input.tasks }),
        );
        return {
          tasks: (response.tasks ?? []).map((task) => ({
            lastStatus: task.lastStatus ?? undefined,
            stopCode: task.stopCode ?? undefined,
            stoppedReason: task.stoppedReason ?? undefined,
            taskDefinitionArn: task.taskDefinitionArn ?? undefined,
            containers: (task.containers ?? []).map((container) => ({
              name: container.name ?? undefined,
              imageDigest: container.imageDigest ?? undefined,
              exitCode: container.exitCode ?? undefined,
            })),
          })),
        };
      },
      async runTask(input) {
        const response = await client.send(
          new RunTaskCommand({
            cluster: input.cluster,
            taskDefinition: input.taskDefinition,
            count: input.count,
            launchType: input.launchType as 'FARGATE',
            networkConfiguration: input.networkConfiguration,
            overrides: input.overrides,
          } as RunTaskCommandInput),
        );
        return {
          taskArns: (response.tasks ?? [])
            .map((task) => task.taskArn)
            .filter((arn): arn is string => typeof arn === 'string'),
        };
      },
    };
  }
  return ecsDeployClient;
}

// Phase 5: stops a RUNNING standalone task (a scheduled job or migration
// mid-run) in the stack's own cluster before DESTROY deletes it — see
// EcsStandaloneTaskStopper in ./destroy.ts.
let ecsStandaloneTaskStopper: EcsStandaloneTaskStopper | undefined;

function getEcsStandaloneTaskStopper(): EcsStandaloneTaskStopper {
  if (!ecsStandaloneTaskStopper) {
    const client = new ECSClient({});
    ecsStandaloneTaskStopper = {
      async listTasks(input) {
        const response = await client.send(new ListTasksCommand({ cluster: input.cluster }));
        return { taskArns: response.taskArns ?? [] };
      },
      async describeTasks(input) {
        const response = await client.send(
          new DescribeTasksCommand({ cluster: input.cluster, tasks: input.tasks }),
        );
        return {
          tasks: (response.tasks ?? []).map((task) => ({
            taskArn: task.taskArn ?? undefined,
            group: task.group ?? undefined,
          })),
        };
      },
      async stopTask(input) {
        await client.send(
          new StopTaskCommand({
            cluster: input.cluster,
            task: input.task,
            reason: 'Deployz DESTROY: clearing a standalone task before deleting the cluster',
          }),
        );
      },
    };
  }
  return ecsStandaloneTaskStopper;
}

function getStackInstaller(): StackInstaller {
  if (!stackInstaller) {
    stackInstaller = createStackInstaller();
  }
  return stackInstaller;
}

let pendingStore: PendingStore | undefined;

/**
 * The pending-command store, keyed by the installation.
 *
 * Falls back to an in-memory store when there is no installation id: that
 * only happens in a misconfigured relay, which `relayHandler` refuses to
 * poll anyway, and a process-local store is a safer thing to hand back than
 * a parameter name built from an empty string.
 */
function getPendingStore(installationId: string): PendingStore {
  if (!pendingStore) {
    pendingStore = installationId
      ? createPendingStore(pendingParameterName(installationId))
      : memoryPendingStore();
  }
  return pendingStore;
}

// Recovery clients follow the same lazy idiom: constructed on the first
// retried INSTALL, never at module load.
let recoveryCloudFormation: RecoveryCloudFormation | undefined;
let rdsCleanupClient: RdsCleanupClient | undefined;
let cacheCleanupClient: CacheCleanupClient | undefined;

function getRecoveryCloudFormation(): RecoveryCloudFormation {
  if (!recoveryCloudFormation) {
    recoveryCloudFormation = createRecoveryCloudFormation();
  }
  return recoveryCloudFormation;
}

function getRdsCleanupClient(): RdsCleanupClient {
  if (!rdsCleanupClient) {
    rdsCleanupClient = createRealRdsCleanupClient();
  }
  return rdsCleanupClient;
}

function getCacheCleanupClient(): CacheCleanupClient {
  if (!cacheCleanupClient) {
    cacheCleanupClient = createRealCacheCleanupClient();
  }
  return cacheCleanupClient;
}

// ── Default command executors ────────────────────────────────────────────────

function logCommandExecuted(command: RelayCommand): void {
  console.log(
    JSON.stringify({
      event: 'relay:command-executed',
      commandId: command.id,
      type: command.type,
      deploymentId: command.deploymentId,
      idempotencyKey: command.idempotencyKey,
    }),
  );
}

/**
 * A verifying executor: run the command's underlying step (still a stub for
 * INSTALL, DEPLOY_RELEASE and ROLLBACK today), then prove the account backs
 * it up before reporting success. Shared across all three command types
 * rather than duplicated, so the gate cannot drift between them.
 *
 * What this proves, precisely: the application stack exists and its
 * expected resources (ECS service, load balancer, database, storage, and —
 * when required — cache) are present in a complete state. What it does NOT
 * prove: which release is running. That needs the running task's image
 * digest, which this branch does not fetch. A verified DEPLOY_RELEASE or
 * ROLLBACK means the stack is intact — it does not mean the new (or prior)
 * release is the one actually serving traffic. This is a floor under the
 * false-Healthy hole, not a full release-correctness check.
 *
 * A throw from verification is a failure, not a pass: a command we cannot
 * confirm is indistinguishable from one that did not happen.
 */
export function createVerifyingExecutor(
  verify: (installationId: string, command: RelayCommand) => Promise<VerificationResult>,
): CommandExecutor {
  return async (command) => {
    logCommandExecuted(command);

    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';

    let result: VerificationResult;
    try {
      result = await verify(installationId, command);
    } catch (err) {
      result = {
        verified: false,
        checks: [],
        reason: `Verification could not run: ${String(err)}`,
      };
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-verified',
        commandId: command.id,
        type: command.type,
        installationId,
        verified: result.verified,
        ...(result.reason ? { reason: result.reason } : {}),
      }),
    );

    if (!result.verified) {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: result.reason ?? 'Installation could not be verified',
        failureCode: 'STACK_CREATE_FAILED',
        output: { checks: result.checks },
      };
    }

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { executed: true, type: command.type, checks: result.checks },
    };
  };
}

// ── The INSTALL executor ─────────────────────────────────────────────────────

/**
 * Everything the INSTALL executor and its resumer need, as injectable
 * seams. `install` and `verify` are functions rather than clients so the
 * whole provision-then-prove sequence tests without AWS, and so the two
 * entry points below cannot drift apart — both close over the same pair.
 */
export interface InstallExecutorDeps {
  readonly installationId: string;
  readonly install: (options: InstallRequest) => Promise<InstallOutcome>;
  readonly verify: (options: VerifyRequest) => Promise<VerificationResult>;
  readonly pending: PendingStore;
  /**
   * EC2 client for AZ discovery. When provided, the relay discovers the
   * available AZs before creating the stack and fills the template's
   * `paramDbAz1` … `paramDbAzN` parameters. When absent (older wiring, or a
   * test that doesn't care about AZ placement), the install proceeds without
   * AZ parameters — the template's defaults (empty strings) keep the DB-only
   * subnets out of the subnet group.
   */
  readonly ec2?: Pick<EC2Client, 'send'>;
  /**
   * First-install recovery. Runs before `install`, and only when the command
   * payload carries `recovery.neverInstalled` — the control plane sets that
   * on its retry-install route, after proving no INSTALL ever succeeded.
   */
  readonly recover?: (stackName: string) => Promise<RecoveryReport>;
  /**
   * Validates that a command still has authority to provision before the
   * relay resumes it. `true` = active, `false` = superseded (never
   * provision), `null` = ambiguous/unavailable (defer, retry next poll).
   * Optional so pre-existing wiring and test doubles keep compiling.
   */
  readonly checkAuthority?: (commandId: string) => Promise<boolean | null>;
  /** CloudFormation execution role ARN (`role/deployz/*`), when configured. */
  readonly executionRoleArn?: string;
  /** Permissions boundary the execution role requires on every application role, when configured. */
  readonly roleBoundaryArn?: string;
  /**
   * Stage B phase 2 — post-install binding-alias registration. When provided,
   * a successfully verified install registers one extra task-definition
   * revision carrying the manifest's alias bindings (MEMOS_DSN,
   * PAPERLESS_DBHOST…, S3_ATTACHMENTS_BUCKET) before success is reported. A
   * failed registration fails the install honestly. Optional so pre-existing
   * test doubles and legacy wiring keep compiling unchanged.
   */
  readonly applyBindingAliases?: (options: {
    stackName: string;
    aliases: readonly BindingAlias[];
  }) => Promise<BindingAliasApplyOutcome>;
  /** Clock for the pending marker's `startedAt`. */
  readonly now?: () => string;
  /**
   * The parameter names the application template at `templateUrl` declares,
   * or null when they cannot be read. The control plane resolves install
   * parameters without knowing which template variant the relay will use
   * (the Documenso-preset secrets ride along on every install), and
   * CloudFormation refuses a CreateStack that names a parameter the template
   * does not declare — so undeclared parameters are dropped before the call.
   * Null keeps the historical pass-through: an unreadable template must not
   * turn a working install into a failed one.
   */
  readonly readTemplateParameters?: (templateUrl: string) => Promise<ReadonlySet<string> | null>;
  /**
   * Builds a stack-event collector for one INSTALL attempt. Optional: when
   * absent (older wiring, or a test that doesn't care about progress
   * reporting), the executor and resumer behave exactly as they did before
   * this existed — no collector, no `onPoll`, no cursor.
   */
  readonly createStackEventCollector?: (args: {
    commandId: string;
    operationStartedAt: string;
    stackName: string;
    resumeAfter?: string;
  }) => StackEventCollector;
  /**
   * Phase 1 stopped-task evidence for an install that reached a complete
   * stack but failed runtime verification — the one failure class where
   * the service and its stopped tasks still exist (the stack-level
   * failure branch's collector often runs after CloudFormation already
   * deleted the service). Guarded: a rejection here can never change the
   * install outcome.
   */
  readonly stoppedTaskEvidence?: (stackName: string) => Promise<FailureEvidence | null>;
}

/**
 * The relay only knows the control-plane URL, not the template bucket, so it
 * accepts any https S3 bucket host. Pinning the exact bucket is a post-MVP
 * item.
 */
function isTemplateBucketUrl(templateUrl: string): boolean {
  try {
    const url = new URL(templateUrl);
    return url.protocol === 'https:' && /^[a-z0-9][a-z0-9.-]*\.s3(\.[a-z0-9-]+)?\.amazonaws\.com$/.test(url.hostname);
  } catch {
    return false;
  }
}

/** What `install` is asked for — `InstallOptions` minus the client seam. */
export type InstallRequest = Omit<InstallOptions, 'installer'>;

/** What `verify` is asked for — `VerifyOptions` minus the client seam. */
export type VerifyRequest = Omit<VerifyOptions, 'cfn'>;

/**
 * Run an install to whatever conclusion is available right now.
 *
 * Two questions, asked in order and never merged: CloudFormation is asked
 * to build the stack and say how that went, and then — only if it says it
 * worked — `verifyInstallation` independently confirms the resources are
 * actually there. A `CREATE_COMPLETE` that fails verification is a failure:
 * the whole point of the second question is that the first one's answer is
 * not evidence on its own.
 *
 * A stack still in progress produces neither answer. That is reported as
 * `deferred` rather than guessed at.
 */
async function settleInstall(
  deps: InstallExecutorDeps,
  request: {
    stackName: string;
    payload: Record<string, unknown>;
    commandId: string;
    createMode: InstallCreateMode;
  },
  collector?: StackEventCollector,
): Promise<
  | { readonly deferred: true; readonly status: string }
  | {
      readonly deferred: false;
      readonly success: boolean;
      readonly error?: string;
      /** Phase 1 structured evidence for a failure, when any was observed. */
      readonly evidence?: FailureEvidence;
      readonly output: Record<string, unknown>;
    }
> {
  const manifest = readDeploymentManifest(request.payload);

  // Manifest present but invalid — fail fast before provisioning.
  if (request.payload['manifest'] !== undefined && manifest === null) {
    return {
      deferred: false,
      success: false,
      error: 'Invalid deployment manifest — infrastructure requirements cannot be parsed',
      output: {},
    };
  }

  const verifyOptions = readVerifyOptionsFromPayload(request.payload);

  // Phase 2: infrastructure requirements are REQUIRED, never guessed — but
  // "known" covers two shapes. A fresh INSTALL carries the full manifest, so
  // the profile comes from it directly. A RESUMED install's compacted
  // pending marker (`compactPendingInstallPayload` below) deliberately
  // drops the manifest to fit SSM's size limit, keeping only the
  // `redisRequired`/`databaseRequired` flags it derived from that same
  // manifest at compaction time — those still count as known. Only when
  // NEITHER is available (no manifest was ever attached) does this refuse.
  const profile: InfrastructureRequirements | null =
    manifest !== null
      ? { postgres: manifest.database.postgres, redis: manifest.redis.required }
      : verifyOptions.databaseRequired !== undefined && verifyOptions.redisRequired !== undefined
        ? { postgres: verifyOptions.databaseRequired, redis: verifyOptions.redisRequired }
        : null;

  if (profile === null) {
    return {
      deferred: false,
      success: false,
      error: 'Deployment manifest missing — infrastructure requirements are unknown, refusing to provision',
      output: {},
    };
  }

  // The control plane compiles the application template (compiler-v2) and
  // sends the frozen artifact's URL in the payload. The relay executes
  // exactly that artifact — no profile-based variant resolution, no env
  // fallback — so a payload without one cannot provision.
  const templateUrl = request.payload['templateUrl'];
  if (typeof templateUrl !== 'string' || templateUrl.length === 0) {
    return {
      deferred: false,
      success: false,
      error:
        'Install payload is missing templateUrl — the control plane did not send the ' +
        'compiled application template, refusing to provision',
      output: {},
    };
  }
  if (!isTemplateBucketUrl(templateUrl)) {
    return {
      deferred: false,
      success: false,
      error: 'Install templateUrl is not an https S3 URL — refusing to provision',
      output: {},
    };
  }

  // Manifest-derived template parameters win over whatever the control
  // plane resolved ad-hoc (health path / port columns); the control plane's
  // secret parameters (paramAppApiKey, Documenso secrets) still flow through
  // unchanged underneath them.
  const parameters = {
    ...readInstallParametersFromPayload(request.payload),
    ...(manifest ? buildInstallParametersFromManifest(manifest) : {}),
  };

  // AZ discovery — fill the template's paramDbAz1 … paramDbAzN parameters
  // with the available AZs in the region. The compiler emits DB-only subnets
  // for slots 3..N, so the database subnet group covers all available AZs.
  // Fail closed: a discovery failure or too many AZs refuses the install
  // rather than silently truncating the subnet group.
  if (deps.ec2) {
    const zones = await discoverAvailabilityZones(deps.ec2);
    if (zones === null) {
      return {
        deferred: false,
        success: false,
        error:
          'AZ discovery failed — the relay could not determine the available ' +
          'availability zones in this region, refusing to provision',
        output: {},
      };
    }
    const azParams = buildDbAzParameters(zones);
    if (azParams === null) {
      return {
        deferred: false,
        success: false,
        error:
          `AZ discovery found ${zones.length} available zones, but the compiler ` +
          `supports at most ${DB_AZ_SLOT_COUNT} — refusing to provision rather than ` +
          'silently truncating the database subnet group',
        output: {},
      };
    }
    Object.assign(parameters, azParams);
  }

  if (deps.roleBoundaryArn !== undefined) {
    Object.assign(parameters, { [ROLE_BOUNDARY_PARAMETER]: deps.roleBoundaryArn });
  }

  const declared = deps.readTemplateParameters ? await deps.readTemplateParameters(templateUrl) : null;
  if (declared !== null) {
    // This connector's execution role refuses an IAM role without the
    // boundary, so a template compiled before the boundary existed would
    // only fail mid-create and roll back. Refuse it before CreateStack.
    if (deps.roleBoundaryArn !== undefined && !declared.has(ROLE_BOUNDARY_PARAMETER)) {
      return {
        deferred: false,
        success: false,
        error:
          'The application template predates the IAM role boundary this connector ' +
          'requires, so CloudFormation would refuse its roles — refusing to provision',
        output: {},
      };
    }
    const dropped = Object.keys(parameters).filter((name) => !declared.has(name));
    for (const name of dropped) delete parameters[name];
    if (dropped.length > 0) {
      // Names only — the values are secrets.
      console.log(JSON.stringify({ event: 'relay:install-parameters-dropped', templateUrl, dropped }));
    }
  }

  const deploymentTags = readDeploymentTagsFromPayload(request.payload);

  // First-install recovery re-provisions a stack whose data is doomed. Only
  // a recovery create may do that, and only when the control plane confirms
  // the command still has authority; a non-recovery create never carries
  // either field.
  const authorizeRecoveryCreate =
    request.createMode === 'recovery' && deps.checkAuthority
      ? async () => (await deps.checkAuthority!(request.commandId)) === true
      : undefined;

  const outcome = await deps.install({
    installationId: deps.installationId,
    templateUrl,
    stackName: request.stackName,
    parameters,
    ...(deploymentTags ? { deploymentTags } : {}),
    ...(deps.executionRoleArn !== undefined ? { executionRoleArn: deps.executionRoleArn } : {}),
    createMode: request.createMode,
    ...(authorizeRecoveryCreate ? { authorizeRecoveryCreate } : {}),
    ...(collector ? { onPoll: (stackName: string) => collector.poll(stackName) } : {}),
  });

  if (outcome.state === 'in-progress') {
    return { deferred: true, status: outcome.status };
  }

  if (outcome.state === 'failed') {
    // No verification here. The stack CloudFormation just rolled back is
    // not a stack to check for an ECS service, and a second failing answer
    // would only bury the first one's reason — which is the one that says
    // what actually went wrong.
    return {
      deferred: false,
      success: false,
      error: outcome.reason,
      ...(outcome.evidence ? { evidence: outcome.evidence } : {}),
      output: { stackStatus: outcome.status ?? null, outputs: outcome.outputs },
    };
  }

  let verification: VerificationResult;
  try {
    verification = await deps.verify({
      installationId: deps.installationId,
      ...verifyOptions,
      stackName: verifyOptions.stackName ?? request.stackName,
      // Guaranteed booleans: `verifyOptions` already carries these (derived
      // from this same manifest), but the profile is the type-safe fallback
      // so verification never disagrees with the template just resolved.
      redisRequired: verifyOptions.redisRequired ?? profile.redis,
      databaseRequired: verifyOptions.databaseRequired ?? profile.postgres,
    });
  } catch (err) {
    verification = {
      verified: false,
      checks: [],
      reason: `Verification could not run: ${String(err)}`,
    };
  }

  if (verification.verified) {
    // Stage B phase 2: a fresh dynamic install must carry the manifest's
    // binding aliases, which the pre-published template cannot know about.
    // The full manifest rides the creating payload; a resumed install's
    // compacted marker carries the alias list instead.
    const aliases = manifest
      ? manifestBindingAliases(manifest)
      : bindingAliasesFromPayload(request.payload);
    if (aliases.length > 0 && deps.applyBindingAliases) {
      const applied = await deps.applyBindingAliases({
        stackName: request.stackName,
        aliases,
      });
      if (applied.state === 'failed') {
        return {
          deferred: false,
          success: false,
          error:
            applied.reason ?? 'Installed, but the binding aliases could not be registered',
          output: { stackStatus: outcome.status, outputs: outcome.outputs },
        };
      }
    }
  }

  // Phase 1: a complete stack that failed verification still has its
  // service and its stopped tasks, so the container's own verdict is
  // collectable here. Best-effort — a throwing collector is the same as
  // one that found nothing, and never blocks settlement.
  let evidence: FailureEvidence | null = null;
  if (!verification.verified && deps.stoppedTaskEvidence) {
    try {
      evidence = await deps.stoppedTaskEvidence(request.stackName);
    } catch {
      evidence = null;
    }
  }

  return {
    deferred: false,
    success: verification.verified,
    ...(verification.verified
      ? {}
      : { error: verification.reason ?? 'Installation could not be verified' }),
    ...(evidence !== null ? { evidence } : {}),
    output: {
      stackStatus: outcome.status,
      outputs: outcome.outputs,
      checks: verification.checks,
    },
  };
}

/** The compiler's parameter that carries the application role boundary ARN. */
const ROLE_BOUNDARY_PARAMETER = 'paramRoleBoundaryArn';

// ── AZ discovery ─────────────────────────────────────────────────────────────

/** The maximum number of AZ slots the compiler emits. */
const DB_AZ_SLOT_COUNT = 8;

/**
 * Discover the available, enabled standard AZs in the region.
 *
 * The relay calls DescribeAvailabilityZones before creating the stack and
 * fills the template's `paramDbAz1` … `paramDbAzN` parameters with the
 * discovered zones. The compiler emits DB-only subnets for slots 3..N, so
 * the database subnet group covers all available AZs — not just the two
 * where the private subnets happen to sit.
 *
 * Excludes unavailable/disabled, Local, and Wavelength Zones. Requires at
 * least two distinct zones. Returns null on any failure (the caller then
 * fails the install honestly rather than guessing).
 */
export async function discoverAvailabilityZones(
  ec2: Pick<EC2Client, 'send'>,
): Promise<readonly string[] | null> {
  try {
    const response = (await ec2.send(
      new DescribeAvailabilityZonesCommand({
        Filters: [{ Name: 'state', Values: ['available'] }],
      }),
    )) as {
      AvailabilityZones?: {
        ZoneName?: string;
        State?: string;
        ZoneType?: string;
      }[];
    };

    const zones = (response.AvailabilityZones ?? [])
      .filter((zone) => {
        if (zone.State !== 'available') return false;
        if (zone.ZoneType === 'local') return false;
        if (zone.ZoneType === 'wavelength') return false;
        return true;
      })
      .map((zone) => zone.ZoneName ?? '')
      .filter((name) => name.length > 0)
      .sort();

    if (zones.length < 2) return null;
    return zones;
  } catch {
    return null;
  }
}

/**
 * Fill the AZ parameters for the database subnet group.
 *
 * The compiler emits `paramDbAz1` … `paramDbAzN` parameters. The relay fills
 * them with the discovered AZs. Slots 1-2 are the private subnets (already
 * placed by the compiler via Fn::GetAZs); slots 3-N are DB-only subnets.
 *
 * Returns the parameter values to merge into the install parameters, or null
 * when AZ discovery failed or the region has more AZs than the compiler
 * supports.
 */
export function buildDbAzParameters(
  zones: readonly string[],
): Record<string, string> | null {
  if (zones.length < 2 || zones.length > DB_AZ_SLOT_COUNT) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (zone === undefined) return null;
    params[`paramDbAz${i + 1}`] = zone;
  }
  return params;
}

/**
 * Whether a command's payload carries the control plane's `recovery.
 * neverInstalled: true` flag — set on its retry-install route only after it
 * has proved no INSTALL for this stack ever succeeded.
 *
 * The payload flag is control-plane-shaped (`Record<string, unknown>`), so
 * it is checked defensively — anything other than an explicit `true` means
 * no recovery.
 */
function isRecoveryRequested(payload: Record<string, unknown>): boolean {
  const recovery = payload['recovery'] as { neverInstalled?: unknown } | undefined;
  return recovery?.neverInstalled === true;
}

/**
 * Run the requested first-install recovery, if the command asked for one.
 *
 * A command with no `recover` seam (e.g. a test double) skips it rather
 * than crashing.
 *
 * A refusal phase (live or in-progress stack) is not an error: recovery
 * falls through and `settleInstall` reports the stack's real state honestly.
 */
async function runRequestedRecovery(
  deps: InstallExecutorDeps,
  command: RelayCommand,
  stackName: string,
): Promise<RecoveryReport | undefined> {
  if (!isRecoveryRequested(command.payload) || !deps.recover) {
    return undefined;
  }

  const report = await deps.recover(stackName);
  console.log(
    JSON.stringify({
      event: 'relay:install-recovery',
      commandId: command.id,
      installationId: deps.installationId,
      phase: report.phase,
      lastStackStatus: report.lastStackStatus,
      orphansDeleted: report.orphansDeleted,
    }),
  );
  return report;
}

/**
 * Recovery phases that mean the stack is on its way to being gone — no
 * further action is needed here; the next poll's `settleInstall` will find
 * it absent (or still deleting) and either create it fresh or defer again.
 */
const RECOVERY_STILL_IN_PROGRESS: ReadonlySet<RecoveryReport['phase']> = new Set([
  'STACK_DELETED',
  'BLOCKERS_CLEARED_STACK_GONE',
  'DELETE_IN_PROGRESS',
  'ALREADY_ABSENT',
]);

/**
 * The INSTALL executor: provision the application stack, then prove it.
 *
 * Unlike `createVerifyingExecutor`, which only ever looked, this one
 * actually creates the stack. It keeps the same gate on the way out — a
 * success is reported only when `verifyInstallation` independently agrees —
 * so implementing INSTALL does not reopen the hole that gate was added to
 * close.
 */
export function createInstallExecutor(deps: InstallExecutorDeps): CommandExecutor {
  return async (command) => {
    logCommandExecuted(command);

    // A settled marker for this same command already holds the terminal
    // answer. Re-reporting it must not provision anything again.
    const current = await deps.pending.inspect();
    // An unreadable marker hides whether this install already ran: provision
    // nothing and let the control plane offer it again.
    if (current.state === 'unreadable') {
      return { commandId: command.id, idempotencyKey: command.idempotencyKey, success: false, deferred: true };
    }
    const stored =
      current.state === 'present' && current.marker.commandId === command.id
        ? settledResultOf(current.marker)
        : null;
    if (stored !== null) return stored;

    // The control plane is the authority on whether this command may still
    // provision. A `false` is final; a `null` is unknown, so the work is
    // deferred rather than guessed at.
    const authority = deps.checkAuthority ? await deps.checkAuthority(command.id) : undefined;
    if (authority === false) {
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        error: 'Install command is no longer active — not provisioning',
        failureCode: 'STACK_CREATE_FAILED',
      };
    }

    const payloadStackName = readVerifyOptionsFromPayload(command.payload).stackName;
    if (payloadStackName !== undefined && payloadStackName !== relayApplicationStackName()) {
      return failure(command, 'Install payload names a stack that is not this installation\'s stack — not provisioning');
    }
    const stackName = relayApplicationStackName();
    const startedAt = (deps.now ?? (() => new Date().toISOString()))();

    if (authority === null) {
      // Authority is unknown, not denied. Record what we owe an answer to so
      // the next poll retries; provision nothing now.
      const recorded = await deps.pending.write({
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        type: command.type,
        stackName,
        startedAt,
        payload: compactPendingInstallPayload(command.payload),
      });
      if (!recorded) {
        return failure(
          command,
          `Install authority for "${stackName}" could not be confirmed, but the relay could not record ` +
            'that it must report back — failing now rather than leaving the install unaccounted for',
        );
      }
      console.log(
        JSON.stringify({
          event: 'relay:command-deferred',
          commandId: command.id,
          type: command.type,
          stackName,
          status: 'AUTHORITY_UNKNOWN',
        }),
      );
      return {
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: false,
        deferred: true,
      };
    }

    const collector = deps.createStackEventCollector?.({
      commandId: command.id,
      operationStartedAt: startedAt,
      stackName,
    });
    const createMode: InstallCreateMode = isRecoveryRequested(command.payload) ? 'recovery' : 'fresh';
    const recoveryReport = await runRequestedRecovery(deps, command, stackName);
    const settled = await settleInstall(
      deps,
      { stackName, payload: command.payload, commandId: command.id, createMode },
      collector,
    );

    if (!settled.deferred) {
      logInstall(command, stackName, settled.success, settled.error);
      const output = {
        ...settled.output,
        ...(recoveryReport ? { recovery: recoveryReport } : {}),
      };
      const result: RelayCommandResult = settled.success
        ? {
            commandId: command.id,
            idempotencyKey: command.idempotencyKey,
            success: true,
            output: { executed: true, type: command.type, ...output },
          }
        : {
            commandId: command.id,
            idempotencyKey: command.idempotencyKey,
            success: false,
            error: settled.error ?? 'Installation could not be verified',
            failureCode: 'STACK_CREATE_FAILED',
            ...(settled.evidence ? { evidence: settled.evidence } : {}),
            output,
          };
      // Settle before reporting: a lost report is repeated from the marker.
      return reportSettled(
        deps.pending,
        { commandId: command.id, idempotencyKey: command.idempotencyKey, type: command.type, stackName, startedAt },
        result,
      );
    }

    // The stack outlived this invocation. Record what we owe an answer to
    // BEFORE deferring — a deferral the next poll cannot find is a job that
    // sits in RUNNING forever, which is worse than an honest failure.
    const lastEventAt = collector?.lastEventAt() ?? null;
    const recorded = await deps.pending.write({
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      type: command.type,
      stackName,
      startedAt,
      payload: compactPendingInstallPayload(command.payload),
      ...(lastEventAt !== null ? { stackEventsCursor: { lastEventAt } } : {}),
    });

    if (!recorded) {
      return failure(
        command,
        `Stack "${stackName}" is still ${settled.status}, but the relay could not record that it ` +
          'must report back — failing now rather than leaving the install unaccounted for',
      );
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-deferred',
        commandId: command.id,
        type: command.type,
        stackName,
        status: settled.status,
      }),
    );

    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: false,
      deferred: true,
    };
  };
}

/**
 * The other half of `createInstallExecutor`: finish an install that an
 * earlier invocation started and report it against its original command id.
 *
 * Wired into the poll loop's `resume` hook, so it runs once per one-minute
 * tick until the stack settles.
 */
export function createInstallResumer(
  deps: InstallExecutorDeps,
): () => Promise<RelayCommandResult[]> {
  return async () => {
    const current = await deps.pending.inspect();
    if (current.state !== 'present') return [];
    const pending = current.marker;
    // The pending store holds ONE command of any type; each resumer only
    // settles its own, so a deferred deploy is never answered as an install.
    if (pending.type !== 'INSTALL') return [];

    // A settled marker already holds the answer. Retry reporting it — never
    // provision again — until a report is accepted.
    const stored = settledResultOf(pending);
    if (stored !== null) return [stored];

    // Authority first: a superseded command must not recreate infrastructure
    // during (or after) a teardown. A `null` keeps the marker for the next
    // poll; a `false` clears it, but only while it is still this command's.
    const authority = deps.checkAuthority ? await deps.checkAuthority(pending.commandId) : undefined;
    if (authority === false) {
      await deps.pending.compareAndSet(pending.commandId, null);
      console.log(
        JSON.stringify({
          event: 'relay:install-superseded',
          commandId: pending.commandId,
          stackName: pending.stackName,
        }),
      );
      return [];
    }
    if (authority === null) {
      console.log(
        JSON.stringify({
          event: 'relay:install-authority-unknown',
          commandId: pending.commandId,
          stackName: pending.stackName,
        }),
      );
      return [];
    }

    const resumeAfter = pending.stackEventsCursor?.lastEventAt;
    const collector = deps.createStackEventCollector?.({
      commandId: pending.commandId,
      operationStartedAt: pending.startedAt,
      stackName: pending.stackName,
      ...(resumeAfter !== undefined ? { resumeAfter } : {}),
    });

    const createMode: InstallCreateMode = isRecoveryRequested(pending.payload) ? 'recovery' : 'resume';
    const settled = await settleInstall(
      deps,
      {
        stackName: pending.stackName,
        payload: pending.payload,
        commandId: pending.commandId,
        createMode,
      },
      collector,
    );

    if (settled.deferred) {
      // Re-defer: carry forward whatever new events this attempt collected
      // so the next resume does not re-walk history it already reported.
      // Compare-and-set: a newer command's marker is never overwritten.
      const lastEventAt = collector?.lastEventAt() ?? null;
      if (lastEventAt !== null) {
        await deps.pending.compareAndSet(pending.commandId, {
          ...pending,
          stackEventsCursor: { lastEventAt },
        });
      }
      console.log(
        JSON.stringify({
          event: 'relay:command-still-pending',
          commandId: pending.commandId,
          stackName: pending.stackName,
          status: settled.status,
          startedAt: pending.startedAt,
        }),
      );
      return [];
    }

    // A first-install recovery arc landing on DELETE_FAILED is not the
    // final answer — it means the delete this arc is driving got stuck on
    // an orphan (the RDS instance's ENI, most likely). Re-run recovery
    // instead of reporting failure: `neverInstalled` already proved this
    // stack's data is doomed, so there is always forward progress to make.
    if (
      !settled.success &&
      settled.output['stackStatus'] === 'DELETE_FAILED' &&
      isRecoveryRequested(pending.payload) &&
      deps.recover
    ) {
      const report = await deps.recover(pending.stackName);
      console.log(
        JSON.stringify({
          event: 'relay:install-recovery',
          commandId: pending.commandId,
          installationId: deps.installationId,
          resumed: true,
          phase: report.phase,
          lastStackStatus: report.lastStackStatus,
          orphansDeleted: report.orphansDeleted,
        }),
      );

      if (RECOVERY_STILL_IN_PROGRESS.has(report.phase)) {
        // Keep the pending record — the next poll's settleInstall will find
        // the stack gone (or still going) and either create it fresh or
        // defer again. Nothing to report to the control plane yet.
        const lastEventAt = collector?.lastEventAt() ?? null;
        if (lastEventAt !== null) {
          await deps.pending.compareAndSet(pending.commandId, {
            ...pending,
            stackEventsCursor: { lastEventAt },
          });
        }
        return [];
      }

      // DELETE_STUCK: recovery cannot make more progress on its own. Persist
      // the terminal failure in the marker (compare-and-set, so a newer
      // command is never overwritten) and report it.
      const stuck: RelayCommandResult = {
        commandId: pending.commandId,
        idempotencyKey: pending.idempotencyKey,
        success: false,
        error:
          `Stack "${pending.stackName}" is still ${report.lastStackStatus} after first-install ` +
          `recovery cleared ${report.orphansDeleted.length} orphan(s) — recovery could not ` +
          'unblock the delete',
        failureCode: 'STACK_CREATE_FAILED',
        output: settled.output,
      };
      await settleMarker(deps.pending, pending, stuck, false);
      console.log(
        JSON.stringify({
          event: 'relay:command-resumed',
          commandId: pending.commandId,
          stackName: pending.stackName,
          success: false,
          startedAt: pending.startedAt,
          reason: `recovery stuck: ${report.phase}`,
        }),
      );
      return [stuck];
    }

    // Persist the terminal answer BEFORE reporting: if the report fails, the
    // marker still holds it, so the next poll retries without provisioning.
    const result: RelayCommandResult = settled.success
      ? {
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          success: true,
          output: { executed: true, type: pending.type, ...settled.output },
        }
      : {
          commandId: pending.commandId,
          idempotencyKey: pending.idempotencyKey,
          success: false,
          error: settled.error ?? 'Installation could not be verified',
          failureCode: 'STACK_CREATE_FAILED',
          ...(settled.evidence ? { evidence: settled.evidence } : {}),
          output: settled.output,
        };
    const written = await settleMarker(deps.pending, pending, result, false);
    if (!written) {
      // A newer command owns the marker now — never overwrite it, and do not
      // report this obsolete result.
      console.log(
        JSON.stringify({
          event: 'relay:install-marker-superseded',
          commandId: pending.commandId,
          stackName: pending.stackName,
        }),
      );
      return [];
    }

    console.log(
      JSON.stringify({
        event: 'relay:command-resumed',
        commandId: pending.commandId,
        stackName: pending.stackName,
        success: settled.success,
        startedAt: pending.startedAt,
        ...(settled.error ? { reason: settled.error } : {}),
      }),
    );

    return [result];
  };
}

function failure(command: RelayCommand, error: string): RelayCommandResult {
  return {
    commandId: command.id,
    idempotencyKey: command.idempotencyKey,
    success: false,
    error,
    failureCode: 'STACK_CREATE_FAILED',
  };
}

function logInstall(
  command: RelayCommand,
  stackName: string,
  success: boolean,
  error: string | undefined,
): void {
  console.log(
    JSON.stringify({
      event: 'relay:command-verified',
      commandId: command.id,
      type: command.type,
      stackName,
      verified: success,
      ...(error ? { reason: error } : {}),
    }),
  );
}

/**
 * Extract CloudFormation template parameter values from a command's payload.
 *
 * The application template's vendor secrets (`paramAppApiKey`,
 * `paramAppSigningSecret`) are `NoEcho` parameters, so their values can only
 * come from the caller. `payload` is shaped by the control plane, not by
 * this module, so every value is checked to be a string before it is sent:
 * CloudFormation parameter values are always strings, and a number or an
 * object reaching `CreateStack` surfaces as an opaque `ValidationError`
 * partway through an install rather than as the control-plane bug it is.
 */
export function readInstallParametersFromPayload(
  payload: Record<string, unknown>,
): Record<string, string> {
  const parameters = payload['parameters'];
  if (typeof parameters !== 'object' || parameters === null || Array.isArray(parameters)) {
    return {};
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

/**
 * Extract the control-plane-minted deployz identity tags from a command's
 * payload. Same defensive-validation rule as `readInstallParametersFromPayload`:
 * `payload` is shaped by the control plane, not by this module, so only a
 * plain object with non-empty string keys and values is accepted. Undefined
 * when the payload carries no usable tags — installs from an older control
 * plane deploy without them rather than fail.
 */
export function readDeploymentTagsFromPayload(
  payload: Record<string, unknown>,
): Record<string, string> | undefined {
  const tags = payload['tags'];
  if (typeof tags !== 'object' || tags === null || Array.isArray(tags)) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(tags as Record<string, unknown>)) {
    if (key.length > 0 && typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The parameter names the published application template declares, read
 * from the same public URL CloudFormation fetches it from. Null on any
 * failure (unreachable, non-JSON, no `Parameters` object) so the caller
 * keeps the historical pass-through instead of guessing.
 */
export async function readTemplateParameterNames(
  fetchFn: FetchFn,
  templateUrl: string,
): Promise<ReadonlySet<string> | null> {
  try {
    const response = await fetchFn(templateUrl);
    if (response.status !== 200) return null;
    const body = (await response.json()) as { Parameters?: unknown } | null;
    const declared = body?.Parameters;
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) return null;
    return new Set(Object.keys(declared));
  } catch {
    return null;
  }
}

/**
 * Ask the control plane whether a command still has authority to provision.
 * `true`/`false` come from a 200 body's `active` field; every other outcome
 * (non-200, unparseable body, network failure) is ambiguous and returns
 * `null`, so the caller defers rather than acting on an unknown.
 */
export async function fetchCommandAuthority(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  commandId: string,
): Promise<boolean | null> {
  try {
    const response = await fetchFn(
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(commandId)}/authority`,
      { headers: authHeaders },
    );
    if (response.status !== 200) return null;
    const body = (await response.json()) as { active?: unknown } | null;
    return body?.active === true;
  } catch {
    return null;
  }
}

/**
 * Extract the canonical deployment manifest from a command's payload.
 *
 * The manifest is the Phase 2 replacement for ad-hoc detector columns: it is
 * persisted on `deployments.desired_state.manifest` at deployment creation and
 * shipped in the INSTALL payload. Validated against the contracts schema at
 * the payload boundary — an invalid or absent manifest reads as `null`, and
 * `settleInstall` refuses to provision without one (a resumed install's
 * compacted marker, which deliberately drops the manifest, is the one
 * exception — see `readVerifyOptionsFromPayload`).
 */
export function readDeploymentManifest(payload: Record<string, unknown>): DeploymentManifest | null {
  const parsed = deploymentManifestSchema.safeParse(payload['manifest']);
  return parsed.success ? parsed.data : null;
}

/**
 * Extract verification options from a command's payload.
 *
 * Phase 2: the canonical manifest, when present, is the ONLY source of
 * `redisRequired`/`databaseRequired` — derived directly from its
 * `database.postgres`/`redis.required` booleans, never a second
 * ad-hoc reading. The top-level flags are read only as a fallback for a
 * RESUMED install whose compacted pending marker dropped the manifest to
 * fit SSM's size limit (`compactPendingInstallPayload` below) — those flags
 * were themselves derived from the manifest when the marker was written, so
 * this never disagrees with template selection.
 *
 * `command.payload` is `Record<string, unknown>` — shaped by the control
 * plane, not by this module — so every field is validated defensively
 * before use rather than trusted or cast.
 *
 * The §59 `observe` hook (wired in `createRelayHandler`) does not read a
 * payload — it runs on every poll, outside any command. It gets its
 * requirement booleans from the commands response's deployment meta instead.
 */
export function readVerifyOptionsFromPayload(
  payload: Record<string, unknown>,
): { redisRequired?: boolean; databaseRequired?: boolean; stackName?: string } {
  const manifest = readDeploymentManifest(payload);
  const redisRequired = manifest ? manifest.redis.required : payload['redisRequired'];
  const databaseRequired = manifest ? manifest.database.postgres : payload['databaseRequired'];
  const stackName = payload['stackName'];

  return {
    ...(typeof redisRequired === 'boolean' ? { redisRequired } : {}),
    ...(typeof databaseRequired === 'boolean' ? { databaseRequired } : {}),
    ...(typeof stackName === 'string' && stackName.length > 0 ? { stackName } : {}),
  };
}

/**
 * Build the payload the INSTALL pending marker actually needs to keep.
 *
 * `command.payload` can carry the canonical manifest — ~16 KB in production
 * since it started riding the job (PR #73) — so `settleInstall` can derive
 * the create-time parameters and Redis variant from it. None of that is
 * needed to resume: only the merged `parameters` (which `settleInstall`
 * would otherwise recompute from the manifest every time) and the resolved
 * `redisRequired`/`databaseRequired` are. Dropping the manifest is what
 * keeps the marker under SSM's 4096-character Standard-tier limit
 * (`PENDING_MARKER_MAX_LENGTH` in `./pending.js`) — carrying it is what
 * silently failed the deferral write.
 *
 * Phase 2: the requirement flags are derived ONLY from the manifest,
 * never from `verifyOptions`/top-level payload flags — by the time
 * this runs, `settleInstall` has already refused to proceed without a
 * manifest, so this is total in practice; a manifest-less payload (a caller
 * that bypasses `settleInstall`) simply omits both flags rather than guess.
 *
 * The control plane's identity `tags` and the payload's `templateUrl`
 * survive compaction via `...rest` — a few hundred bytes, no interaction
 * with the SSM size cap.
 */
export function compactPendingInstallPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const { manifest: _manifest, ...rest } = payload;
  const manifest = readDeploymentManifest(payload);
  const aliases = manifest ? manifestBindingAliases(manifest) : [];

  return {
    ...rest,
    parameters: {
      ...readInstallParametersFromPayload(payload),
      ...(manifest ? buildInstallParametersFromManifest(manifest) : {}),
    },
    ...(manifest
      ? { redisRequired: manifest.redis.required, databaseRequired: manifest.database.postgres }
      : {}),
    // Stage B phase 2: the compact alias list survives the SSM size cap so a
    // resumed install can still register the manifest's binding aliases after
    // the stack settles (the full manifest cannot ride the pending marker).
    ...(aliases.length > 0 ? { bindingAliases: aliases } : {}),
  };
}

/**
 * The production wiring for INSTALL: real CloudFormation, real SSM, real
 * verification, with the execution role supplied by the bootstrap stack as
 * an environment variable. The install template URL comes from each
 * command's payload.
 *
 * `budgetMs` bounds how long a single invocation watches the stack. It has
 * to stay comfortably under the relay Lambda's own timeout — a killed
 * invocation reports nothing at all, which is the one outcome the deferral
 * machinery cannot recover from, because the pending marker is written
 * on the way out.
 *
 * `reportContext` is optional so this stays usable without a control-plane
 * connection (e.g. a future caller that only wants the AWS-facing half).
 * When it is supplied, `createRelayHandler` passes exactly the fetch/URL/
 * auth context the poll loop already reports results with — `getAuthHeaders`
 * reads the CURRENT auth state, because a stack event can be collected long
 * after a token has rotated.
 */
function createDefaultInstallDeps(
  installationId: string,
  reportContext?: {
    fetchFn: FetchFn;
    controlPlaneUrl: string;
    getAuthHeaders: () => Record<string, string>;
  },
): InstallExecutorDeps {
  const budget = Number(process.env['DEPLOYZ_INSTALL_BUDGET_MS'] ?? '');
  const budgetMs = Number.isFinite(budget) && budget > 0 ? budget : undefined;
  const executionRoleArn = process.env['DEPLOYZ_APPLICATION_EXECUTION_ROLE_ARN'];
  const roleBoundaryArn = process.env['DEPLOYZ_APPLICATION_ROLE_BOUNDARY_ARN'];
  // Phase 1: stopped-task evidence for a failed install, on the same ECS
  // reads (and IAM) the deploy path's crash-loop detector uses — both for
  // the stack-failure branch and the verification-failure branch.
  const stoppedTaskEvidence = (stackName: string) =>
    describeStoppedTaskEvidence(
      { cfn: getCloudFormationReader(), ecs: getEcsDeployClient() },
      stackName,
    );

  return {
    installationId,
    ...(executionRoleArn ? { executionRoleArn } : {}),
    ...(roleBoundaryArn ? { roleBoundaryArn } : {}),
    stoppedTaskEvidence,
    ec2: new EC2Client({}),
    install: (options) =>
      installApplicationStack({
        ...options,
        installer: getStackInstaller(),
        stoppedTaskEvidence,
        ...(budgetMs !== undefined ? { budgetMs } : {}),
      }),
    verify: (options) => verifyInstallation({ ...options, cfn: getCloudFormationReader() }),
    // Stage B phase 2: after a verified fresh install, copy the standard
    // injected env/secret values onto the manifest's alias names on a new
    // task-definition revision (see ./binding-alias.ts).
    applyBindingAliases: createBindingAliasApplier({
      cfn: getCloudFormationReader(),
      ecs: getEcsDeployClient(),
      installationId,
    }),
    pending: getPendingStore(installationId),
    ...(reportContext
      ? {
          readTemplateParameters: (templateUrl: string) =>
            readTemplateParameterNames(reportContext.fetchFn, templateUrl),
          checkAuthority: (commandId: string) =>
            fetchCommandAuthority(
              reportContext.fetchFn,
              reportContext.controlPlaneUrl,
              reportContext.getAuthHeaders(),
              commandId,
            ),
        }
      : {}),
    recover: (stackName) =>
      recoverFailedInstallStack(
        {
          cfn: getRecoveryCloudFormation(),
          rds: getRdsCleanupClient(),
          cache: getCacheCleanupClient(),
        },
        { stackName },
      ),
    ...(reportContext
      ? {
          createStackEventCollector: (args: {
            commandId: string;
            operationStartedAt: string;
            stackName: string;
            resumeAfter?: string;
          }) =>
            createStackEventCollector({
              reader: createStackEventsReader(),
              report: (events) =>
                reportCommandProgress(
                  reportContext.fetchFn,
                  reportContext.controlPlaneUrl,
                  reportContext.getAuthHeaders(),
                  {
                    commandId: args.commandId,
                    installationId,
                    stackName: args.stackName,
                    events: [...events],
                  },
                ),
              operationStartedAt: args.operationStartedAt,
              ...(args.resumeAfter !== undefined ? { resumeAfter: args.resumeAfter } : {}),
            }),
        }
      : {}),
  };
}

/** The deploy-side twin of `createDefaultInstallDeps`. */
function deployResumerDeps(
  installationId: string,
  unappliedConfiguration: EcsDeployDeps['unappliedConfiguration'],
  checkAuthority: EcsDeployDeps['checkAuthority'],
): EcsDeployDeps {
  return {
    cfn: getCloudFormationReader(),
    ecs: getEcsDeployClient(),
    elb: getTargetHealthReader(),
    pending: getPendingStore(installationId),
    stackName: relayApplicationStackName(),
    installationId,
    unappliedConfiguration,
    ...(checkAuthority ? { checkAuthority } : {}),
  };
}

/**
 * Default executors for the command vocabulary.
 *
 * ⚠️ THREE OF THESE ARE STILL STUBS: REPORT_HEALTH, MIGRATE and
 * REFRESH_METADATA each log and report success without touching the
 * customer's account. CONFIG_UPDATE and DESTROY are implemented:
 * CONFIG_UPDATE propagates configuration via createConfigUpdateExecutor
 * (./config-update.ts), DESTROY removes the application stack via
 * createDestroyExecutor (./destroy.ts).
 *
 * INSTALL is now real: it creates the published application template as a
 * CloudFormation stack, watches it to a terminal state, and reports what
 * happened — still behind the same `verifyInstallation` gate, so a stack
 * CloudFormation calls complete but that does not contain the application
 * is a failure.
 *
 * DEPLOY_RELEASE, ROLLBACK and RESTART are real: they drive the ECS service
 * discovered through the application stack — immutable digest pinning for
 * deploy/rollback (see ./deploy.ts), a forced rolling redeployment for
 * restart.
 *
 * CONFIGURE_DOMAIN and REMOVE_DOMAIN are real.
 *
 * The command vocabulary + dispatch + idempotency layer around them IS real.
 */
function createDefaultExecutors(
  installDeps: InstallExecutorDeps,
  unappliedConfiguration: EcsDeployDeps['unappliedConfiguration'],
): Record<string, CommandExecutor> {
  const noop: CommandExecutor = async (command) => {
    logCommandExecuted(command);
    return {
      commandId: command.id,
      idempotencyKey: command.idempotencyKey,
      success: true,
      output: { executed: true, type: command.type },
    };
  };

  // Real ACM/ALB clients are lazy SDK singletons (see ./domain.js) — no AWS
  // SDK call happens until a domain command is actually executed, so this
  // stays safe to construct even in unit tests that never touch AWS.
  const domainExecutors = createDomainExecutors({
    ...createRealDomainAwsClients(),
    installationId: installDeps.installationId,
  });

  // The deploy executors share the ECS write seam behind a lazy SDK client
  // (same construct-on-first-use rule as the readers above). The target
  // health reader is the settle gate's second half.
  const deployDeps: EcsDeployDeps = {
    cfn: getCloudFormationReader(),
    ecs: getEcsDeployClient(),
    elb: getTargetHealthReader(),
    pending: getPendingStore(installDeps.installationId),
    stackName: relayApplicationStackName(),
    installationId: installDeps.installationId,
    unappliedConfiguration,
    ...(installDeps.checkAuthority ? { checkAuthority: installDeps.checkAuthority } : {}),
  };

  const destroyDeps = {
    cfn: getCloudFormationReader(),
    deleter: getStackDeleter(),
    pending: getPendingStore(installDeps.installationId),
    installationId: installDeps.installationId,
    stackName: relayApplicationStackName(),
    // Same DELETE_FAILED recovery clients the INSTALL retry path uses (see
    // createDefaultInstallDeps's `recover`).
    rds: getRdsCleanupClient(),
    cache: getCacheCleanupClient(),
    // Phase 5: clears a standalone scheduled-job/migration task before the
    // cluster delete, so it never fails on ClusterContainsTasksException.
    ecs: getEcsStandaloneTaskStopper(),
    // Same collector factory INSTALL uses — identical arg shape, so it is
    // reused as-is rather than built a second time.
    ...(installDeps.createStackEventCollector
      ? { createStackEventCollector: installDeps.createStackEventCollector }
      : {}),
  };

  const purgeDeps: PurgeDeps = {
    cfn: getCloudFormationReader(),
    deleter: getStackDeleter(),
    pending: getPendingStore(installDeps.installationId),
    installationId: installDeps.installationId,
    stackName: relayApplicationStackName(),
    bootstrapStackName: relayBootstrapStackName(),
    // previousInstallationId is read from the command payload by the executor
    // and resumer, which also rebuild clients with the extended id set.
    ...getPurgeClients(installDeps.installationId),
  };

  return {
    INSTALL: createInstallExecutor(installDeps),
    REPORT_HEALTH: noop,
    DEPLOY_RELEASE: createEcsDeployExecutor(deployDeps),
    ROLLBACK: createEcsDeployExecutor(deployDeps),
    RESTART: createRestartExecutor(deployDeps),
    CONFIG_UPDATE: noop,
    DESTROY: createDestroyExecutor(destroyDeps),
    // DZ-AUDIT-009: read previousInstallationId from the command payload
    // and build deps with clients that know about both ids.
    PURGE: async (command) => {
      const prevId = typeof command.payload?.previousInstallationId === 'string'
        ? command.payload.previousInstallationId
        : undefined;
      const deps: PurgeDeps = prevId
        ? {
            ...purgeDeps,
            previousInstallationId: prevId,
            ...getPurgeClients(installDeps.installationId, prevId),
          }
        : purgeDeps;
      return createPurgeExecutor(deps)(command);
    },
    MIGRATE: noop,
    REFRESH_METADATA: noop,
    CONFIGURE_DOMAIN: domainExecutors.CONFIGURE_DOMAIN,
    REMOVE_DOMAIN: domainExecutors.REMOVE_DOMAIN,
  };
}

// ── §59 observe hook ─────────────────────────────────────────────────────────

/**
 * Wrap a §59 observe function so a mid-create or mid-update stack's
 * heartbeat carries a per-category provisioning snapshot alongside the
 * verification it already reports.
 *
 * `verifyInstallation` early-returns at `stack-complete` while the stack is
 * still building — right for the verified/not-verified question, but it
 * means that check alone tells a heartbeat nothing about progress. The
 * signal for "the stack exists and is still working" is exactly
 * `stack-exists` passed and `stack-complete` failed; any other shape
 * (missing stack, wrong installation, a fully complete but unverified
 * stack) has nothing a provisioning snapshot would add, so the plain
 * verification is returned unchanged.
 *
 * `verify` and `buildSnapshot` are passed in as functions, not clients, so
 * this composes and tests without an AWS reader — matching the seam style
 * of `createVerifyingExecutor` above.
 */
export function createObserveHook(
  verify: () => Promise<VerificationResult>,
  buildSnapshot: () => Promise<ProvisioningSnapshot | null>,
  listInventory?: () => Promise<ResourceInventory | null>,
): () => Promise<VerificationResult> {
  return async () => {
    const verification = await verify();

    let inventory: ResourceInventory | null = null;
    if (listInventory) {
      try {
        inventory = await listInventory();
      } catch {
        // The inventory is enrichment on top of the verification — never the
        // reason a heartbeat is lost. Absent means "not observed".
        inventory = null;
      }
    }
    const withInventory = inventory === null ? verification : { ...verification, inventory };

    const stackExists = verification.checks.find((check) => check.name === 'stack-exists');
    const stackComplete = verification.checks.find((check) => check.name === 'stack-complete');
    if (stackExists?.passed !== true || stackComplete?.passed !== false) {
      return withInventory;
    }

    try {
      const snapshot = await buildSnapshot();
      return snapshot ? { ...withInventory, provisioning: snapshot } : withInventory;
    } catch {
      // The snapshot is enrichment on top of an already-computed
      // verification — never the reason a heartbeat is lost.
      return withInventory;
    }
  };
}

// ── Handler factory (injectable deps for testing) ────────────────────────────

export interface RelayHandlerDeps {
  secretsClient: SecretsClient;
  fetchFn: FetchFn;
  /** Waits between control-plane retries; tests inject an instant one. */
  sleep?: SleepFn;
  executors?: Record<string, CommandExecutor>;
  idempotency?: IdempotencyStore;
  /**
   * Overrides the §59 observed-state hook wired into every poll cycle. When
   * omitted, falls back to the real `verifyInstallation` closure over the
   * lazy `CloudFormationReader` singleton — the same construct-on-first-use
   * pattern as `executors`/`domain.js`'s `getAcmSdkClient()`. Tests that
   * don't want a real AWS call on every poll (i.e. all of them) should
   * inject a stub here.
   */
  observe?: PollDependencies['observe'];
  /**
   * Overrides the deferred-command resume hook. When omitted, falls back to
   * `createInstallResumer` over the production install/verify/pending
   * wiring. Tests inject a stub here for the same reason as `observe`: the
   * real one reads SSM on every poll.
   */
  resume?: PollDependencies['resume'];
  /**
   * Overrides the relay identity (account/version/capabilities) reported at
   * enrollment and on every heartbeat. When omitted, derived from the
   * Lambda invocation context and environment (see identity.ts). Tests
   * inject a stub instead of fabricating a context.
   */
  identity?: PollDependencies['identity'];
  /**
   * Overrides the running-image-digest observation wired into every health
   * report. When omitted, discovers the ECS service through the application
   * stack and reads the digest off the running tasks.
   */
  observeImage?: PollDependencies['observeImage'];
  /**
   * Overrides the per-service digest observation that feeds the release
   * evidence and, without `observeImage`, the running image digest.
   */
  observeServiceDigests?: PollDependencies['observeServiceDigests'];
  /**
   * Overrides the runtime health observation (ECS counts, target health,
   * rollout state) wired into every health report.
   */
  observeHealth?: PollDependencies['observeHealth'];
  /**
   * Overrides the HTTP health-path probe (status code, latency, timestamps)
   * wired into every health report. When omitted, probes the application URL
   * the control plane passes in each poll's deployment meta.
   */
  observeProbe?: PollDependencies['observeProbe'];
  /**
   * Overrides the read of the relay's own bootstrap stack status. When
   * omitted, calls DescribeStacks on DEPLOYZ_BOOTSTRAP_STACK_NAME.
   */
  observeBootstrapStack?: () => Promise<string | null>;
}

/**
 * Create a relay handler function with injectable dependencies.
 *
 * The returned function matches the Lambda handler signature
 * `(event: ScheduledEvent, context?) => Promise<void>` so it can be wired
 * directly as the CDK NodejsFunction handler.
 */
export function createRelayHandler(deps: RelayHandlerDeps) {
  // Auth state persists across invocations within the same warm Lambda
  // container. On cold start it's re-created from Secrets Manager. Declared
  // before `installDeps` so the stack-events report closure below can close
  // over it — the collector reports long after this is first assigned, and
  // must always see whatever token rotation has left it holding.
  let authState: ReturnType<typeof createAuthState> | undefined;

  // Same env var `relayHandler` re-reads per invocation below — read once
  // here too, matching how `DEPLOYZ_INSTALLATION_ID` is already read at both
  // scopes, so the stack-events report closure has a base URL to POST to.
  const controlPlaneUrlForInstall = process.env['DEPLOYZ_CONTROL_PLANE_URL'] ?? '';
  const installDeps = createDefaultInstallDeps(process.env['DEPLOYZ_INSTALLATION_ID'] ?? '', {
    fetchFn: deps.fetchFn,
    controlPlaneUrl: controlPlaneUrlForInstall,
    getAuthHeaders: () => (authState ? buildAuthHeaders(authState) : {}),
  });
  // The effective configuration over the CURRENT auth token — read when
  // called, so it is always the token this invocation authenticated with.
  // CONFIG_UPDATE applies it; a first start checks that it reached the task
  // definition (DEPLOY-009).
  const fetchEffectiveConfig = async (): Promise<EffectiveConfigEntry[]> => {
    const controlPlaneUrl = process.env['DEPLOYZ_CONTROL_PLANE_URL'] ?? '';
    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'] ?? '';
    // A throttled control plane must not fail the configuration pass.
    const response = await fetchWithRetry(
      deps.fetchFn,
      `${controlPlaneUrl}/api/relay/config?installationId=${encodeURIComponent(installationId)}`,
      { headers: authState ? buildAuthHeaders(authState) : {} },
      deps.sleep,
    );
    if (response.status !== 200) {
      throw new Error(`Config fetch returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { entries: EffectiveConfigEntry[] };
    return body.entries;
  };
  const unappliedConfiguration = (definition: EcsTaskDefinition): Promise<string[]> =>
    unappliedConfigurationKeys(
      {
        cfn: getCloudFormationReader(),
        secrets: createRealConfigSecretsWriter(),
        fetchEffectiveConfig,
        stackName: relayApplicationStackName(),
      },
      definition,
    );
  const executors = deps.executors ?? createDefaultExecutors(installDeps, unappliedConfiguration);
  const idempotency = deps.idempotency ?? new IdempotencyStore();

  // Deployment facts the commands response refreshes every poll. The §59
  // observe hook runs outside any command, so the poll response is the only
  // channel that can tell it whether the installation should include a
  // cache and which application URL to probe — without this, a redis-required
  // deployment's heartbeats verify against the cache-less expectation and
  // never report the cache check, and no probe would ever run.
  //
  // Phase 2: both requirement flags start UNKNOWN (`undefined`), never a
  // guessed default — the observe hook below skips verification entirely
  // until the first poll response supplies real values.
  const deploymentMeta: {
    redisRequired?: boolean;
    databaseRequired?: boolean | undefined;
    probeUrl: string | null;
    workloads?: readonly { id: string; serviceLogicalId: string }[] | undefined;
    resourceChecks?:
      | readonly { componentId: string; check: string; logicalId: string; resourceType: string }[]
      | undefined;
  } = {
    probeUrl: null,
  };

  return async function relayHandler(
    event: ScheduledEvent,
    context?: { invokedFunctionArn?: string },
  ): Promise<void> {
    const installationId = process.env['DEPLOYZ_INSTALLATION_ID'];
    const secretArn = process.env['DEPLOYZ_CREDENTIAL_SECRET_ARN'];
    const controlPlaneUrl = process.env['DEPLOYZ_CONTROL_PLANE_URL'];
    // Set by the bootstrap stack from its EnrollmentCode parameter. Without
    // it the control plane has no way to tell which deployment this relay
    // belongs to — the installation id above is minted here, in the
    // customer's account, and has never been seen by the control plane.
    const enrollmentCode = process.env['DEPLOYZ_ENROLLMENT_CODE'];

    if (!installationId || !secretArn || !controlPlaneUrl || !enrollmentCode) {
      console.error(
        JSON.stringify({
          event: 'relay:missing-config',
          hasInstallationId: !!installationId,
          hasSecretArn: !!secretArn,
          hasControlPlaneUrl: !!controlPlaneUrl,
          hasEnrollmentCode: !!enrollmentCode,
        }),
      );
      return;
    }

    // Read the credential on cold start or if auth state was lost.
    if (!authState) {
      try {
        const token = await readCredential(deps.secretsClient, secretArn);
        authState = createAuthState(installationId, token);
      } catch (err) {
        console.error(
          JSON.stringify({
            event: 'relay:credential-read-failed',
            error: String(err),
          }),
        );
        return;
      }
    }

    const configExecutor = createConfigUpdateExecutor({
      cfn: getCloudFormationReader(),
      ecs: getEcsDeployClient(),
      secrets: createRealConfigSecretsWriter(),
      fetchEffectiveConfig,
      stackName: relayApplicationStackName(),
      installationId,
      elb: getTargetHealthReader(),
      pending: getPendingStore(installationId),
      ...(installDeps.checkAuthority ? { checkAuthority: installDeps.checkAuthority } : {}),
    });

    // One DescribeStacks per invocation. A failed read reports nothing and
    // never pauses claims.
    let bootstrapStackStatus: string | null = null;
    try {
      bootstrapStackStatus = await (
        deps.observeBootstrapStack ??
        (() => readBootstrapStackStatus(getCloudFormationReader(), relayBootstrapStackName()))
      )();
    } catch {
      bootstrapStackStatus = null;
    }

    const pollDeps: PollDependencies = {
      fetchFn: deps.fetchFn,
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
      controlPlaneUrl,
      installationId,
      enrollmentCode,
      executors: { ...executors, CONFIG_UPDATE: configExecutor },
      idempotency,
      // A result that reached the control plane is done: clear this
      // command's marker, but only while it is still this command's. Wrapped
      // so a store failure never breaks the poll.
      onResultReported: async (result, reported) => {
        if (!reported) return;
        try {
          await getPendingStore(installationId).compareAndSet(result.commandId, null);
        } catch (err) {
          console.error(
            JSON.stringify({
              event: 'relay:pending-cas-failed',
              commandId: result.commandId,
              error: String(err),
            }),
          );
        }
      },
      observe:
        deps.observe ??
        createObserveHook(
          () => {
            // Phase 2: never assume a database (or its absence) — until the
            // control plane's poll response has supplied both flags, skip
            // verification entirely (the throw becomes `infraHealth: null`
            // in poll.ts's reportHealth, i.e. "not observed", never a wrong
            // guess).
            if (deploymentMeta.redisRequired === undefined || deploymentMeta.databaseRequired === undefined) {
              throw new Error('Deployment requirements not yet known — waiting for the control plane');
            }
            return verifyInstallation({
              cfn: getCloudFormationReader(),
              installationId,
              stackName: relayApplicationStackName(),
              redisRequired: deploymentMeta.redisRequired,
              databaseRequired: deploymentMeta.databaseRequired,
              ...(deploymentMeta.workloads !== undefined ? { workloads: deploymentMeta.workloads } : {}),
              ...(deploymentMeta.resourceChecks !== undefined
                ? { resourceChecks: deploymentMeta.resourceChecks }
                : {}),
            });
          },
          () => buildProvisioningSnapshot(getCloudFormationReader(), relayApplicationStackName()),
          () =>
            listAllStackResources(getCloudFormationReader(), relayApplicationStackName()).then(
              (inventory) =>
                inventory ? { ...inventory, observedAt: new Date().toISOString() } : null,
            ),
        ),
      // One pending store, several resumers: each settles only its own
      // command type, so composing them is safe.
      resume:
        deps.resume ??
        (async () => {
          const installResults = await createInstallResumer(installDeps)();
          if (installResults.length > 0) return installResults;
          const deployResults = await createEcsDeployResumer(
            deployResumerDeps(installDeps.installationId, unappliedConfiguration, installDeps.checkAuthority),
          )();
          if (deployResults.length > 0) return deployResults;
          const configResults = await createConfigUpdateResumer({
            cfn: getCloudFormationReader(),
            ecs: getEcsDeployClient(),
            elb: getTargetHealthReader(),
            pending: getPendingStore(installationId),
            stackName: relayApplicationStackName(),
          })();
          if (configResults.length > 0) return configResults;
          const restartResults = await createRestartResumer({
            cfn: getCloudFormationReader(),
            ecs: getEcsDeployClient(),
            elb: getTargetHealthReader(),
            pending: getPendingStore(installationId),
            stackName: relayApplicationStackName(),
          })();
          if (restartResults.length > 0) return restartResults;
          const destroyResults = await createDestroyResumer({
            cfn: getCloudFormationReader(),
            deleter: getStackDeleter(),
            pending: getPendingStore(installationId),
            installationId,
            stackName: relayApplicationStackName(),
            rds: getRdsCleanupClient(),
            cache: getCacheCleanupClient(),
            ...(installDeps.createStackEventCollector
              ? { createStackEventCollector: installDeps.createStackEventCollector }
              : {}),
          })();
          if (destroyResults.length > 0) return destroyResults;
          // DZ-AUDIT-009: read previousInstallationId from the pending
          // record and build deps with clients that know about both ids.
          const purgePendingStore = getPendingStore(installationId);
          const purgePending = await purgePendingStore.read();
          const purgePrevId =
            purgePending?.type === 'PURGE' &&
            typeof purgePending.payload?.previousInstallationId === 'string'
              ? purgePending.payload.previousInstallationId
              : undefined;
          return createPurgeResumer({
            cfn: getCloudFormationReader(),
            deleter: getStackDeleter(),
            pending: purgePendingStore,
            installationId,
            stackName: relayApplicationStackName(),
            bootstrapStackName: relayBootstrapStackName(),
            ...getPurgeClients(installationId, purgePrevId),
          })();
        }),
      identity: {
        ...(deps.identity ?? readRelayIdentity(context)),
        ...(bootstrapStackStatus !== null ? { bootstrapStackStatus } : {}),
      },
      ...(isBootstrapStackUpdating(bootstrapStackStatus) ? { pauseClaims: true } : {}),
      ...(deps.observeImage ? { observeImage: deps.observeImage } : {}),
      observeServiceDigests:
        deps.observeServiceDigests ??
        (() =>
          observeServiceDigests(
            {
              cfn: getCloudFormationReader(),
              ecs: getEcsTaskReader(),
              installationId,
            },
            relayApplicationStackName(),
          )),
      observeHealth:
        deps.observeHealth ??
        (() =>
          observeRuntimeHealth(
            {
              cfn: getCloudFormationReader(),
              ecs: getEcsServiceReader(),
              elb: getTargetHealthReader(),
            },
            relayApplicationStackName(),
            deploymentMeta.workloads,
          )),
      observeProbe:
        deps.observeProbe ??
        (async () =>
          deploymentMeta.probeUrl === null
            ? null
            : probeHealthUrl(deps.fetchFn, deploymentMeta.probeUrl)),
      onDeploymentMeta: (meta) => {
        // Symmetric: the control plane sends both flags together or
        // neither (server.ts's GET /api/relay/commands), so both are
        // assigned the same way — never one guarded, the other not.
        deploymentMeta.redisRequired = meta.redisRequired;
        deploymentMeta.databaseRequired = meta.databaseRequired;
        deploymentMeta.probeUrl = meta.probeUrl;
        // Phase 4A: per-workload service seats, when the control plane has
        // them. Absent (an older control plane) keeps the single-application
        // heartbeat shape.
        deploymentMeta.workloads = 'workloads' in meta ? meta.workloads : undefined;
        // Phase 5: generic resource checks (queue/schedule/…), when the
        // control plane has them. Absent (an older control plane) keeps
        // verification exactly as it was.
        deploymentMeta.resourceChecks = 'resourceChecks' in meta ? meta.resourceChecks : undefined;
      },
    };

    const result = await pollOnce(pollDeps, authState);

    console.log(
      JSON.stringify({
        event: 'relay:poll-complete',
        installationId,
        scheduledAt: event.time ?? new Date().toISOString(),
        ...result,
      }),
    );
  };
}

/**
 * Production handler — wired with real `globalThis.fetch` and a real
 * Secrets Manager client (injected by the CDK bundling or Lambda layer).
 *
 * The `handler` export is what the CDK NodejsFunction invokes.
 */
export const handler = withLease(createRelayHandler({
  secretsClient: {
    async getSecretValue(params: { SecretId: string }) {
      const client = new AwsSecretsManagerClient({});
      const response = await client.send(new GetSecretValueCommand(params));
      return { SecretString: response.SecretString ?? undefined };
    },
  },
  fetchFn: globalThis.fetch.bind(globalThis),
}));
