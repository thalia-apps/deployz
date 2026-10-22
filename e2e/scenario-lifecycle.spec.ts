/**
 * Phase 1 D2 simulated-infrastructure E2E: lifecycle scenarios (update,
 * rollback, delete) — proves that the REAL relay deploy/rollback/destroy
 * executors (packages/relay/src/deploy.ts, destroy.ts), driven through the
 * REAL vendor API routes (POST releases, POST /deployments/:id/deploy,
 * /rollback, /destroy), produce the honest production behaviour documented
 * in docs/deployment-resilience.md §6 — including where
 * that behaviour is a plain FAILED rather than a false success.
 *
 * Every test installs to HEALTHY first (happy-path-style timeline — see
 * e2e/simulation/scenarios/*.ts, each of which spreads `happyPath` and adds
 * only the lifecycle-specific knobs), then drives the lifecycle entirely
 * through the real HTTP API. No UI yet — that is a later phase. Test titles
 * carry `@scenario:<id>` matching the other scenario specs' convention.
 */

import type { APIRequestContext } from '@playwright/test';

import { API_URL, buildApi, expect, expectPlanMatchesInventory, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';
import { fixtureSha } from './fixture-sha.js';

interface DeploymentResponse {
  state: string;
  healthStatus?: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  applicationId: string;
  cleanupState: string | null;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null; awsStatus: string | null } | null;
  };
}

interface ReleaseResponse {
  id: string;
  version: string;
}

interface InfrastructureResponse {
  summary: { technicalResourceCount: number };
  components: Array<{ kind: string; status: string }>;
  expectations: {
    components: Array<{ kind: string; expected: boolean; present: boolean }>;
    missing: string[];
    unexpected: string[];
  } | null;
}

interface EventRow {
  eventType: string;
  payload?: { error?: string } | null;
}

async function getEvents(request: APIRequestContext, deploymentId: string): Promise<EventRow[]> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId}/events -> ${response.status()}`);
  }
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

async function createRelease(
  request: APIRequestContext,
  applicationId: string,
  version: string,
): Promise<string> {
  const response = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version, gitSha: fixtureSha(version) },
  });
  if (!response.ok()) {
    throw new Error(`create release ${version} failed: ${response.status()} ${await response.text()}`);
  }
  const release = (await response.json()) as ReleaseResponse;
  return release.id;
}

async function deployRelease(request: APIRequestContext, deploymentId: string, releaseId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } });
}

async function rollbackToRelease(request: APIRequestContext, deploymentId: string, releaseId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, { data: { releaseId } });
}

async function destroyDeployment(request: APIRequestContext, deploymentId: string) {
  return request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
}

test.describe.configure({ mode: 'parallel' });

test.describe('update-failure', () => {
  test.use({ deployzScenario: 'update-failure' });

  test('@scenario:update-failure a failed rollout never advances the release pointer', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(api, deploymentId);

    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const applicationId = installed.applicationId;

    // v1 deploys and succeeds — a previous good release now exists.
    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    const deployV1 = await deployRelease(request, deploymentId, v1ReleaseId);
    expect(deployV1.status()).toBe(202);
    // Poll the release POINTER, not the state: this deployment is already
    // HEALTHY when the deploy starts, so polling `state` can return on its
    // very first read and assert the pointer before the deploy has settled.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId, {
        timeout: 15_000,
        message: 'waiting for the v1 deploy to advance the release pointer',
      })
      .toBe(v1ReleaseId);
    const afterV1 = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterV1.state).toBe('HEALTHY');

    // Phase 6 expectation gate after the successful v1 rollout: the
    // inventory still matches the plan.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-update' });

    // UPDATE_AVAILABLE means a newer READY release exists (DZ-AUDIT-007).
    // Fixture-mode builds complete synchronously, so v2 is already READY when
    // creation returns and the flip has fired; the no-flip-while-BUILDING
    // invariant is pinned by the unit suite (lifecycle.test.ts), where the
    // build is genuinely pending.
    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    const afterV2Created = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterV2Created.state).toBe('UPDATE_AVAILABLE');

    // v2 deploys; the ECS deployment circuit breaker trips.
    const deployV2 = await deployRelease(request, deploymentId, v2ReleaseId);
    expect(deployV2.status()).toBe(202);
    const afterDeployV2Requested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterDeployV2Requested.state).toBe('UPDATING');

    // A failed update does NOT mark the whole deployment FAILED: the circuit
    // breaker restored v1, which is still serving. The deployment returns to
    // UPDATE_AVAILABLE (v2 exists, READY, and is not running) and the FAILED
    // job carries the failure.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const failed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    // The stage stays live (READY/VERIFYING, never FAILED) while the failure
    // itself is still surfaced with its real classification.
    expect(failed.deploymentStatus.stage).not.toBe('FAILED');
    expect(failed.deploymentStatus.failure!.code).toBe('ECS_DEPLOYMENT_FAILED');
    // The release pointer never advances past the last release that actually
    // deployed successfully.
    expect(failed.currentReleaseId).toBe(v1ReleaseId);

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'deploy.failed')).toBe(true);
  });
});

test.describe('rollback-success', () => {
  test.use({ deployzScenario: 'rollback-success' });

  test('@scenario:rollback-success rollback recovers a failed update', async ({ request, deployzInstall }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(api, deploymentId);
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const applicationId = installed.applicationId;

    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    await deployRelease(request, deploymentId, v1ReleaseId);
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    // Phase 6 expectation gate after the successful v1 rollout: the
    // inventory still matches the plan.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-update' });

    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    await deployRelease(request, deploymentId, v2ReleaseId);
    // Failed-update semantics: the deployment returns to UPDATE_AVAILABLE
    // (v1 still serving, v2 READY but not running), never FAILED.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const beforeRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(beforeRollback.currentReleaseId).toBe(v1ReleaseId);

    // UPDATE_AVAILABLE is in BULK_DEPLOYABLE_STATES, so `markJobRequested`
    // writes the transient UPDATING in-flight state while the rollback runs.
    const rollbackResponse = await rollbackToRelease(request, deploymentId, v1ReleaseId);
    expect(rollbackResponse.status()).toBe(202);
    const afterRollbackRequested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRollbackRequested.state).toBe('UPDATING');

    // The ROLLBACK job's own event, not a deployment.state transition, is
    // the authoritative "it settled" signal here: the simulated ECS service
    // converges to the rolled-back digest the instant UpdateService succeeds
    // (see simulated-account.ts's `ecsDeployClient`), so a heartbeat between
    // the request and the resumer's own result tick can already report
    // HEALTHY. Polling for a state the job result writes keeps this test
    // pinned to the settlement, not the race.
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'rollback.completed');
        },
        { timeout: 15_000, message: 'waiting for the rollback job to settle' },
      )
      .toBe(true);

    const afterRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    // UPDATE_AVAILABLE is truthful here: v2 is still READY and newer than the
    // running v1 — a rollback is an older-release deployment, and the same
    // newerReadyReleaseExists rule as a plain deploy applies (DZ-AUDIT-007).
    // The vendor can retry v2 from the releases list.
    expect(afterRollback.state).toBe('UPDATE_AVAILABLE');
    expect(afterRollback.deploymentStatus.failure).toBeNull();
    // ROLLBACK success sets currentReleaseId to the rollback's target (v1)
    // and previousReleaseId to whatever currentReleaseId was beforehand —
    // which was ALSO v1, since v2's failed deploy never advanced it. The
    // honest pointer state here is current=v1/previous=v1, not previous=v2.
    expect(afterRollback.currentReleaseId).toBe(v1ReleaseId);
    expect(afterRollback.previousReleaseId).toBe(v1ReleaseId);

    // Phase 6 expectation gate after the completed rollback: the inventory
    // still matches the plan.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-rollback' });
  });
});

test.describe('rollback-failure', () => {
  test.use({ deployzScenario: 'rollback-failure' });

  test('@scenario:rollback-failure a failed rollback reports FAILED, never a false success', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(api, deploymentId);
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const applicationId = installed.applicationId;

    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');
    await deployRelease(request, deploymentId, v1ReleaseId);
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');

    // Phase 6 expectation gate after the successful v1 rollout: the
    // inventory still matches the plan.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-update' });

    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    await deployRelease(request, deploymentId, v2ReleaseId);
    // Failed-update semantics: UPDATE_AVAILABLE, never FAILED (v1 serving).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');

    const beforeRollback = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;

    const rollbackResponse = await rollbackToRelease(request, deploymentId, v1ReleaseId);
    expect(rollbackResponse.status()).toBe(202);

    // The rollback job's own event, not a state transition, is what proves
    // it settled (see rollback-success's comment on the heartbeat race).
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'rollback.completed' || e.eventType === 'rollback.failed');
        },
        { timeout: 15_000, message: 'waiting for the rollback job to settle' },
      )
      .toBe(true);

    // The failed rollback also leaves the deployment live: v1 never stopped
    // serving, so the honest state is UPDATE_AVAILABLE with the FAILED job
    // carrying the classification.
    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).toBe('UPDATE_AVAILABLE');
    expect(after.deploymentStatus.failure!.code).toBe('ECS_DEPLOYMENT_FAILED');
    // Pointers unchanged — the rollback never succeeded, so nothing advances.
    expect(after.currentReleaseId).toBe(beforeRollback.currentReleaseId);
    expect(after.previousReleaseId).toBe(beforeRollback.previousReleaseId);

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'rollback.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'rollback.completed')).toBe(false);
  });
});

test.describe('delete-failure', () => {
  test.use({ deployzScenario: 'delete-failure' });

  test('@scenario:delete-failure an unattributable DELETE_FAILED reports FAILED, never a false clean deletion', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(api, deploymentId);

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);
    const afterRequested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRequested.state).toBe('DELETING');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the destroy to fail',
      })
      .toBe('FAILED');

    // The honest signal this scenario pins: production does NOT claim the
    // deployment was removed. State never reaches DELETED, the job carries
    // the real failure code, and the event log records the failure.
    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).not.toBe('DELETED');
    expect(after.deploymentStatus.failure!.code).toBe('STACK_DELETE_FAILED');

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(false);
  });
});

test.describe('retained-resources', () => {
  test.use({ deployzScenario: 'retained-resources' });

  test('@scenario:retained-resources a clean destroy honestly surfaces retained data resources', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    // Settle the post-install auto-deploy before destroying: it runs with
    // `inFlightState: null`, so the state stays HEALTHY while its
    // DEPLOY_RELEASE job is still active — and requireDeploymentIdle refuses
    // the destroy with 409 DEPLOYMENT_BUSY until that job settles (under
    // full-suite load the HEALTHY poll above regularly wins that race).
    // Waiting for the pointer is the same settle signal the update/rollback
    // tests use before their own mutating calls.
    await waitForInstallAutoDeploy(api, deploymentId);

    // The resource inventory must be persisted BEFORE destroy — it is the
    // only source GET .../infrastructure reads from after deletion (see
    // packages/db/src/deployment-resources-persist.ts: "the last complete
    // snapshot IS the final snapshot").
    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the destroy to complete',
      })
      .toBe('DELETED');

    // aggregateInfrastructureComponents (packages/contracts) re-derives every
    // persisted resource's status from its STATIC lifecycle classification
    // once state is DELETED: retain/snapshot -> 'retained', delete ->
    // 'removed'. RDS/S3 are always classified 'retain' regardless of the
    // actual per-resource delete outcome — this is the same real production
    // behaviour a genuine DeletionPolicy-Retain resource gets.
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    const database = infra.components.find((c) => c.kind === 'database');
    const storage = infra.components.find((c) => c.kind === 'storage');
    const application = infra.components.find((c) => c.kind === 'application');
    expect(database?.status).toBe('retained');
    expect(storage?.status).toBe('retained');
    expect(application?.status).toBe('removed');

    // Phase 6: requirement-aware verification. The application (always
    // required) is 'removed', not 'retained', after a clean destroy — a
    // naive expected-vs-present comparison would read that as "missing", so
    // a DELETED deployment always reports nothing outstanding.
    expect(infra.expectations?.missing).toEqual([]);
    // The full gate: nothing unexpected either, and the surviving inventory
    // still matches the plan (retained kinds stay expected).
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-disconnect-retained' });

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(true);
  });
});

test.describe('purge-failure', () => {
  test.use({ deployzScenario: 'purge-failure' });

  test('@scenario:purge-failure a purge that cannot delete an orphan reports the leftover, never a false clean purge', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    // Settle the post-install auto-deploy first (see retained-resources's
    // comment above): destroy 409s DEPLOYMENT_BUSY while its job is active.
    await waitForInstallAutoDeploy(api, deploymentId);

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the destroy to complete',
      })
      .toBe('DELETED');

    // Same simulated AWS account as retained-resources (see
    // e2e/simulation/scenarios/purge-failure.ts), plus the deterministic
    // orphan the PURGE-sweep finds and cannot delete (see
    // e2e/simulation/relay-harness.ts's `purgeClientsFor`).
    const purgeResponse = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, { data: {} });
    expect(purgeResponse.status()).toBe(202);

    // The honest signal this scenario pins: the purge sweep found an orphan
    // it could not delete, so the control plane must not claim a clean
    // purge (docs/deployment-resilience.md: "a failed purge used to
    // resurrect a DELETED deployment; a purge failure lands on
    // cleanupState: PURGE_FAILED instead, which keeps it retryable").
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).cleanupState, {
        timeout: 15_000,
        message: 'waiting for the purge to fail',
      })
      .toBe('PURGE_FAILED');

    const afterPurge = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    // Never resurrected: the deployment stays DELETED, not FAILED.
    expect(afterPurge.state).toBe('DELETED');
    expect(afterPurge.cleanupState).not.toBe('COMPLETE');

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'purge.failed')).toBe(true);
    expect(events.some((e) => e.eventType === 'purge.completed')).toBe(false);

    // The sweep's own error reaches the event, not a generic "purge failed".
    const failedEvent = events.find((e) => e.eventType === 'purge.failed');
    expect(failedEvent?.payload?.error).toContain('BucketNotEmpty');

    // PURGE_FAILED keeps the purge retryable (docs/deployment-resilience.md).
    const retry = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, { data: {} });
    expect(retry.status()).toBe(202);
  });
});

test.describe('retained-delete-recovery', () => {
  test.use({ deployzScenario: 'retained-delete-recovery' });

  test('@scenario:retained-delete-recovery a DELETE_FAILED destroy recovers via RetainResources — truthful success, then purge clears the retained data', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    // Settle the post-install auto-deploy first (see retained-resources's
    // comment above): destroy 409s DEPLOYMENT_BUSY while its job is active.
    await waitForInstallAutoDeploy(api, deploymentId);

    // The resource inventory must be persisted BEFORE destroy — it is the
    // only source GET .../infrastructure reads from after deletion (see
    // packages/db/src/deployment-resources-persist.ts).
    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);

    const destroyResponse = await destroyDeployment(request, deploymentId);
    expect(destroyResponse.status()).toBe(202);
    const afterRequested = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterRequested.state).toBe('DELETING');

    // DELETE_FAILED on the first attempt (the retained database's cascade),
    // then the relay's data-preserving recovery re-issues the delete with
    // RetainResources and it completes. The DESTROY therefore settles
    // truthfully SUCCEEDED — deployment state DELETED, never FAILED — while
    // the retained resources survive.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the retain-retry destroy to complete',
      })
      .toBe('DELETED');

    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    // The first attempt's failure surfaced nowhere as a FAILED deployment.
    expect(after.deploymentStatus.failure).toBeNull();
    expect(after.cleanupState).toBeNull();

    // Retained window between DESTROY and PURGE: database/storage 'retained',
    // application 'removed' (same static lifecycle classification as
    // retained-resources).
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    const database = infra.components.find((c) => c.kind === 'database');
    const storage = infra.components.find((c) => c.kind === 'storage');
    const application = infra.components.find((c) => c.kind === 'application');
    expect(database?.status).toBe('retained');
    expect(storage?.status).toBe('retained');
    expect(application?.status).toBe('removed');
    expect(infra.expectations?.missing).toEqual([]);
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-disconnect-retained' });

    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(true);
    expect(events.some((e) => e.eventType === 'destroy.failed')).toBe(false);

    // PURGE: the relay sweep removes the retained resources and the
    // deployment's cleanup completes.
    const purgeResponse = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, { data: {} });
    expect(purgeResponse.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).cleanupState, {
        timeout: 15_000,
        message: 'waiting for the purge to complete',
      })
      .toBe('COMPLETE');

    const afterPurge = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(afterPurge.state).toBe('DELETED');

    const purgeEvents = await getEvents(request, deploymentId);
    expect(purgeEvents.some((e) => e.eventType === 'purge.completed')).toBe(true);
    expect(purgeEvents.some((e) => e.eventType === 'purge.failed')).toBe(false);
  });
});

// ── Item 2: Two applications, both releasing '1.0.0', both install to HEALTHY ─
test.describe('two-apps-1.0.0', () => {
  test.describe.configure({ mode: 'serial' });

  test('@scenario:two-apps-1.0.0 two applications each build and deploy release 1.0.0 cleanly (DZ-AUDIT-002)', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // Sign up once.
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `TwoApp Vendor ${suffix}`, email: `e2e-twoapp-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    // Create two applications.
    async function createApp(label: string): Promise<{ id: string; name: string }> {
      const resp = await request.post(`${API_URL}/api/applications`, {
        data: {
          name: `TwoApp ${label} ${suffix}`,
          githubInstallationId: 'e2e-installation',
          repoFullName: `deployz-demo/twoapp-${label}-${suffix}`,
          repoUrl: `https://github.com/deployz-demo/twoapp-${label}-${suffix}`,
          defaultBranch: 'main',
          databaseRequired: false,
        },
      });
      expect(resp.ok()).toBeTruthy();
      const app = (await resp.json()) as { id: string; name: string };
      // Patch manifest fields so readiness passes.
      // Can't have migrationCommand without a database (MANIFEST_NOT_COMPATIBLE).
      const patch = await request.patch(`${API_URL}/api/applications/${app.id}`, {
        data: {
          containerPort: 3000,
          healthPath: '/api/health',
          migrationCommand: null,
          appRoot: '.',
          dockerfilePath: 'Dockerfile',
          buildContext: '.',
          buildCommand: 'npm run build',
          startCommand: 'npm start',
        },
      });
      expect(patch.ok()).toBeTruthy();
      return app;
    }

    const appA = await createApp('A');
    const appB = await createApp('B');

    // Create one customer shared by both (same org).
    const customerResp = await request.post(`${API_URL}/api/customers`, {
      data: { name: `TwoApp Customer ${suffix}`, email: `twoapp-customer-${suffix}@example.com` },
    });
    expect(customerResp.ok()).toBeTruthy();
    const customer = (await customerResp.json()) as { id: string };

    // Release '1.0.0' for both apps.  In BUILD_FIXTURE_MODE the build
    // completes synchronously so the release is READY when creation returns.
    const releaseAResp = await request.post(`${API_URL}/api/applications/${appA.id}/releases`, {
      data: { version: '1.0.0', gitSha: fixtureSha('1.0.0-A') },
    });
    expect(releaseAResp.ok()).toBeTruthy();
    const releaseA = (await releaseAResp.json()) as { id: string };

    const releaseBResp = await request.post(`${API_URL}/api/applications/${appB.id}/releases`, {
      data: { version: '1.0.0', gitSha: fixtureSha('1.0.0-B') },
    });
    expect(releaseBResp.ok()).toBeTruthy();
    const releaseB = (await releaseBResp.json()) as { id: string };

    // Two separate deployments with their own relays.
    async function deployAndInstall(
      appId: string,
      releaseId: string,
      label: string,
    ): Promise<{ deploymentId: string }> {
      const depResp = await request.post(`${API_URL}/api/deployments`, {
        data: { applicationId: appId, customerId: customer.id, region: 'us-east-1' },
      });
      expect(depResp.ok()).toBeTruthy();
      const dep = (await depResp.json()) as { id: string; installLinkId: string; enrollmentCode: string };
      const { id: deploymentId, installLinkId, enrollmentCode } = dep;

      const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
      expect(launch.ok()).toBeTruthy();

      const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
        quickCreateUrl: string | null;
      };
      expect(installInfo.quickCreateUrl).not.toBeNull();
      const { extractQuickCreateParam: eqcp, startSimulatedRelay: ssr } = await import('./simulation/relay-harness.js');
      const { getScenario } = await import('./simulation/scenarios/index.js');

      const relayCred = eqcp(installInfo.quickCreateUrl!, 'RelayCredential');
      const instId = `inst-${suffix}-${label}`;
      const relay = ssr({
        scenario: getScenario('stateless'),
        apiUrl: API_URL,
        installationId: instId,
        enrollmentCode,
        relayToken: relayCred,
      });

      try {
        // Wait for HEALTHY.
        await expect
          .poll(async () => {
            const getResp = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
            if (!getResp.ok()) return null;
            const data = (await getResp.json()) as DeploymentResponse;
            return data.state;
          }, { timeout: 30_000, message: `waiting for deployment ${label} to reach HEALTHY` })
          .toBe('HEALTHY');

        // Deploy 1.0.0.
        const deployResp = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
          data: { releaseId },
        });
        // 202 = new job created; 200 = replayed (same idempotency key already
        // exists, e.g. when the relay picked up the deploy between two poll
        // cycles). Either is a successful acceptance.
        expect([200, 202]).toContain(deployResp.status());

        // Assert the release pointer advances (deploy accepted).
        await expect
          .poll(async () => {
            const getResp = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
            if (!getResp.ok()) return null;
            return ((await getResp.json()) as DeploymentResponse).currentReleaseId;
          }, { timeout: 20_000, message: `waiting for release pointer to advance on ${label}` })
          .toBe(releaseId);

        // The deploy settles: state returns from UPDATING to HEALTHY.
        await expect
          .poll(async () => {
            const getResp = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
            if (!getResp.ok()) return null;
            return ((await getResp.json()) as DeploymentResponse).state;
          }, { timeout: 20_000, message: `waiting for state to return to HEALTHY on ${label}` })
          .toBe('HEALTHY');

        // Phase 6 expectation gate after the successful rollout: the
        // inventory still matches the plan.
        await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-update' });
      } finally {
        relay.stop();
      }

      return { deploymentId };
    }

    await deployAndInstall(appA.id, releaseA.id, 'A');
    await deployAndInstall(appB.id, releaseB.id, 'B');
  });
});
