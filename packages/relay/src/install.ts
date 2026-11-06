/**
 * INSTALL — provision the customer's application stack.
 *
 * This is the write side of what `./verify.ts` reads. The relay creates the
 * published application template as a CloudFormation stack in the customer's
 * own account, watches it to a terminal state, and reports what actually
 * happened. `verifyInstallation()` then re-asks CloudFormation the same
 * question independently, so a success claim is never taken on this module's
 * word alone.
 *
 * Three properties this module is built around:
 *
 * 1. **Stack-level tags, not template tags.** The `deployz:installation` tag
 *    goes on the `CreateStack` call itself. The relay's IAM condition
 *    (`aws:RequestTag/deployz:installation`) is evaluated against that tag,
 *    and `verifyInstallation`'s `stack-tagged` check reads it back off the
 *    stack. CDK's `Tags.of(...)` writes per-resource template tags, which
 *    neither of those two ever look at — passing only those would deny the
 *    create and then fail the verification.
 *
 * 2. **Idempotent.** A re-delivered INSTALL, a resumed one, or a retry after
 *    a lost result must never create a second stack. The stack's own
 *    existence is the record: describe first, create only when there is
 *    nothing there, and treat an `AlreadyExists` race as an in-flight create.
 *
 * 3. **Bounded, resumable waiting.** The application stack (VPC + NAT, RDS,
 *    ALB, and an ECS service CloudFormation waits to stabilise) routinely
 *    takes longer than a Lambda invocation is allowed to live. Rather than
 *    guess, this returns `in-progress` when the time budget runs out — a
 *    third answer that is neither success nor failure, so the caller can
 *    hand the same question back to the next poll instead of inventing a
 *    verdict.
 */

import {
  CloudFormationClient,
  CreateStackCommand,
  DescribeStackEventsCommand,
  DescribeStacksCommand,
  type Capability,
} from '@aws-sdk/client-cloudformation';
import {
  DEFAULT_APPLICATION_STACK_NAME,
  DEPLOYZ_INSTALLATION_TAG,
  type DeploymentManifest,
  type FailureEvidence,
} from '@deployz/contracts';
import type { EcsDeployClient } from './deploy.js';
import { applicationExits, essentialContainerNames } from './ecs-observe.js';
import type { CloudFormationReader } from './verify.js';

/** CFN logical id of the template's container-port parameter (CDK strips the underscore from `param_ContainerPort`). */
export const CONTAINER_PORT_PARAMETER = 'paramContainerPort';
/** CFN logical id of the template's health-check-path parameter (CDK strips the underscore from `param_HealthCheckPath`). */
export const HEALTH_CHECK_PATH_PARAMETER = 'paramHealthCheckPath';

/**
 * The application stack creates IAM roles for the ECS tasks, so
 * CloudFormation refuses the create without an explicit acknowledgement.
 * `CAPABILITY_NAMED_IAM` is included alongside it because the stack's
 * CloudFormation execution role is looked up by a fixed path.
 */
const CAPABILITIES = ['CAPABILITY_IAM', 'CAPABILITY_NAMED_IAM'] as const;

/** Terminal statuses that mean the stack is up. */
const SUCCESS_STATUSES: ReadonlySet<string> = new Set(['CREATE_COMPLETE', 'UPDATE_COMPLETE']);

/**
 * Terminal statuses that mean the stack is not up and will not become up
 * without another operation. `ROLLBACK_COMPLETE` is the one to note: the
 * stack still exists, so "the stack is there" is not the same question as
 * "the install worked".
 */
const FAILURE_STATUSES: ReadonlySet<string> = new Set([
  'CREATE_FAILED',
  'ROLLBACK_COMPLETE',
  'ROLLBACK_FAILED',
  'DELETE_COMPLETE',
  'DELETE_FAILED',
  'UPDATE_FAILED',
  'UPDATE_ROLLBACK_COMPLETE',
  'UPDATE_ROLLBACK_FAILED',
  'IMPORT_ROLLBACK_COMPLETE',
  'IMPORT_ROLLBACK_FAILED',
]);

// ── Observed shapes ─────────────────────────────────────────────────────────

export interface StackState {
  readonly status: string;
  /** CloudFormation's own explanation, when it gave one. */
  readonly statusReason?: string;
  readonly outputs: Readonly<Record<string, string>>;
}

/**
 * What a describe said. A confirmed `absent` means "there is no such stack";
 * `found: false` with `absent: false` means the read itself failed — a
 * throttle, a permission denial or a transport error — which is never
 * evidence that the stack is gone.
 */
export type StackDescribeOutcome =
  | { readonly found: true; readonly stack: StackState }
  | { readonly found: false; readonly absent: true }
  | { readonly found: false; readonly absent: false; readonly errorCode?: string };

export interface CreateStackInput {
  readonly stackName: string;
  readonly templateUrl: string;
  readonly parameters: Readonly<Record<string, string>>;
  /** Stack-level tags — the `Tags` parameter of `CreateStack`. */
  readonly tags: Readonly<Record<string, string>>;
  readonly capabilities: readonly string[];
  /** CloudFormation execution role. Absent means "use the caller's rights". */
  readonly roleArn?: string;
}

/**
 * `AlreadyExists` is called out separately from other refusals because it is
 * the one that is not a problem: two invocations raced, the earlier one won,
 * and the right response is to watch the stack the winner created.
 */
export type CreateStackOutcome =
  | { readonly created: true; readonly stackId: string }
  | { readonly created: false; readonly alreadyExists: true }
  | {
      readonly created: false;
      readonly alreadyExists: false;
      readonly errorCode?: string;
      readonly message: string;
    };

/**
 * Why this install may create a stack. `fresh` is a first install; `resume`
 * continues an install that must adopt an existing stack and never recreates
 * a missing one; `recovery` is the authorized first-install recovery pass,
 * which may recreate after the previous stack is deleted.
 */
export type InstallCreateMode = 'fresh' | 'resume' | 'recovery';

/** A resource-level `CREATE_FAILED` event, the actual cause behind a rollback. */
export interface StackFailureEvent {
  readonly logicalResourceId: string;
  readonly resourceType: string;
  readonly resourceStatusReason: string;
  /** ISO 8601 — used only to order candidates, never displayed. */
  readonly timestamp: string;
}

/** The injectable seam. Implementations must never throw. */
export interface StackInstaller {
  createStack(input: CreateStackInput): Promise<CreateStackOutcome>;
  /** `null` when there is no such stack — including when it cannot be read. */
  describeStack(stackName: string): Promise<StackState | null>;
  /**
   * Optional richer read: separates a confirmed absence from a failed read.
   * `run` prefers it when present and otherwise wraps `describeStack`, where
   * every failure reads as a confirmed absence.
   */
  describeStackOutcome?(stackName: string): Promise<StackDescribeOutcome>;
  /**
   * Every `CREATE_FAILED` resource event for a stack, already stripped of
   * events with no reason. Empty when there are none or the events could not
   * be read — the failure reason then falls back to the stack-level one.
   */
  describeStackEvents(stackName: string): Promise<StackFailureEvent[]>;
}

// ── Options and outcome ─────────────────────────────────────────────────────

export interface InstallOptions {
  readonly installer: StackInstaller;
  readonly installationId: string;
  /** Public HTTPS URL of the published application template. */
  readonly templateUrl: string;
  /** Defaults to `DEFAULT_APPLICATION_STACK_NAME`. */
  readonly stackName?: string;
  /** Template parameter values, by parameter name. */
  readonly parameters?: Readonly<Record<string, string>>;
  /**
   * Control-plane-minted deployz identity tags, applied as stack-level tags
   * so CloudFormation propagates them to every taggable resource — including
   * the retained RDS instance and S3 bucket. Absent for payloads minted by
   * older control planes; the relay never updates tags in place.
   */
  readonly deploymentTags?: Readonly<Record<string, string>>;
  /** CloudFormation execution role ARN (`role/deployz/*`). */
  readonly executionRoleArn?: string;
  /** How long to watch before answering `in-progress`. Defaults to 3 minutes. */
  readonly budgetMs?: number;
  /** Gap between `DescribeStacks` calls. Defaults to 5 seconds. */
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Why this install may create. Defaults to `'fresh'`. */
  readonly createMode?: InstallCreateMode;
  /**
   * Recovery only: re-checked immediately before every `CreateStack`, so a
   * grant that expired while this install waited cannot leak into a create.
   * Absent means recovery creates without a separate authorization step.
   */
  readonly authorizeRecoveryCreate?: () => Promise<boolean>;
  /**
   * Called once per wait-loop tick, and once more after the loop reaches a
   * terminal state, with the stack name being watched. Wired to the
   * stack-event collector so CloudFormation events reach the control plane
   * on the same cadence as the wait loop already polls with — never a
   * second timer. Guarded: a rejection here can never change the install
   * outcome.
   */
  readonly onPoll?: (stackName: string) => Promise<void>;
  /**
   * Phase 1 failure evidence: called only when the stack settles in a
   * failure status, to describe the service's stopped tasks (see
   * `describeStoppedTaskEvidence`). Guarded: a rejection here can never
   * change the install outcome — evidence is enrichment, not a verdict.
   */
  readonly stoppedTaskEvidence?: (stackName: string) => Promise<FailureEvidence | null>;
}

export type InstallOutcome =
  | {
      readonly state: 'succeeded';
      readonly status: string;
      readonly outputs: Readonly<Record<string, string>>;
    }
  | {
      readonly state: 'failed';
      readonly status?: string;
      readonly reason: string;
      readonly outputs: Readonly<Record<string, string>>;
      /** Phase 1 structured evidence from the service's stopped tasks, when any were described. */
      readonly evidence?: FailureEvidence;
    }
  | { readonly state: 'in-progress'; readonly status: string };

const DEFAULT_BUDGET_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Translate the canonical deployment manifest into the application template's
 * per-install CloudFormation parameters. Phase 2: the manifest — never the
 * ad-hoc detector columns — is the source for the values the template's
 * `param_ContainerPort` / `param_HealthCheckPath` parameters carry.
 *
 * `web.port` and `health.path` are the only manifest fields the application
 * template can parameterize; the remaining manifest fields (build context,
 * worker command, dependency requirements) shape infrastructure that is fixed
 * at template-publish time. Values the control plane supplies as secret
 * parameters are merged by the caller, with the manifest winning conflicts.
 */
export function buildInstallParametersFromManifest(
  manifest: DeploymentManifest,
): Record<string, string> {
  const parameters: Record<string, string> = {};
  if (manifest.web.port !== null) {
    parameters[CONTAINER_PORT_PARAMETER] = String(manifest.web.port);
  }
  if (manifest.health.path.length > 0) {
    parameters[HEALTH_CHECK_PATH_PARAMETER] = manifest.health.path;
  }
  return parameters;
}

/**
 * How many consecutive unreadable polls mean the read is broken, not that
 * the stack is gone. `describeStack` maps every failure to `null`; the richer
 * `describeStackOutcome` separates a confirmed absence from a failed read.
 * One throttled or denied read during a twenty-minute watch must not fail an
 * install that is going fine, permanently, because the control plane does not
 * re-issue a job it has already reported on. A run of them is a different
 * matter.
 */
const UNREADABLE_POLLS_BEFORE_FAILING = 3;

/**
 * How many consecutive confirmed absences mean the watched stack is gone.
 * The stack was readable a moment ago and the reads now confirm nothing is
 * there: something deleted it, and this install did not produce a stack.
 */
const ABSENT_POLLS_BEFORE_FAILING = 3;

/** CloudFormation's answer for a stack outside the relay's tag-scoped read grant — including one not created yet. */
function isAccessDenied(errorCode: string | undefined): boolean {
  return errorCode === 'AccessDenied' || errorCode === 'AccessDeniedException';
}

/**
 * Create the application stack if it is not already there, then watch it
 * until it settles or the time budget runs out.
 *
 * Never throws: an installer that breaks its no-throw contract still comes
 * back as `failed`, because a command whose outcome we cannot determine must
 * not be reported as one that worked.
 */
export async function installApplicationStack(options: InstallOptions): Promise<InstallOutcome> {
  try {
    return await run(options);
  } catch (error) {
    return {
      state: 'failed',
      reason: `Install could not run: ${message(error)}`,
      outputs: {},
    };
  }
}

/** The placeholder the control plane stores in place of a secret it already delivered. */
export const MASKED_SECRET_VALUE = '***';

async function run(options: InstallOptions): Promise<InstallOutcome> {
  const {
    installer,
    installationId,
    templateUrl,
    stackName = DEFAULT_APPLICATION_STACK_NAME,
    parameters = {},
    budgetMs = DEFAULT_BUDGET_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = defaultSleep,
    onPoll,
    createMode = 'fresh',
    authorizeRecoveryCreate,
  } = options;

  const deadline = now() + budgetMs;

  const unauthorizedRecovery = (): InstallOutcome => ({
    state: 'failed',
    reason: `Recovery is no longer authorized for stack "${stackName}" — not recreating`,
    outputs: {},
  });

  const createStack = async (): Promise<InstallOutcome | null> => {
    if (Object.values(parameters).includes(MASKED_SECRET_VALUE)) {
      return {
        state: 'failed',
        reason:
          'Install parameters hold a masked secret value, so the stack was not created. Retry the install to get new values.',
        outputs: {},
      };
    }
    // Recovery recreates a stack the control plane authorized. The grant is
    // re-read immediately before the write, so one that expired while this
    // install waited cannot leak into a create.
    if (createMode === 'recovery' && authorizeRecoveryCreate) {
      if (!(await authorizeRecoveryCreate())) return unauthorizedRecovery();
    }
    const created = await installer.createStack({
      stackName,
      templateUrl,
      parameters,
      // The control plane's identity tags ride the same stack-level Tags
      // parameter; the installation tag itself is the single tag both the
      // IAM condition and the verifier depend on, so it wins any collision.
      tags: { ...(options.deploymentTags ?? {}), [DEPLOYZ_INSTALLATION_TAG]: installationId },
      capabilities: [...CAPABILITIES],
      ...(options.executionRoleArn !== undefined ? { roleArn: options.executionRoleArn } : {}),
    });
    if (!created.created && !created.alreadyExists) {
      const code = created.errorCode ? `${created.errorCode}: ` : '';
      return {
        state: 'failed',
        reason: `CloudFormation refused to create "${stackName}" — ${code}${created.message}`,
        outputs: {},
      };
    }
    return null;
  };

  // A confirmed absence and a failed read are different answers. `describe`
  // prefers the richer read when the installer offers it and falls back to
  // `describeStack`, where every failure reads as a confirmed absence.
  const describe = async (): Promise<StackDescribeOutcome> => {
    if (installer.describeStackOutcome) {
      return installer.describeStackOutcome(stackName);
    }
    const stack = await installer.describeStack(stackName);
    return stack === null ? { found: false, absent: true } : { found: true, stack };
  };

  // Describe before create. This is what makes a re-delivered or resumed
  // INSTALL safe: an existing stack is adopted, never duplicated.
  const initial = await describe();
  let last: StackState | null = null;
  let unreadable = 0;
  let absent = 0;
  let createdAfterDelete = false;

  if (initial.found) {
    last = initial.stack;
    const settled = await settle(initial.stack, stackName, installer, options.stoppedTaskEvidence);
    if (settled) return settled;
  } else if (initial.absent) {
    if (createMode === 'resume') {
      return {
        state: 'failed',
        reason: `Stack "${stackName}" no longer exists; a resumed install does not recreate it`,
        outputs: {},
      };
    }
    const refused = await createStack();
    if (refused !== null) return refused;
  } else if ((createMode === 'fresh' || createMode === 'recovery') && isAccessDenied(initial.errorCode)) {
    // The relay's stack-read grant is scoped to its installation tag, and a
    // stack that does not exist yet has no tags: CloudFormation answers
    // AccessDenied, not "does not exist". A fresh install therefore creates,
    // and so does a recovery, whose stack was just deleted; a recovery create
    // is still gated by `authorizeRecoveryCreate`. CloudFormation refuses
    // CreateStack for a name that already exists, and that race is adopted as
    // an in-flight create.
    const refused = await createStack();
    if (refused !== null) return refused;
  } else {
    // Unreadable, not absent: the stack may be there, so never create. Watch
    // it and let a run of failed reads decide.
    unreadable = 1;
  }

  // Watch it settle.
  for (;;) {
    if (now() >= deadline) {
      return { state: 'in-progress', status: last?.status ?? 'CREATE_IN_PROGRESS' };
    }
    await sleep(pollIntervalMs);
    if (now() >= deadline) {
      return { state: 'in-progress', status: last?.status ?? 'CREATE_IN_PROGRESS' };
    }

    try {
      await onPoll?.(stackName);
    } catch {
      // Event collection is enrichment, never a reason the wait loop stops.
    }

    const outcome = await describe();
    if (outcome.found) {
      unreadable = 0;
      absent = 0;
      last = outcome.stack;
      const settled = await settle(outcome.stack, stackName, installer, options.stoppedTaskEvidence);
      if (settled) {
        // One more collection pass now that the stack has a verdict, so the
        // tail events between the last tick and the terminal state are not
        // lost to the invocation ending.
        try {
          await onPoll?.(stackName);
        } catch {
          // Same rule as above — never the reason the outcome is lost.
        }
        return settled;
      }
      continue;
    }

    // After the stack this recovery watched deleting is gone, the tag-scoped
    // read answers AccessDenied, not "does not exist": the stack has no tags.
    const deletedByRecovery =
      !outcome.absent &&
      isAccessDenied(outcome.errorCode) &&
      last?.status === 'DELETE_IN_PROGRESS' &&
      createMode === 'recovery' &&
      !createdAfterDelete;

    if (outcome.absent || deletedByRecovery) {
      unreadable = 0;
      // An adopted DELETE_IN_PROGRESS finishing is not a loss of access —
      // it is first-install recovery (or a concurrent destroy) clearing the
      // failed previous stack. Only an authorized recovery may recreate it.
      if (
        last?.status === 'DELETE_IN_PROGRESS' &&
        createMode === 'recovery' &&
        !createdAfterDelete
      ) {
        const refused = await createStack();
        if (refused !== null) return refused;
        createdAfterDelete = true;
        absent = 0;
        last = null;
        continue;
      }
      absent += 1;
      if (absent >= ABSENT_POLLS_BEFORE_FAILING) {
        // It was there a moment ago, and is confirmed gone now: something
        // deleted it, and this install did not produce a stack.
        return {
          state: 'failed',
          reason:
            `Stack "${stackName}" was deleted while this install was watching it — ` +
            `${absent} consecutive checks found no stack`,
          outputs: {},
        };
      }
      continue;
    }

    absent = 0;
    unreadable += 1;
    if (unreadable >= UNREADABLE_POLLS_BEFORE_FAILING) {
      // The read itself is broken — throttled, denied or a transport error.
      // That is not evidence the stack is gone.
      const code = outcome.errorCode ? ` (${outcome.errorCode})` : '';
      return {
        state: 'failed',
        reason:
          `Stack "${stackName}" could not be read for ${unreadable} consecutive checks${code} — ` +
          'throttling, permission or transport, not a missing stack',
        outputs: {},
      };
    }
  }
}

/** Boilerplate reasons CloudFormation gives the resources it cancelled in
 * response to the one that actually failed — never the cause itself. */
const CANCELLED_REASONS: ReadonlySet<string> = new Set([
  'Resource creation cancelled',
  'Resource update cancelled',
]);

/**
 * The earliest genuine `CREATE_FAILED` resource event — the one that
 * actually caused the rollback, as opposed to the siblings CloudFormation
 * cancelled in response to it. `DescribeStackEvents` ordering is not relied
 * on; every candidate is compared by timestamp instead.
 */
export function firstFailureEvent(events: readonly StackFailureEvent[]): StackFailureEvent | null {
  let earliest: StackFailureEvent | null = null;
  for (const event of events) {
    if (CANCELLED_REASONS.has(event.resourceStatusReason.trim())) continue;
    if (!earliest || event.timestamp < earliest.timestamp) {
      earliest = event;
    }
  }
  return earliest;
}

/** Keeps the reason short — it flows into job.result.error → event payload → UI. */
const MAX_REASON_LENGTH = 500;

function bounded(reason: string): string {
  return reason.length > MAX_REASON_LENGTH ? `${reason.slice(0, MAX_REASON_LENGTH - 1)}…` : reason;
}

/**
 * Appends the first genuine resource-level failure cause to a stack-level
 * reason, when one can be found. The stack-level `StackStatusReason` is
 * usually just "The following resource(s) failed to create..." — the actual
 * cause (an AccessDenied, a quota, a bad parameter) only exists on the
 * failing resource's own event.
 */
async function withResourceFailureDetail(
  reason: string,
  stackName: string,
  installer: StackInstaller,
): Promise<string> {
  let events: StackFailureEvent[];
  try {
    events = await installer.describeStackEvents(stackName);
  } catch {
    return bounded(reason);
  }
  const failure = firstFailureEvent(events);
  if (!failure) return bounded(reason);
  return bounded(
    `${reason} — ${failure.logicalResourceId} (${failure.resourceType}): ${failure.resourceStatusReason}`,
  );
}

/**
 * Phase 1 container evidence for a failed install — the service's stopped
 * tasks, described with the same reads and the same IAM the deploy path's
 * crash-loop detector already uses (stack resources → service → stopped
 * tasks; never logs — the relay role is denied log reads by design). The
 * most common stopped task is the verdict. Only an application container's
 * exit code counts, by name from the revision each task ran — a helper's
 * exit is never reported as the application's. Never throws: any error
 * means no evidence, and the failure settlement proceeds unchanged.
 */
export async function describeStoppedTaskEvidence(
  deps: {
    readonly cfn: Pick<CloudFormationReader, 'describeStackResources'>;
    readonly ecs: Pick<EcsDeployClient, 'listTasks' | 'describeTasks' | 'describeTaskDefinition'>;
  },
  stackName: string,
): Promise<FailureEvidence | null> {
  try {
    const resources = await deps.cfn.describeStackResources(stackName);
    const serviceArn =
      resources.find((resource) => resource.type === 'AWS::ECS::Service')?.physicalId ?? null;
    const cluster = serviceArn?.split('/')[1] ?? null;
    if (serviceArn === null || cluster === null) return null;
    const { taskArns } = await deps.ecs.listTasks({
      cluster,
      serviceName: serviceArn,
      desiredStatus: 'STOPPED',
    });
    if (taskArns.length === 0) return null;
    const { tasks } = await deps.ecs.describeTasks({ cluster, tasks: taskArns.slice(0, 20) });
    const stopped = new Map<
      string,
      { count: number; exitCode: number | null; stopCode: string | null; stoppedReason: string | null }
    >();
    const essentialByRevision = new Map<string, ReadonlySet<string>>();
    for (const task of tasks) {
      let essential: ReadonlySet<string> = new Set();
      if (task.taskDefinitionArn !== undefined) {
        essential =
          essentialByRevision.get(task.taskDefinitionArn) ??
          essentialContainerNames(
            (await deps.ecs.describeTaskDefinition({ taskDefinition: task.taskDefinitionArn })).taskDefinition
              .containerDefinitions,
          );
        essentialByRevision.set(task.taskDefinitionArn, essential);
      }
      const exits = applicationExits(task.containers, essential);
      const exited = exits.find((container) => container.exitCode !== 0) ?? exits[0];
      const exitCode = exited?.exitCode ?? null;
      const signature = `${exitCode ?? ''}\n${task.stopCode ?? ''}\n${task.stoppedReason ?? ''}`;
      const existing = stopped.get(signature);
      if (existing) {
        existing.count += 1;
        continue;
      }
      stopped.set(signature, {
        count: 1,
        exitCode,
        stopCode: task.stopCode ?? null,
        stoppedReason: task.stoppedReason ?? null,
      });
    }
    let common: { count: number; exitCode: number | null; stopCode: string | null; stoppedReason: string | null } | null =
      null;
    for (const entry of stopped.values()) {
      if (common === null || entry.count > common.count) common = entry;
    }
    if (common === null) return null;
    return {
      container: {
        exitCode: common.exitCode,
        stopCode: common.stopCode,
        stoppedReason: common.stoppedReason,
        stoppedTaskCount: common.count,
      },
    };
  } catch {
    return null;
  }
}

/** A verdict, or `undefined` while the stack is still moving. */
async function settle(
  state: StackState,
  stackName: string,
  installer: StackInstaller,
  stoppedTaskEvidence?: (stackName: string) => Promise<FailureEvidence | null>,
): Promise<InstallOutcome | undefined> {
  if (SUCCESS_STATUSES.has(state.status)) {
    return { state: 'succeeded', status: state.status, outputs: state.outputs };
  }
  if (FAILURE_STATUSES.has(state.status)) {
    const because = state.statusReason ? ` — ${state.statusReason}` : '';
    const reason = await withResourceFailureDetail(
      `Stack "${stackName}" finished in ${state.status}${because}`,
      stackName,
      installer,
    );
    // Phase 1: describe the service's stopped tasks best-effort — the
    // stack-level reason never says why the container exited. A throwing
    // collector is the same as one that found nothing.
    let evidence: FailureEvidence | null = null;
    if (stoppedTaskEvidence) {
      try {
        evidence = await stoppedTaskEvidence(stackName);
      } catch {
        evidence = null;
      }
    }
    return {
      state: 'failed',
      status: state.status,
      reason,
      outputs: state.outputs,
      ...(evidence !== null ? { evidence } : {}),
    };
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ── Real installer ──────────────────────────────────────────────────────────

/** The one method of the SDK client this module uses. */
interface SendsCommands {
  send(command: unknown): Promise<unknown>;
}

/**
 * Wrap a CloudFormation client as an installer.
 *
 * Every throw is mapped here, so the orchestration above never sees an
 * exception. `describeStack` maps ANY failure to `null` — "not there" and
 * "not readable" are the same answer to "is there a stack to adopt?", and
 * conflating them is safe in that direction: the worst case is an extra
 * `CreateStack` attempt, which CloudFormation itself rejects with
 * `AlreadyExistsException`.
 *
 * Split out from `createStackInstaller` so it can be tested against a fake
 * client with no SDK construction, matching `toReader` in `./verify.ts`.
 */
export function toInstaller(client: SendsCommands): StackInstaller {
  return {
    async createStack(input: CreateStackInput): Promise<CreateStackOutcome> {
      try {
        const response = (await client.send(
          new CreateStackCommand({
            StackName: input.stackName,
            TemplateURL: input.templateUrl,
            Parameters: Object.entries(input.parameters).map(([key, value]) => ({
              ParameterKey: key,
              ParameterValue: value,
            })),
            // The `Tags` parameter — stack-level tags, which CloudFormation
            // also propagates onto every resource that supports tagging.
            Tags: Object.entries(input.tags).map(([key, value]) => ({
              Key: key,
              Value: value,
            })),
            Capabilities: [...input.capabilities] as Capability[],
            ...(input.roleArn !== undefined ? { RoleARN: input.roleArn } : {}),
          }),
        )) as { StackId?: string };

        return { created: true, stackId: response.StackId ?? '' };
      } catch (err) {
        const errorCode = err instanceof Error ? err.name : undefined;
        if (errorCode === 'AlreadyExistsException') {
          return { created: false, alreadyExists: true };
        }
        return {
          created: false,
          alreadyExists: false,
          ...(errorCode !== undefined ? { errorCode } : {}),
          message: message(err),
        };
      }
    },

    async describeStack(stackName: string): Promise<StackState | null> {
      try {
        const response = (await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        )) as {
          Stacks?: {
            StackStatus?: string;
            StackStatusReason?: string;
            Outputs?: { OutputKey?: string; OutputValue?: string }[];
          }[];
        };

        const stack = response.Stacks?.[0];
        if (!stack?.StackStatus) return null;

        const outputs: Record<string, string> = {};
        for (const output of stack.Outputs ?? []) {
          if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
            outputs[output.OutputKey] = output.OutputValue;
          }
        }

        return {
          status: stack.StackStatus,
          ...(stack.StackStatusReason !== undefined
            ? { statusReason: stack.StackStatusReason }
            : {}),
          outputs,
        };
      } catch {
        return null;
      }
    },

    async describeStackOutcome(stackName: string): Promise<StackDescribeOutcome> {
      try {
        const response = (await client.send(
          new DescribeStacksCommand({ StackName: stackName }),
        )) as {
          Stacks?: {
            StackStatus?: string;
            StackStatusReason?: string;
            Outputs?: { OutputKey?: string; OutputValue?: string }[];
          }[];
        };

        const stack = response.Stacks?.[0];
        if (!stack?.StackStatus) return { found: false, absent: true };

        const outputs: Record<string, string> = {};
        for (const output of stack.Outputs ?? []) {
          if (output.OutputKey !== undefined && output.OutputValue !== undefined) {
            outputs[output.OutputKey] = output.OutputValue;
          }
        }

        return {
          found: true,
          stack: {
            status: stack.StackStatus,
            ...(stack.StackStatusReason !== undefined
              ? { statusReason: stack.StackStatusReason }
              : {}),
            outputs,
          },
        };
      } catch (err) {
        const errorCode = err instanceof Error ? err.name : undefined;
        if (errorCode === 'ValidationError' && /does not exist/i.test(message(err))) {
          return { found: false, absent: true };
        }
        return {
          found: false,
          absent: false,
          ...(errorCode !== undefined ? { errorCode } : {}),
        };
      }
    },

    async describeStackEvents(stackName: string): Promise<StackFailureEvent[]> {
      const events: StackFailureEvent[] = [];
      let nextToken: string | undefined;
      let pages = 0;
      try {
        do {
          const response = (await client.send(
            new DescribeStackEventsCommand({
              StackName: stackName,
              ...(nextToken !== undefined ? { NextToken: nextToken } : {}),
            }),
          )) as {
            StackEvents?: {
              LogicalResourceId?: string;
              ResourceType?: string;
              ResourceStatus?: string;
              ResourceStatusReason?: string;
              Timestamp?: Date;
            }[];
            NextToken?: string;
          };

          for (const event of response.StackEvents ?? []) {
            if (
              event.ResourceStatus === 'CREATE_FAILED' &&
              event.LogicalResourceId !== undefined &&
              event.ResourceType !== undefined &&
              event.ResourceStatusReason !== undefined
            ) {
              events.push({
                logicalResourceId: event.LogicalResourceId,
                resourceType: event.ResourceType,
                resourceStatusReason: event.ResourceStatusReason,
                timestamp: (event.Timestamp ?? new Date(0)).toISOString(),
              });
            }
          }
          nextToken = response.NextToken;
          pages += 1;
        } while (nextToken !== undefined && pages < MAX_EVENT_PAGES);
      } catch {
        // Events are enrichment, not the source of truth — an unreadable
        // page falls back to whatever was collected so far (possibly none).
        return events;
      }
      return events;
    },
  };
}

/** Cap on `DescribeStackEvents` pages — enrichment, not exhaustive audit. */
const MAX_EVENT_PAGES = 5;

/** Production installer — credentials come from the standard SDK chain. */
export function createStackInstaller(region?: string): StackInstaller {
  return toInstaller(new CloudFormationClient(region === undefined ? {} : { region }));
}
