/**
 * Simulated relay harness — runs the REAL relay code (`pollOnce`, the real
 * INSTALL executor, real `verifyInstallation`, real provisioning-snapshot and
 * stack-event collection, real runtime-health observation) inside the
 * Playwright test process, speaking the real relay HTTP protocol
 * (register/commands/result/progress/health) to the real local API — see
 * docs/testing/simulated-e2e.md D1.
 *
 * Only the AWS *client* interfaces are replaced, by a `SimulatedCustomerAccount`
 * driven by a `ScenarioDefinition`. Composition below mirrors how
 * `createRelayHandler` (packages/relay/src/index.ts) builds `InstallExecutorDeps`
 * and the observe hook in `createDefaultInstallDeps`/`relayHandler` — reusing
 * the relay's own exported composition helpers (`createInstallExecutor`,
 * `createObserveHook`, `verifyInstallation`, `buildProvisioningSnapshot`,
 * `listAllStackResources`, `observeRuntimeHealth`, `installApplicationStack`,
 * `createStackEventCollector`, `pollOnce`) rather than reimplementing them.
 *
 * Two differences from production wiring, both required for injection:
 *  - no lazy real-AWS-SDK singletons (`getCloudFormationReader()` etc.) — the
 *    simulated account's adapters are passed directly;
 *  - RESTART used to be unwired (no Phase 1/D2 scenario exercised it); it now
 *    runs the REAL `createRestartExecutor` against the simulated account, so
 *    a multi-workload lifecycle can prove every service is restarted.
 *    INSTALL, DEPLOY_RELEASE, ROLLBACK, RESTART and DESTROY are all real,
 *    composed the same way `createDefaultExecutors`/`relayHandler` compose
 *    them in packages/relay/src/index.ts — real factories, simulated
 *    clients, one shared `PendingStore` across the command types.
 */

import {
  createInstallExecutor,
  createInstallResumer,
  createObserveHook,
  type InstallExecutorDeps,
} from '@deployz/relay';
import {
  createPurgeExecutor,
  createPurgeResumer,
  type AcmPurgeClient,
  type CachePurgeClient,
  type NetworkPurgeClient,
  type PurgeDeps,
  type RdsPurgeClient,
  type S3PurgeClient,
  type SecretsPurgeClient,
} from '@deployz/relay/purge';
import { buildAuthHeaders, createAuthState, type AuthState, type FetchFn } from '@deployz/relay/auth';
import { type CommandExecutor, IdempotencyStore } from '@deployz/relay/commands';
import {
  createConfigUpdateExecutor,
  createConfigUpdateResumer,
  type ConfigUpdateDeps,
  type EffectiveConfigEntry,
} from '@deployz/relay/config-update';
import {
  createEcsDeployExecutor,
  createEcsDeployResumer,
  type EcsDeployDeps,
} from '@deployz/relay/deploy';
import { createRestartExecutor, createRestartResumer } from '@deployz/relay/restart';
import { createDestroyExecutor, createDestroyResumer, type DestroyDeps } from '@deployz/relay/destroy';
import { observeRuntimeHealth } from '@deployz/relay/ecs-health';
import { observeRunningImageDigest, observeServiceDigests } from '@deployz/relay/ecs-observe';
import { installApplicationStack } from '@deployz/relay/install';
import { memoryPendingStore, type PendingCommand, type PendingStore } from '@deployz/relay/pending';
import { pollOnce, reportCommandProgress, type PollDependencies } from '@deployz/relay/poll';
import { buildProvisioningSnapshot } from '@deployz/relay/provision-progress';
import { listAllStackResources } from '@deployz/relay/stack-resources';
import { createStackEventCollector } from '@deployz/relay/stack-events';
import { verifyInstallation } from '@deployz/relay/verify';
import { DEFAULT_APPLICATION_STACK_NAME } from '@deployz/contracts';

import { SimulatedCustomerAccount } from './simulated-account.js';
import type { ScenarioDefinition } from './types.js';

/** The ALB DNS name every simulated CONFIGURE_DOMAIN reports as the routing
 *  target — a fixture-zone hostname the control plane may safely CNAME to. */
const DEFAULT_FIXTURE_ALB_TARGET = 'e2e-alb.deployz-fixture.test';

/**
 * Empty orphan-purge clients for the simulated account. A simulated
 * DESTROY that completed cleanly leaves no modelled orphan RDS / cache /
 * bucket / secret / certificate / VPC behind (the account never materialises
 * them as separate resources), so every ownership list is empty and a PURGE
 * falls straight through to its success path — the same end state a real
 * purge reaches once its sweeps have run. The ownership-verification methods
 * exist so settlePurge compiles and would behave honestly if a future
 * scenario ever modelled retained leftovers.
 */
function emptyPurgeClients(): {
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  secrets: SecretsPurgeClient;
  acm: AcmPurgeClient;
  network: NetworkPurgeClient;
} {
  return {
    rds: {
      async listOwnedInstances() {
        return [];
      },
      async disableDeletionProtection() {},
      async deleteInstance() {},
      async listOwnedSubnetGroups() {
        return [];
      },
      async deleteSubnetGroup() {},
    },
    cache: {
      async listOwnedReplicationGroups() {
        return [];
      },
      async deleteReplicationGroup() {},
    },
    s3: {
      async listOwnedBuckets() {
        return [];
      },
      async emptyBucket() {},
      async deleteBucket() {},
    },
    secrets: {
      async listOwnedSecrets() {
        return [];
      },
      async deleteSecret() {},
    },
    acm: {
      async listOwnedCertificates() {
        return [];
      },
      async deleteCertificate() {},
    },
    network: {
      async listOwnedVpcs() {
        return [];
      },
      async listOwnedSecurityGroups() {
        return [];
      },
      async deleteSecurityGroup() {},
      async listOwnedSubnets() {
        return [];
      },
      async deleteSubnet() {},
      async listOwnedRouteTables() {
        return [];
      },
      async deleteRouteTable() {},
      async listOwnedInternetGateways() {
        return [];
      },
      async detachInternetGateway() {},
      async deleteInternetGateway() {},
      async listOwnedNatGateways() {
        return [];
      },
      async deleteNatGateway() {},
      async deleteVpc() {},
    },
  };
}

/**
 * Scenario-aware purge clients: `emptyPurgeClients()` plus, when the
 * scenario carries a `purge.undeletableBucket`, an S3 client that reports
 * that one tag-owned bucket as owned and always fails to delete it — the
 * deterministic "purge sweep finds a leftover it cannot delete" case. When
 * the scenario carries a `purge.retainedDbInstance` (Phase 4B), the RDS
 * client reports that owned instance + subnet group and records the
 * deletions in `deletedDb` — the engine-agnostic purge path (the same code
 * deletes RDS MySQL and RDS PostgreSQL). Every other scenario gets exactly
 * `emptyPurgeClients()`'s behaviour, unchanged.
 */
function purgeClientsFor(
  scenario: ScenarioDefinition,
  deletedDb: string[],
): {
  rds: RdsPurgeClient;
  cache: CachePurgeClient;
  s3: S3PurgeClient;
  secrets: SecretsPurgeClient;
  acm: AcmPurgeClient;
  network: NetworkPurgeClient;
} {
  const clients = emptyPurgeClients();
  const undeletable = scenario.purge?.undeletableBucket;
  if (undeletable) {
    return {
      ...clients,
      s3: {
        async listOwnedBuckets() {
          return [undeletable.bucketName];
        },
        async emptyBucket() {},
        async deleteBucket() {
          throw new Error(undeletable.failureReason);
        },
      },
    };
  }
  const retained = scenario.purge?.retainedDbInstance;
  if (!retained) return clients;
  let instanceDeleted = false;
  let subnetGroupDeleted = false;
  return {
    ...clients,
    rds: {
      async listOwnedInstances() {
        return instanceDeleted ? [] : [{ identifier: retained.identifier, status: 'available' }];
      },
      async disableDeletionProtection() {},
      async deleteInstance(identifier: string) {
        instanceDeleted = true;
        deletedDb.push(identifier);
      },
      async listOwnedSubnetGroups() {
        return subnetGroupDeleted ? [] : [retained.subnetGroup];
      },
      async deleteSubnetGroup() {
        subnetGroupDeleted = true;
      },
    },
  };
}

/**
 * Extract a named CloudFormation Quick Create parameter from the URL.
 * Mirrors the per-file `extractEnrollmentCode` helpers in e2e/install.spec.ts
 * and e2e/scenario-sweep.spec.ts. The URL fragment (after `#`) carries
 * query params that encode template parameters as `param_Xxx=value`.
 */
export function extractQuickCreateParam(quickCreateUrl: string, paramName: string): string {
  const encoded = encodeURIComponent(paramName);
  const match = quickCreateUrl.match(new RegExp(`param_${encoded}=([^&]+)`));
  if (!match) {
    throw new Error(`No param_${paramName} found in quick-create URL: ${quickCreateUrl}`);
  }
  return decodeURIComponent(match[1]!);
}

/**
 * Fetch install info from the install page and extract the enrollment code +
 * relay credential from the Quick Create URL. The route answers it only to
 * the owner or a vendor member, so the caller passes a session cookie header
 * (docs/customer-access.md). DZ-AUDIT-013: the relay credential is carried
 * inside the URL.
 */
export async function fetchInstallCredentials(
  apiUrl: string,
  installLinkId: string,
  sessionCookie: string,
  fetchFn: FetchFn = globalThis.fetch as unknown as FetchFn,
): Promise<{ enrollmentCode: string; relayCredential: string }> {
  const response = await fetchFn(`${apiUrl}/api/install/${installLinkId}`, {
    headers: { cookie: sessionCookie },
  });
  if (response.status !== 200) {
    throw new Error(`GET /api/install/${installLinkId} -> ${response.status}`);
  }
  const body = (await response.json()) as { quickCreateUrl: string | null; enrollmentCode?: string };
  if (!body.quickCreateUrl) {
    throw new Error(`No quickCreateUrl in install info for ${installLinkId}`);
  }
  const enrollmentCode = extractQuickCreateParam(body.quickCreateUrl, 'EnrollmentCode');
  // DZ-AUDIT-013: relayCredential is present for new deployments, absent
  // for legacy ones (pre-change). For legacy the caller provides its own.
  let relayCredential: string | undefined;
  try {
    relayCredential = extractQuickCreateParam(body.quickCreateUrl, 'RelayCredential');
  } catch {
    // Not present — legacy deployment, caller provides token.
  }
  return { enrollmentCode, relayCredential: relayCredential! };
}

export interface StartSimulatedRelayOptions {
  readonly scenario: ScenarioDefinition;
  /** Base URL of the real local API (e.g. `http://localhost:3001`). */
  readonly apiUrl: string;
  readonly installationId: string;
  readonly enrollmentCode: string;
  /** The relay's bearer token — the server-established relay credential
   *  (DZ-AUDIT-013). The control plane mints this at deployment creation
   *  and delivers it through the Quick Create URL as the RelayCredential
   *  template parameter. The simulated relay presents it exactly like a
   *  real relay reading it from Secrets Manager. */
  readonly relayToken: string;
  /** Real `fetch` by default — the harness speaks the real HTTP protocol. */
  readonly fetchFn?: FetchFn;
  /** Real milliseconds between poll cycles — stands in for the 5-minute
   *  EventBridge schedule, sped way up. Defaults to 100ms. */
  readonly pollTickMs?: number;
  /**
   * Additive knob for the relay-disconnect scenario
   * (./scenarios/relay-disconnect.ts): once the stack-event collector's
   * `report` callback has been called once with a non-empty batch (i.e. the
   * relay has genuinely reported some progress), every subsequent call —
   * including the one that would eventually report the INSTALL job's
   * result — hangs forever instead of completing. This mirrors a relay
   * Lambda whose network died mid-invocation: `installApplicationStack`'s
   * wait loop (packages/relay/src/install.ts) awaits `onPoll` with no
   * timeout, so the whole in-flight `pollOnce()` call simply never resolves,
   * and — because the poll harness below only schedules its next tick after
   * the previous one resolves — no further poll cycle ever runs either.
   * Never resolves/rejects by design; safe because nothing in this harness
   * ever awaits that hung promise except the one poll cycle it belongs to.
   */
  readonly stopAfterFirstProgress?: boolean;
  /**
   * DESTROY-death knob: the relay invocation dies while executing the
   * DESTROY command. The real executor still runs detached — the teardown
   * genuinely starts in the simulated account, exactly like a Lambda whose
   * work reached AWS before the invocation was killed — but the dispatching
   * poll cycle hangs forever, so no result, progress, or heartbeat is ever
   * reported for it and no further poll cycle runs. The control plane must
   * keep the deployment honestly DELETING (force-complete is the vendor's
   * escape hatch), never a false DELETED or FAILED.
   */
  readonly dieDuringDestroy?: boolean;
  /**
   * Additive knob for the Phase 14 reconnection flow (relay reset): when
   * given, the harness runs against this EXISTING `SimulatedCustomerAccount`
   * instead of constructing a fresh one. A re-registered relay is a new
   * process but the SAME customer AWS account — the stack, the ECS service,
   * the registered task definitions and the running digest all persist there,
   * exactly like a real rebuilt relay re-enrolling into the account a first
   * relay already installed into. Without this, a fresh account would forget
   * the completed install and report the stack missing.
   */
  readonly account?: SimulatedCustomerAccount;
  /**
   * Phase 14 custom-domain scenarios: hostnames matching this regex have their
   * CONFIGURE_DOMAIN command FAIL (AWS_PERMISSION_DENIED) instead of being
   * answered, driving the domain machine into ERROR end to end. Every other
   * hostname still follows the healthy two-phase ACM flow below.
   */
  readonly failConfigureForHostnameRegex?: string;
  /**
   * Seed a pending command into the store before the first poll. Used by the
   * stale-install-resurrect scenario to simulate a relay that died mid-install
   * and left a pending marker behind.
   */
  readonly seedPending?: PendingCommand;
  /**
   * Use a custom pending store instead of the default in-memory one. Used by
   * the stale-install-resurrect scenario to ensure a cold start with a fresh
   * store.
   */
  readonly pendingStore?: PendingStore;
}

export interface InstallSettlement {
  readonly succeeded: boolean;
}

/** The outcome of whichever relay job (INSTALL/DEPLOY_RELEASE/ROLLBACK/
 *  DESTROY) most recently settled — additive to `InstallSettlement`/
 *  `waitForResult` (kept INSTALL-only for e2e/scenario-install.spec.ts and
 *  e2e/scenario-provisioning.spec.ts). Latches on the single most-recently
 *  settled job: a caller that lets more than one job run before awaiting may
 *  see an earlier job's result if it hasn't yet awaited since triggering the
 *  one it actually wants — polling `deployment.state` via the real API (as
 *  the existing scenario specs do) sidesteps that ambiguity and is usually
 *  the safer choice for a multi-job lifecycle test. */
export interface JobSettlement {
  readonly type: string;
  readonly succeeded: boolean;
}

export interface SimulatedRelayHandle {
  readonly account: SimulatedCustomerAccount;
  /** RDS instance identifiers the purge sweep deleted (Phase 4B `purge.retainedDbInstance` knob). */
  readonly purgeDeletedDb: string[];
  /** Stops the poll-cycle timer. Safe to call more than once. */
  stop(): void;
  /** Resolves once a poll cycle has reported a non-deferred INSTALL result. */
  waitForResult(): Promise<InstallSettlement>;
  /** Resolves with the most recently settled job of ANY type — see
   *  `JobSettlement`'s doc comment above for its latching caveat. */
  waitForLatestResult(): Promise<JobSettlement>;
}

export function startSimulatedRelay(options: StartSimulatedRelayOptions): SimulatedRelayHandle {
  const { scenario, apiUrl, installationId, enrollmentCode, relayToken } = options;
  const fetchFn = options.fetchFn ?? (globalThis.fetch as unknown as FetchFn);
  const pollTickMs = options.pollTickMs ?? 100;

  const account = options.account ?? new SimulatedCustomerAccount(scenario);
  const authState: AuthState = createAuthState(installationId, relayToken);
  const idempotency = new IdempotencyStore();

  // Refreshed every poll from GET /api/relay/commands' `deployment` meta —
  // same role as `deploymentMeta` in packages/relay/src/index.ts. Phase 2:
  // both start UNKNOWN (`undefined`), never a guessed default. Phase 4A:
  // the per-workload service seats ride the same meta once the control
  // plane sends them.
  let redisRequired: boolean | undefined = undefined;
  let databaseRequired: boolean | undefined = undefined;
  let probeUrl: string | null = null;
  let deploymentWorkloads: readonly { id: string; serviceLogicalId: string }[] | undefined = undefined;
  /** Phase 5: verification-contract checks outside the fixed catalog (queue,
   *  schedule, ...) — mirrors `deploymentMeta.resourceChecks` in
   *  packages/relay/src/index.ts's production observe-hook wiring. */
  let deploymentResourceChecks:
    | readonly { componentId: string; check: string; logicalId: string; resourceType: string }[]
    | undefined = undefined;

  const stackNameOrDefault = (): string => account.stackName ?? DEFAULT_APPLICATION_STACK_NAME;

  // See `stopAfterFirstProgress` doc comment above.
  let hasReportedProgress = false;
  let silenced = false;


  // One shared PendingStore across INSTALL/DEPLOY_RELEASE/ROLLBACK/DESTROY —
  // mirrors production's single installationId-keyed store
  // (packages/relay/src/index.ts's `getPendingStore`), and is what lets the
  // `resume` composition below peek a still-pending command's `type` before
  // its own resumer clears it.
  const pending = options.pendingStore ?? memoryPendingStore();

  // Two-phase ACM issuance bookkeeping, keyed by lowercased hostname: each
  // hostname is first answered PENDING_VALIDATION (with the records the
  // control plane must write) and, on a later configure round, ISSUED.
  const issuedHostnames = new Set<string>();

  const installDeps: InstallExecutorDeps = {
    installationId,
    // The install template URL itself rides each INSTALL command's payload
    // (settleInstall consumes `payload.templateUrl` and fails closed without
    // it) — the harness injects the simulated artifact URL at that seam in
    // `installExecutor` below, so no fabricated URL is wired into deps.
    // The collector's `operationStartedAt` boundary and the pending marker's
    // `startedAt` — both read off the account's own virtual clock so every
    // event this scenario ever reveals timestamps at or after it.
    now: () => account.operationStartedAtIso(),
    install: (request) =>
      installApplicationStack({
        ...request,
        installer: account.stackInstaller(),
        // Fast wait-loop tick, generous budget — installs settle inside one
        // invocation for every scenario this harness plays today.
        pollIntervalMs: 25,
        budgetMs: 30_000,
      }),
    verify: (request) => verifyInstallation({ ...request, cfn: account.cloudFormationReader() }),
    checkAuthority: async (commandId) => {
      try {
        const res = await fetchFn(`${apiUrl}/api/relay/commands/${encodeURIComponent(commandId)}/authority`, { headers: buildAuthHeaders(authState) });
        if (res.status !== 200) return null;
        const body = (await res.json()) as { active?: unknown };
        return body.active === true;
      } catch {
        return null;
      }
    },
    pending,
    createStackEventCollector: ({ commandId, operationStartedAt, stackName, resumeAfter }) =>
      createStackEventCollector({
        reader: account.stackEventsReader(),
        report: (events) => {
          if (silenced) {
            // Gone silent — never resolves. See `stopAfterFirstProgress`.
            return new Promise<boolean>(() => {});
          }
          const reported = reportCommandProgress(fetchFn, apiUrl, buildAuthHeaders(authState), {
            commandId,
            installationId,
            stackName,
            events: [...events],
          });
          if (options.stopAfterFirstProgress && !hasReportedProgress) {
            hasReportedProgress = true;
            silenced = true;
          }
          return reported;
        },
        operationStartedAt,
        ...(resumeAfter !== undefined ? { resumeAfter } : {}),
      }),
  };

  // The DEPLOY_RELEASE/ROLLBACK write seam — `createEcsDeployExecutor` is
  // shared between the two command types exactly like production's
  // `createDefaultExecutors` (packages/relay/src/index.ts): "the only
  // difference is which release the control plane derived the payload from."
  // `stackName` is a getter so it always reads whatever `account.stackName`
  // ends up being once INSTALL creates the stack, even though `deployDeps` is
  // built before that happens.
  const deployDeps: EcsDeployDeps = {
    cfn: account.cloudFormationReader(),
    ecs: account.ecsDeployClient(),
    elb: account.targetHealthReader(),
    pending,
    installationId,
    get stackName() {
      return stackNameOrDefault();
    },
    // The simulated CONFIG_UPDATE below applies nothing, so a first start
    // has no configuration to wait for.
    unappliedConfiguration: async () => [],
  };

  // The real CONFIG_UPDATE executor over the simulated account. The
  // application config secret is an in-memory JSON document; the effective
  // configuration comes from the control plane's authenticated relay channel.
  const configSecrets: Record<string, string> = {};
  const configDeps: ConfigUpdateDeps = {
    cfn: account.cloudFormationReader(),
    ecs: account.ecsDeployClient(),
    elb: account.targetHealthReader(),
    pending,
    installationId,
    get stackName() {
      return stackNameOrDefault();
    },
    secrets: {
      async getSecretValue({ SecretId }) {
        return { arn: SecretId, secretString: configSecrets[SecretId] };
      },
      async putSecretValue({ SecretId, secretString }) {
        configSecrets[SecretId] = secretString;
      },
    },
    fetchEffectiveConfig: async () => {
      const response = await fetchFn(
        `${apiUrl}/api/relay/config?installationId=${encodeURIComponent(installationId)}`,
        { headers: buildAuthHeaders(authState) },
      );
      if (response.status !== 200) throw new Error(`Config fetch returned HTTP ${response.status}`);
      return ((await response.json()) as { entries: EffectiveConfigEntry[] }).entries;
    },
  };

  // The DESTROY write seam. `rds`/`cache` are omitted: every lifecycle
  // scenario destroys a deployment that completed a real install, so the
  // control plane always sends `dataDeletionAuthorized: false` (server.ts's
  // destroy route). `retained-delete-recovery` exercises that path's
  // DELETE_FAILED retain-retry end to end — it needs only the reader and
  // the deleter below. The blocker-clearing path the two clients serve is
  // reserved for the explicitly authorized never-installed recovery
  // (packages/relay/src/recover.ts) and stays unreached here.
  const destroyDeps: DestroyDeps = {
    cfn: account.cloudFormationReader(),
    deleter: account.stackDeleter(),
    pending,
    installationId,
    get stackName() {
      return stackNameOrDefault();
    },
    // Phase 5: stop the stack's own cluster's standalone (scheduled-job)
    // tasks before deleting it — see `SimulatedCustomerAccount.
    // ecsStandaloneTaskStopper`.
    ecs: account.ecsStandaloneTaskStopper(),
    now: () => account.destroyStartedAtIso(),
    createStackEventCollector: ({ commandId, operationStartedAt, stackName, resumeAfter }) =>
      createStackEventCollector({
        reader: account.stackEventsReader(),
        report: (events) =>
          reportCommandProgress(fetchFn, apiUrl, buildAuthHeaders(authState), {
            commandId,
            installationId,
            stackName,
            events: [...events],
          }),
        operationStartedAt,
        ...(resumeAfter !== undefined ? { resumeAfter } : {}),
      }),
  };

  // The PURGE write seam — same shared cfn reader and stack-name getter as
  // DESTROY, plus the orphan clients (see `purgeClientsFor` — empty for
  // every scenario except one carrying a `purge` knob). The bootstrap/relay
  // stack is not modelled (CANARY-014: a purge never deletes it — it tells
  // the customer to remove it), so `bootstrapStackName` is a plain
  // identifier that only ever appears in the success output.
  const purgeDeletedDb: string[] = [];
  const purgeDeps: PurgeDeps = {
    cfn: account.cloudFormationReader(),
    deleter: account.stackDeleter(),
    pending,
    installationId,
    get stackName() {
      return stackNameOrDefault();
    },
    bootstrapStackName: `deployz-bootstrap-${installationId}`,
    ...purgeClientsFor(scenario, purgeDeletedDb),
  };

  let settlement: InstallSettlement | null = null;
  let waiters: Array<(result: InstallSettlement) => void> = [];

  const baseInstallExecutor = createInstallExecutor(installDeps);
  const installExecutor: CommandExecutor = async (command) => {
    // The relay executes exactly the compiled-template URL the payload
    // carries and fails closed without one. The local fixture API does not
    // send `templateUrl` yet, so the harness supplies the simulated artifact
    // URL at this boundary — the same stand-in `installDeps.templateUrl`
    // used to provide — and passes through verbatim whatever the control
    // plane itself sends once it does.
    if (typeof command.payload['templateUrl'] !== 'string' || command.payload['templateUrl'] === '') {
      command.payload['templateUrl'] = 'https://simulated-templates.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json';
    }
    const result = await baseInstallExecutor(command);
    if (!result.deferred && settlement === null) {
      settlement = { succeeded: result.success };
      const pendingWaiters = waiters;
      waiters = [];
      for (const waiter of pendingWaiters) waiter(settlement);
    }
    return result;
  };

  // Additive, ANY-job settlement tracking — see `JobSettlement`'s doc
  // comment on `SimulatedRelayHandle`. Wraps every executor (uniform, since
  // `command.type` is always known regardless of the result's shape) and the
  // `resume` composition below (peeking the shared `pending` record's `type`
  // BEFORE its own resumer clears it, since a resumed result carries no
  // `type` of its own).
  let latestSettlement: JobSettlement | null = null;
  let latestWaiters: Array<(result: JobSettlement) => void> = [];
  function recordLatestSettlement(type: string, succeeded: boolean): void {
    latestSettlement = { type, succeeded };
    const pendingWaiters = latestWaiters;
    latestWaiters = [];
    for (const waiter of pendingWaiters) waiter(latestSettlement);
  }
  function trackLatest(executor: CommandExecutor): CommandExecutor {
    return async (command) => {
      const result = await executor(command);
      if (!result.deferred) recordLatestSettlement(command.type, result.success);
      return result;
    };
  }

  const deployExecutor = createEcsDeployExecutor(deployDeps);
  const rawDestroyExecutor = createDestroyExecutor(destroyDeps);
  // See `dieDuringDestroy`: the real executor runs detached (its work still
  // reaches the simulated account), but the dispatching poll cycle never
  // resolves — no result, no heartbeat, no further ticks.
  const destroyExecutor: CommandExecutor = options.dieDuringDestroy
    ? (command) => {
        void rawDestroyExecutor(command).catch(() => {});
        return new Promise<never>(() => {});
      }
    : rawDestroyExecutor;

  const pollDeps: PollDependencies = {
    fetchFn,
    controlPlaneUrl: apiUrl,
    installationId,
    enrollmentCode,
    // Reported at enrollment and on every heartbeat, exactly like a real
    // relay's `readRelayIdentity()` (packages/relay/src/identity.ts) — this
    // harness has no Lambda invocation context to read an account id/region
    // from, but the capabilities are what the control plane gates the
    // vendor dashboard's day-2 action buttons on (deploy/rollback/restart/
    // configUpdate/destroy), so leaving this out entirely (unlike every
    // other real-relay composition point above) silently left every one of
    // those buttons permanently disabled for a simulated install — this
    // mirrors identity.ts's own `RELAY_CAPABILITIES` (all true: this harness
    // runs the real executors for all four, so it genuinely can execute
    // them) rather than importing it, since `@deployz/relay` does not
    // publish an `./identity` subpath.
    identity: {
      relayVersion: '0.2.0',
      capabilities: {
        deployRelease: true,
        rollback: true,
        restart: true,
        configUpdate: true,
        destroy: true,
        domainManagement: true,
      },
    },
    executors: {
      INSTALL: trackLatest(installExecutor),
      DEPLOY_RELEASE: trackLatest(deployExecutor),
      ROLLBACK: trackLatest(deployExecutor),
      // Phase 4A: the REAL restart executor against the simulated account —
      // every workload service gets forceNewDeployment (assertable via the
      // account's `restarts` counter and per-service state).
      RESTART: trackLatest(createRestartExecutor(deployDeps)),
      DESTROY: trackLatest(destroyExecutor),
      // Phase 14: PURGE — the post-DESTROY retained-resource sweep, executed
      // by the same real executor production composes (see the `purgeDeps`
      // comment). Over the simulated account the orphan lists are empty, so a
      // PURGE of a cleanly-deleted deployment settles to success.
      PURGE: trackLatest(createPurgeExecutor(purgeDeps)),
      // The real CONFIG_UPDATE executor: the post-install configuration pass
      // and every vendor/customer configuration change.
      CONFIG_UPDATE: trackLatest(createConfigUpdateExecutor(configDeps)),
      // Phase 11 default HTTPS — the healthy simulated path. When the control
      // plane's automatic default-HTTPS machine is on (Cloudflare config in
      // production, or the DEPLOYZ_DEFAULT_HTTPS_FIXTURE opt-in under the E2E
      // fixture DNS), it mints CONFIGURE_DOMAIN/REMOVE_DOMAIN jobs right after
      // a successful INSTALL. These executors answer them as if ACM had
      // already issued the certificate and the ALB 443 listener were wired,
      // so a scenario exercises the full control-plane state machine
      // (request -> records -> activate -> READY) without modelling ACM's
      // DNS-validation round trips. Off by default in the fixture suite.
      CONFIGURE_DOMAIN: trackLatest(async (command) => {
        const hostname = (command.payload as { hostname?: unknown }).hostname;
        const host = typeof hostname === 'string' ? hostname : '';
        const fullHost = host.toLowerCase();
        const fail =
          typeof hostname === 'string' &&
          options.failConfigureForHostnameRegex !== undefined &&
          new RegExp(options.failConfigureForHostnameRegex).test(fullHost);
        if (fail) {
          return {
            commandId: command.id,
            idempotencyKey: command.idempotencyKey,
            success: false,
            error: 'simulated permission denied for this hostname',
            failureCode: 'AWS_PERMISSION_DENIED',
          };
        }
        // Real ACM over DNS-01 is two-phase: the first describe reports the
        // cert pending DNS validation (with the validation + routing targets
        // the control plane reconciles into the zone), and only a LATER
        // configure round — after the control plane wrote the records — finds
        // it ISSUED with the 443 listener wired. Modelling that faithfully is
        // what makes the default-HTTPS machine pass through WAITING_FOR_DNS
        // and actually WRITE its routing + validation CNAMEs (assertable in
        // the Phase 14 scenarios), instead of shortcutting straight to ISSUED.
        const issued = issuedHostnames.has(fullHost);
        issuedHostnames.add(fullHost);
        return {
          commandId: command.id,
          idempotencyKey: command.idempotencyKey,
          success: true,
          output: issued
            ? {
                certificateArn: `arn:aws:acm:us-east-1:123456789012:certificate/${command.id}`,
                certificateStatus: 'ISSUED',
                routingTarget: DEFAULT_FIXTURE_ALB_TARGET,
                httpsConfigured: true,
              }
            : {
                certificateArn: `arn:aws:acm:us-east-1:123456789012:certificate/${command.id}`,
                certificateStatus: 'PENDING_VALIDATION',
                validationName: `_e2e.${fullHost}`,
                validationValue: '_e2e.acm-validations.aws.',
                routingTarget: DEFAULT_FIXTURE_ALB_TARGET,
                httpsConfigured: false,
              },
        };
      }),
      REMOVE_DOMAIN: trackLatest(async (command) => ({
        commandId: command.id,
        idempotencyKey: command.idempotencyKey,
        success: true,
        output: { removed: true },
      })),
    },
    idempotency,
    // Mirrors createRelayHandler's default observe hook, over the simulated
    // reader instead of the real CloudFormationReader singleton. Phase 2:
    // never assume a database (or its absence) — skip verification entirely
    // until the poll response has supplied both flags.
    observe: createObserveHook(
      () => {
        if (redisRequired === undefined || databaseRequired === undefined) {
          throw new Error('Deployment requirements not yet known — waiting for the control plane');
        }
        return verifyInstallation({
          cfn: account.cloudFormationReader(),
          installationId,
          stackName: stackNameOrDefault(),
          redisRequired,
          databaseRequired,
          ...(deploymentWorkloads !== undefined ? { workloads: deploymentWorkloads } : {}),
          ...(deploymentResourceChecks !== undefined ? { resourceChecks: deploymentResourceChecks } : {}),
        });
      },
      () => buildProvisioningSnapshot(account.cloudFormationReader(), stackNameOrDefault()),
      () =>
        listAllStackResources(account.cloudFormationReader(), stackNameOrDefault()).then((inventory) =>
          inventory ? { ...inventory, observedAt: new Date().toISOString() } : null,
        ),
    ),
    // Mirrors createRelayHandler's default observeImage — reads through the
    // exact same running-task state `ecsDeployClient()` writes, so a
    // heartbeat taken right after a deploy/rollback settles always agrees
    // with what that deploy just did (identity consistency).
    observeImage: () =>
      observeRunningImageDigest(
        { cfn: account.cloudFormationReader(), ecs: account.ecsTaskReader(), installationId },
        stackNameOrDefault(),
      ),
    observeServiceDigests: () =>
      observeServiceDigests(
        { cfn: account.cloudFormationReader(), ecs: account.ecsTaskReader(), installationId },
        stackNameOrDefault(),
      ),
    observeHealth: () =>
      observeRuntimeHealth(
        {
          cfn: account.cloudFormationReader(),
          ecs: account.ecsServiceReader(),
          elb: account.targetHealthReader(),
        },
        stackNameOrDefault(),
        deploymentWorkloads,
      ),
    // Mirrors createRelayHandler's default probe hook: the simulated account
    // serves its app whenever the control plane advertises an endpoint, so a
    // healthy probe record is the identity-consistent answer (never a real
    // HTTP request to a simulated hostname).
    observeProbe: async () =>
      probeUrl === null
        ? null
        : {
            ok: true,
            statusCode: 200,
            latencyMs: 5,
            checkedAt: new Date().toISOString(),
          },
    onDeploymentMeta: (meta) => {
      redisRequired = meta.redisRequired;
      databaseRequired = meta.databaseRequired;
      probeUrl = meta.probeUrl;
      if ('workloads' in meta) deploymentWorkloads = meta.workloads;
      if ('resourceChecks' in meta) deploymentResourceChecks = meta.resourceChecks;
    },
    // Chained the same way `relayHandler`'s default `resume` composes its
    // resumers (packages/relay/src/index.ts): one shared pending store, each
    // resumer only settling its own command type, first non-empty result
    // wins. `pendingBefore` is read BEFORE any resumer runs so its `type` is
    // available even after a resumer clears the record on settling.
    resume: async () => {
      const pendingBefore = await pending.read();
      let results = await createInstallResumer(installDeps)();
      if (results.length === 0) results = await createEcsDeployResumer(deployDeps)();
      if (results.length === 0) results = await createConfigUpdateResumer(configDeps)();
      if (results.length === 0) results = await createRestartResumer(configDeps)();
      if (results.length === 0) results = await createDestroyResumer(destroyDeps)();
      if (results.length === 0) results = await createPurgeResumer(purgeDeps)();
      if (results.length > 0 && pendingBefore) {
        recordLatestSettlement(pendingBefore.type, results[0]!.success);
      }
      return results;
    },
  };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seeded = false;

  async function tick(): Promise<void> {
    if (stopped) return;
    if (!seeded) {
      seeded = true;
      if (options.seedPending) await pending.write(options.seedPending);
    }
    try {
      await pollOnce(pollDeps, authState);
    } catch {
      // Best-effort, same as a real relay invocation — the next tick retries.
    }
    if (!stopped) {
      timer = setTimeout(() => void tick(), pollTickMs);
    }
  }

  void tick();

  return {
    account,
    /** RDS instance identifiers the purge sweep deleted (Phase 4B knob). */
    purgeDeletedDb,
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
    waitForResult(): Promise<InstallSettlement> {
      if (settlement !== null) return Promise.resolve(settlement);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    waitForLatestResult(): Promise<JobSettlement> {
      if (latestSettlement !== null) return Promise.resolve(latestSettlement);
      return new Promise((resolve) => {
        latestWaiters.push(resolve);
      });
    },
  };
}
