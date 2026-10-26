/**
 * Relay poll loop — fetch commands from the control plane, execute them,
 * and report results back.
 *
 * The relay is egress-only: it calls OUT to the control plane; the control
 * plane never reaches INTO the customer account. Each poll cycle:
 *
 *   1. Authenticate (register on first contact, then bearer token)
 *   2. Finish and report anything an earlier cycle deferred
 *   3. Fetch pending commands for this installation
 *   4. Execute each command (with idempotency)
 *   5. Report results + observed state back to the control plane (§59)
 *
 * Step 2 exists because not every command fits in one invocation. An
 * INSTALL that is still creating its stack when the Lambda has to return is
 * reported to nobody and picked up again here on the next tick — the
 * control plane never re-offers a job it has already handed out, so the
 * relay is the only thing that can remember it.
 */

import {
  RELEASE_EVIDENCE_VERSION,
  type FailureEvidence,
  type RelayCommandProgress,
  type ReleaseEvidence,
  type ServiceEvidence,
} from '@deployz/contracts';

import type { RelayCommand, RelayCommandResult } from './commands.js';
import { dispatchCommand, IdempotencyStore, type CommandExecutor } from './commands.js';
import {
  buildAuthHeaders,
  decrementGrace,
  processRotationResponse,
  registerInstallation,
  type AuthState,
  type FetchFn,
} from './auth.js';
import type { RuntimeHealth } from './ecs-health.js';
import { singleDigest, type ServiceDigests } from './ecs-observe.js';
import type { HttpProbeRecord } from './http-probe.js';
import type { VerificationResult } from './verify.js';
import { fetchWithRetry, type SleepFn } from './retry.js';

// ── Control-plane API shapes ─────────────────────────────────────────────────

/** One workload seat the control plane names for verification (Phase 4A). */
export interface DeploymentWorkload {
  readonly id: string;
  readonly serviceLogicalId: string;
}

/** One verification-contract check outside the fixed catalog (Phase 5). */
export interface DeploymentResourceCheck {
  readonly componentId: string;
  readonly check: string;
  readonly logicalId: string;
  readonly resourceType: string;
}

/** Response from GET /api/relay/commands */
interface PendingCommandsResponse {
  commands: RelayCommand[];
  /**
   * Deployment facts the control plane passes along every poll — the only
   * channel that reaches the observe hooks, which run outside any command.
   */
  deployment?: {
    redisRequired?: boolean;
    databaseRequired?: boolean;
    probeUrl?: string | null;
    workloads?: unknown;
    resourceChecks?: unknown;
  };
}

/** Payload for POST /api/relay/commands/:id/result */
interface CommandReportPayload {
  commandId: string;
  idempotencyKey: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: string;
  failureCode?: string;
  evidence?: FailureEvidence;
}

/** Payload for POST /api/relay/health (§59 desired-vs-observed) */
interface HealthReportPayload {
  installationId: string;
  observedState: Record<string, unknown>;
  /** What is actually running in ECS, when it could be observed. */
  runningImageDigest?: string | null;
  /** Measured runtime health, when the observation ran. */
  healthStatus?: string;
  components?: Record<string, unknown>;
  /** Relay identity, re-reported every heartbeat so the control plane can
   *  self-repair missing account ids and refresh version/capabilities. */
  identity?: Record<string, unknown>;
}

// ── Poll context ─────────────────────────────────────────────────────────────

/** Injectable dependencies for the poll loop (seam for testing). */
export interface PollDependencies {
  fetchFn: FetchFn;
  /** Waits between retries of a result report; tests inject an instant one. */
  sleep?: SleepFn;
  controlPlaneUrl: string;
  installationId: string;
  /** Single-use code from the bootstrap stack; identifies the deployment. */
  enrollmentCode: string;
  executors: Readonly<Record<string, CommandExecutor>>;
  idempotency: IdempotencyStore;
  /**
   * §59 observed state. Optional so the poll loop stays usable without AWS —
   * when it is absent, or throws, `infraHealth` stays null rather than
   * reporting a healthy-looking absence of information.
   */
  observe?: () => Promise<VerificationResult>;
  /**
   * Finishes work an earlier poll deferred, and returns the results that
   * are now ready to report.
   *
   * The control plane moves a job to `RUNNING` the moment it hands it out
   * and never offers it again, so a command the relay could not finish
   * inside one invocation has to be picked back up from the relay's own
   * durable record of it. This is where that happens. Returning an empty
   * array means "nothing owed, or still not finished".
   */
  resume?: () => Promise<RelayCommandResult[]>;
  /**
   * Called after EVERY result report attempt — from the resume loop and the
   * executor loop alike — with whether the control plane accepted it (2xx).
   * A throwing hook is swallowed: reporting bookkeeping must never break a
   * poll.
   */
  readonly onResultReported?: (result: RelayCommandResult, reported: boolean) => Promise<void>;
  /** Reported at enrollment and on every heartbeat (see identity.ts). */
  identity?: Record<string, unknown>;
  /**
   * The customer is updating the bootstrap stack: fetch the deployment facts
   * but claim no commands (`claim=0`). Resume and heartbeats continue.
   */
  pauseClaims?: boolean;
  /** Observes the image digest actually running in ECS; null = unknown. */
  observeImage?: () => Promise<string | null>;
  /**
   * Observes the digests running in each ECS service. Feeds the release
   * evidence; also the running image digest when `observeImage` is absent.
   */
  observeServiceDigests?: () => Promise<ServiceDigests[] | null>;
  /** Measures runtime health (ECS counts, target health, rollout state). */
  observeHealth?: () => Promise<RuntimeHealth>;
  /**
   * Probes the application's configured health path over HTTP once per poll,
   * recording status code/latency/timestamps — never a response body (see
   * ./http-probe.ts). Null means "no probe was possible this poll" (no
   * endpoint configured), which omits httpProbe from the heartbeat rather
   * than reporting a healthy-looking absence of information.
   */
  observeProbe?: () => Promise<HttpProbeRecord | null>;
  /**
   * Receives the deployment facts the commands response carries, before the
   * cycle's health observation runs — the observe hooks read them to know
   * whether the installation should include a cache and what URL to probe.
   * `workloads` carries the deployment's per-workload service seats when the
   * control plane has them (an older control plane omits the key).
   */
  onDeploymentMeta?: (meta: {
    redisRequired: boolean;
    databaseRequired?: boolean;
    probeUrl: string | null;
    workloads?: readonly DeploymentWorkload[];
    /** Phase 5: verification-contract checks outside the fixed catalog. */
    resourceChecks?: readonly DeploymentResourceCheck[];
  }) => void;
}

/**
 * Defensively validate the control plane's per-workload list: an array of
 * `{ id, serviceLogicalId }` string pairs. Anything else reads as "not
 * provided" — an old or malformed control plane must not crash a heartbeat.
 */
function readDeploymentWorkloads(raw: unknown): DeploymentWorkload[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const workloads: DeploymentWorkload[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const id = (entry as Record<string, unknown>)['id'];
    const serviceLogicalId = (entry as Record<string, unknown>)['serviceLogicalId'];
    if (typeof id !== 'string' || id.length === 0) return undefined;
    if (typeof serviceLogicalId !== 'string' || serviceLogicalId.length === 0) return undefined;
    workloads.push({ id, serviceLogicalId });
  }
  return workloads;
}

/**
 * Defensively validate the control plane's generic resource-check list
 * (Phase 5): an array of `{ componentId, check, logicalId, resourceType }`
 * string quadruples. Anything else reads as "not provided" — an old or
 * malformed control plane must not crash a heartbeat.
 */
function readDeploymentResourceChecks(raw: unknown): DeploymentResourceCheck[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const resourceChecks: DeploymentResourceCheck[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return undefined;
    const record = entry as Record<string, unknown>;
    const componentId = record['componentId'];
    const check = record['check'];
    const logicalId = record['logicalId'];
    const resourceType = record['resourceType'];
    if (typeof componentId !== 'string' || componentId.length === 0) return undefined;
    if (typeof check !== 'string' || check.length === 0) return undefined;
    if (typeof logicalId !== 'string' || logicalId.length === 0) return undefined;
    if (typeof resourceType !== 'string' || resourceType.length === 0) return undefined;
    resourceChecks.push({ componentId, check, logicalId, resourceType });
  }
  return resourceChecks;
}

/** Result of a single poll cycle. */
export interface PollResult {
  /** Number of commands fetched. */
  fetched: number;
  /** Number of commands executed (including idempotent cache hits). */
  executed: number;
  /** Number of commands that succeeded. */
  succeeded: number;
  /** Number of commands that failed. */
  failed: number;
  /** Commands started but not finished — no result reported for these. */
  deferred: number;
  /** Results for earlier-deferred commands that finished since the last poll. */
  resumed: number;
  /** Commands handed back unexecuted because another service mutation was still in flight. */
  released?: number;
  /** Whether the poll completed without transport errors. */
  ok: boolean;
  /** Error message if the poll itself failed (not individual commands). */
  error?: string;
  /** Set when retrying cannot help — the caller should stop, not back off. */
  fatal?: boolean;
}

// ── Poll loop ────────────────────────────────────────────────────────────────

/**
 * Execute one poll cycle: fetch pending commands, execute them, report results.
 *
 * On first contact (authState.registered === false), registers the installation
 * with the control plane before fetching commands.
 */
export async function pollOnce(
  deps: PollDependencies,
  authState: AuthState,
): Promise<PollResult> {
  const { fetchFn, controlPlaneUrl, installationId, enrollmentCode, executors, idempotency, observe, resume, identity, observeImage, observeHealth, observeProbe, observeServiceDigests } =
    deps;

  // ── 1. Enroll on first contact ────────────────────────────────────────
  if (!authState.registered) {
    const result = await registerInstallation(
      fetchFn,
      controlPlaneUrl,
      installationId,
      authState.token,
      enrollmentCode,
      identity,
    );
    if (result !== 'registered') {
      return {
        fetched: 0,
        executed: 0,
        succeeded: 0,
        failed: 0,
        deferred: 0,
        resumed: 0,
        ok: false,
        // A rejection is final: the code is spent by another relay, or it is
        // not a code the control plane knows. The vendor has to reconnect the
        // deployment, which mints a new one — retrying here cannot help.
        error:
          result === 'rejected'
            ? 'Enrollment rejected — this installation is already connected. Ask the vendor to reconnect it.'
            : 'Enrollment could not be completed — will try again on the next poll.',
        ...(result === 'rejected' ? { fatal: true } : {}),
      };
    }
    authState.registered = true;
  }

  const authHeaders = buildAuthHeaders(authState);

  // ── 2. Finish anything an earlier poll deferred ───────────────────────
  //
  // Before asking for new work: a command the relay already owes an answer
  // to is the control plane's oldest open question, and the job it belongs
  // to is sitting in RUNNING until it gets one.
  let resumed = 0;
  if (resume) {
    let finished: RelayCommandResult[] = [];
    try {
      finished = await resume();
    } catch (err) {
      // A resume we could not run is not a reason to skip the whole poll —
      // the pending marker survives, so the next tick tries again.
      console.error(JSON.stringify({ event: 'relay:resume-failed', error: String(err) }));
    }
    for (const result of finished) {
      const reported = await reportCommandResult(fetchFn, controlPlaneUrl, authHeaders, result, deps.sleep);
      await notifyResultReported(deps, result, reported);
      resumed += 1;
    }
  }

  // ── 3. Fetch pending commands ─────────────────────────────────────────
  let commandsResponse: { status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> };

  try {
    commandsResponse = await fetchFn(
      `${controlPlaneUrl}/api/relay/commands?installationId=${encodeURIComponent(installationId)}${deps.pauseClaims ? '&claim=0' : ''}`,
      { headers: authHeaders },
    );
  } catch (err) {
    return {
      fetched: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      resumed,
      ok: false,
      error: `Failed to fetch commands: ${String(err)}`,
    };
  }

  // Check for token rotation signal in response headers.
  processRotationResponse(authState, commandsResponse.headers.get('X-Deployz-New-Token'));

  if (commandsResponse.status !== 200) {
    return {
      fetched: 0,
      executed: 0,
      succeeded: 0,
      failed: 0,
      deferred: 0,
      resumed,
      ok: false,
      error: `Control plane returned HTTP ${commandsResponse.status}`,
    };
  }

  const body = (await commandsResponse.json()) as PendingCommandsResponse;
  const commands = body.commands;
  const workloads = body.deployment ? readDeploymentWorkloads(body.deployment.workloads) : undefined;
  if (body.deployment && typeof body.deployment.redisRequired === 'boolean') {
    const rawProbeUrl = body.deployment.probeUrl;
    const rawDatabaseRequired = body.deployment.databaseRequired;
    const resourceChecks = readDeploymentResourceChecks(body.deployment.resourceChecks);
    deps.onDeploymentMeta?.({
      redisRequired: body.deployment.redisRequired,
      ...(typeof rawDatabaseRequired === 'boolean' ? { databaseRequired: rawDatabaseRequired } : {}),
      probeUrl:
        typeof rawProbeUrl === 'string' &&
        (rawProbeUrl.startsWith('http://') || rawProbeUrl.startsWith('https://'))
          ? rawProbeUrl
          : null,
      ...(workloads !== undefined ? { workloads } : {}),
      ...(resourceChecks !== undefined ? { resourceChecks } : {}),
    });
  }

  if (!Array.isArray(commands) || commands.length === 0) {
    // Still report observed state (§59) on an idle poll — most polls have no
    // commands, and that is exactly when infrastructure drift needs catching.
    await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe, identity, observeImage, observeHealth, observeProbe, observeServiceDigests, workloads);
    decrementGrace(authState);
    return { fetched: 0, executed: 0, succeeded: 0, failed: 0, deferred: 0, resumed, ok: true };
  }

  // ── 4. Execute each command ───────────────────────────────────────────
  let succeeded = 0;
  let failed = 0;
  let deferred = 0;
  let released = 0;
  // Once a service mutation is in flight (deferred), no later command of the
  // batch may mutate the same services: it is handed back, unexecuted, and
  // the control plane offers it again once the first one settled.
  let mutationInFlight = false;

  for (const command of commands) {
    if (mutationInFlight && SERVICE_MUTATING_COMMANDS.has(command.type)) {
      await releaseCommand(fetchFn, controlPlaneUrl, authHeaders, command.id, deps.sleep);
      released += 1;
      continue;
    }
    const result = await dispatchCommand(command, executors, idempotency);

    // A deferred command has been started, not finished. Reporting anything
    // now would settle a job that is still genuinely running: `success:
    // false` marks the deployment FAILED, and `success: true` is the exact
    // unearned Healthy this whole design exists to prevent.
    if (result.deferred) {
      deferred += 1;
      if (SERVICE_MUTATING_COMMANDS.has(command.type)) mutationInFlight = true;
      continue;
    }

    if (result.success) {
      succeeded += 1;
    } else {
      failed += 1;
    }

    // ── 5. Report result back to the control plane ───────────────────
    const reported = await reportCommandResult(fetchFn, controlPlaneUrl, authHeaders, result, deps.sleep);
    await notifyResultReported(deps, result, reported);
  }

  // ── 6. Report observed state (§59) ────────────────────────────────────
  await reportHealth(fetchFn, controlPlaneUrl, authHeaders, installationId, idempotency, observe, identity, observeImage, observeHealth, observeProbe, observeServiceDigests, workloads);

  decrementGrace(authState);

  return {
    fetched: commands.length,
    executed: commands.length - released,
    succeeded,
    failed,
    deferred,
    resumed,
    ...(released > 0 ? { released } : {}),
    ok: true,
  };
}

/** Commands that change the stack or its ECS services — never two at once. */
const SERVICE_MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'INSTALL',
  'DEPLOY_RELEASE',
  'ROLLBACK',
  'RESTART',
  'CONFIG_UPDATE',
  'DESTROY',
  'PURGE',
]);

/**
 * Hand an unexecuted command back to the control plane, which offers it
 * again on a later poll. Best-effort: a command that cannot be handed back
 * stays claimed until the watchdog re-offers it.
 */
async function releaseCommand(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  commandId: string,
  sleep?: SleepFn,
): Promise<void> {
  try {
    const response = await fetchWithRetry(
      fetchFn,
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(commandId)}/release`,
      { method: 'POST', headers: authHeaders },
      sleep,
    );
    console.log(JSON.stringify({ event: 'relay:command-released', commandId, status: response.status }));
  } catch (err) {
    console.error(JSON.stringify({ event: 'relay:command-release-failed', commandId, error: String(err) }));
  }
}

// ── Reporting helpers ────────────────────────────────────────────────────────

async function reportCommandResult(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  result: RelayCommandResult,
  sleep?: SleepFn,
): Promise<boolean> {
  const payload: CommandReportPayload = {
    commandId: result.commandId,
    idempotencyKey: result.idempotencyKey,
    success: result.success,
    ...(result.output ? { output: result.output } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    ...(result.evidence ? { evidence: result.evidence } : {}),
  };

  // The control plane hands a command out once and marks the job RUNNING, so
  // a result that never arrives leaves it there until the watchdog re-offers
  // it. A throttled (429/5xx) or unreachable control plane is retried with
  // backoff; the result route ignores a duplicate for a settled job.
  try {
    const response = await fetchWithRetry(
      fetchFn,
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(result.commandId)}/result`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      sleep,
    );
    if (response.status < 200 || response.status >= 300) {
      console.error(
        JSON.stringify({ event: 'relay:result-report-failed', commandId: result.commandId, status: response.status }),
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error(
      JSON.stringify({ event: 'relay:result-report-failed', commandId: result.commandId, error: String(err) }),
    );
    return false;
  }
}

/**
 * Tell the caller whether a result actually reached the control plane. The
 * hook is best-effort: a throwing callback is logged and swallowed, because
 * the poll's job is to keep reporting, not to fail on bookkeeping.
 */
async function notifyResultReported(
  deps: PollDependencies,
  result: RelayCommandResult,
  reported: boolean,
): Promise<void> {
  try {
    await deps.onResultReported?.(result, reported);
  } catch (err) {
    console.error(
      JSON.stringify({
        event: 'relay:on-result-reported-failed',
        commandId: result.commandId,
        error: String(err),
      }),
    );
  }
}

/**
 * Statuses already logged this container's lifetime — so a control plane
 * stuck returning the same non-2xx does not spam the log on every tick of
 * every in-flight install, while a genuinely new failure mode still gets
 * one line.
 */
const loggedProgressFailureStatuses = new Set<number>();

/**
 * Report a batch of CloudFormation stack events to the control plane, in
 * the same auth/fetch idiom as `reportCommandResult`.
 *
 * Progress is diagnostics, never an input to a lifecycle decision — so
 * unlike `reportCommandResult`, this returns whether the post was accepted
 * rather than swallowing the answer, which is what lets the stack-event
 * collector know whether to advance its cursor. It still never throws: a
 * control plane an older version doesn't recognize this route on (a 404) is
 * tolerated exactly like any other non-2xx.
 */
export async function reportCommandProgress(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  progress: RelayCommandProgress,
): Promise<boolean> {
  try {
    const response = await fetchFn(
      `${controlPlaneUrl}/api/relay/commands/${encodeURIComponent(progress.commandId)}/progress`,
      {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(progress),
      },
    );

    if (response.status >= 200 && response.status < 300) return true;

    if (!loggedProgressFailureStatuses.has(response.status)) {
      loggedProgressFailureStatuses.add(response.status);
      console.error(
        JSON.stringify({ event: 'relay:stack-events-report-failed', status: response.status }),
      );
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * The positive evidence this heartbeat carries for release promotion (see
 * `releaseEvidenceSchema`). One entry per expected workload: a service the
 * relay could not see is `observed: false`, and a digest list it could not
 * read in full is null. Nothing is inferred from a failed observation.
 */
function buildReleaseEvidence(
  runtimeHealth: RuntimeHealth | null,
  serviceDigests: readonly ServiceDigests[] | null,
  workloads: readonly DeploymentWorkload[] | undefined,
  httpProbe: HttpProbeRecord | null,
): ReleaseEvidence {
  const services: ServiceEvidence[] = (
    runtimeHealth?.services ??
    (workloads ?? []).map((workload) => ({
      workloadId: workload.id,
      serviceLogicalId: workload.serviceLogicalId,
      observed: false,
      desiredCount: null,
      runningCount: null,
      rolloutState: null,
      targets: null,
    }))
  ).map((service) => ({
    ...service,
    runningDigests: service.observed
      ? (serviceDigests?.find((entry) => entry.serviceLogicalId === service.serviceLogicalId)?.digests ?? null)
      : null,
  }));
  return {
    version: RELEASE_EVIDENCE_VERSION,
    observedAt: new Date().toISOString(),
    services,
    httpProbe: httpProbe
      ? { ok: httpProbe.ok, status: httpProbe.statusCode, checkedAt: httpProbe.checkedAt }
      : null,
  };
}

async function reportHealth(
  fetchFn: FetchFn,
  controlPlaneUrl: string,
  authHeaders: Record<string, string>,
  installationId: string,
  idempotency: IdempotencyStore,
  observe: PollDependencies['observe'],
  identity?: Record<string, unknown>,
  observeImage?: PollDependencies['observeImage'],
  observeHealth?: PollDependencies['observeHealth'],
  observeProbe?: PollDependencies['observeProbe'],
  observeServiceDigests?: PollDependencies['observeServiceDigests'],
  workloads?: readonly DeploymentWorkload[],
): Promise<void> {
  let infraHealth: VerificationResult | null = null;
  if (observe) {
    try {
      infraHealth = await observe();
    } catch {
      // An observation we could not take is not an observation. Leaving this
      // null is honest; substituting a default would not be.
      infraHealth = null;
    }
  }

  // A digest observation failing must not fail the health report — the rest
  // of the payload is still true. null means "not observed", never a guess.
  let serviceDigests: ServiceDigests[] | null = null;
  if (observeServiceDigests) {
    try {
      serviceDigests = await observeServiceDigests();
    } catch {
      serviceDigests = null;
    }
  }
  let runningImageDigest: string | null = singleDigest(serviceDigests);
  if (observeImage) {
    try {
      runningImageDigest = await observeImage();
    } catch {
      runningImageDigest = null;
    }
  }

  // Same rule for the health observation: a failure reports UNKNOWN rather
  // than sinking the heartbeat.
  let runtimeHealth: RuntimeHealth | null = null;
  if (observeHealth) {
    try {
      runtimeHealth = await observeHealth();
    } catch {
      runtimeHealth = null;
    }
  }

  // A probe that could not run is omitted, never reported healthy — the
  // control plane only ever sees the probe the relay actually took.
  let httpProbe: HttpProbeRecord | null = null;
  if (observeProbe) {
    try {
      httpProbe = await observeProbe();
    } catch {
      httpProbe = null;
    }
  }

  const observedState: Record<string, unknown> = {
    idempotencyKeysTracked: idempotency.size,
    lastPoll: new Date().toISOString(),
    runningImageDigest,
    observedConfig: null,
    infraHealth,
    ...(runtimeHealth
      ? {
          desiredCount: runtimeHealth.desiredCount,
          runningCount: runtimeHealth.runningCount,
          unhealthyTargetCount: runtimeHealth.unhealthyTargetCount,
          pendingTargetCount: runtimeHealth.pendingTargetCount,
          unknownTargetCount: runtimeHealth.unknownTargetCount,
          deploymentRolloutState: runtimeHealth.deploymentRolloutState,
        }
      : {}),
    ...(httpProbe ? { httpProbe } : {}),
    ...(observeHealth || observeServiceDigests
      ? { releaseEvidence: buildReleaseEvidence(runtimeHealth, serviceDigests, workloads, httpProbe) }
      : {}),
  };

  const payload: HealthReportPayload = {
    installationId,
    observedState,
    runningImageDigest,
    ...(runtimeHealth
      ? { healthStatus: runtimeHealth.healthStatus, components: runtimeHealth.components }
      : {}),
    ...(identity ? { identity } : {}),
  };

  try {
    await fetchFn(`${controlPlaneUrl}/api/relay/health`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Best-effort health reporting.
  }
}