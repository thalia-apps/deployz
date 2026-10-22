/**
 * Resilience-boundary scenarios (deployment-resilience plan, Phase 16):
 * duplicate requests, transient AWS errors and a relay dying mid-DESTROY —
 * each driven through the REAL vendor API routes and the REAL relay
 * executors over the simulated account, like every other scenario spec.
 *
 * Reconciliation-watchdog behaviour (stale RUNNING jobs re-offered/parked)
 * lives in packages/cdk/test/worker.test.ts: the sweeps run in the worker
 * Lambda, which this harness deliberately does not boot — the sweep
 * functions are exercised directly there over the same PGlite migrations.
 */

import type { APIRequestContext } from '@playwright/test';

import { API_URL, expect, expectPlanMatchesInventory, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { fixtureSha } from './fixture-sha.js';

interface DeploymentResponse {
  state: string;
  applicationId: string;
  currentReleaseId: string | null;
}

interface EventRow {
  eventType: string;
  releaseId: string | null;
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
  return ((await response.json()) as { id: string }).id;
}

test.describe.configure({ mode: 'parallel' });

test.describe('duplicate-request', () => {
  test.use({ deployzScenario: 'happy-path' });

  test('@scenario:duplicate-request concurrent duplicate deploys collapse to one job; a different release is refused busy', async ({
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

    const releaseId = await createRelease(request, installed.applicationId, '1.0.0');

    // Create the other release BEFORE the concurrent deploys so the busy
    // check can fire immediately when state is UPDATING (the simulated relay
    // settles a deploy in under a poll cycle).
    const otherReleaseId = await createRelease(request, installed.applicationId, '1.1.0');

    // Two requests for the SAME release racing each other: both are answered
    // (202 created / 200 replayed), both name the same job, and exactly one
    // deploy.requested event exists — one logical operation, one execution.
    // A DIFFERENT release fires CONCURRENTLY with the pair: the simulated
    // relay settles a deploy in under a poll cycle (~25ms), so a sequential
    // busy check cannot catch the window deterministically — fired together,
    // the busy gate refuses while the first job is still the deployment's
    // only active operation (route fast path, backed by the exclusivity
    // index).
    const [first, second, busy] = await Promise.all([
      request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } }),
      request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } }),
      request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: otherReleaseId },
      }),
    ]);
    expect([first.status(), second.status()].sort()).toEqual([200, 202]);
    const firstJob = ((await first.json()) as { jobId: string }).jobId;
    const secondJob = ((await second.json()) as { jobId: string }).jobId;
    expect(firstJob).toBe(secondJob);
    expect(busy.status()).toBe(409);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe('DEPLOYMENT_BUSY');

    // The one deploy settles normally. v1 is promoted (newest READY at that
    // moment), but 1.1.0 was already authored and is READY and newer — so the
    // truthful settled state is UPDATE_AVAILABLE, not HEALTHY (DZ-AUDIT-007).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the deploy to settle',
      })
      .toBe('UPDATE_AVAILABLE');
    // Only this release's events: the post-install auto-deploy has its own.
    const events = (await getEvents(request, deploymentId)).filter((e) => e.releaseId === releaseId);
    expect(events.filter((e) => e.eventType === 'deploy.requested')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'deploy.completed')).toHaveLength(1);
  });
});

test.describe('transient-aws', () => {
  test.use({ deployzScenario: 'transient-aws' });

  test('@scenario:transient-aws an install rides out transient unreadable DescribeStacks polls', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // The first two post-create describes answer as unreadable (throttled) —
    // the executor rides them out and the install still lands HEALTHY.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the install to ride out the transient errors and reach HEALTHY',
      })
      .toBe('HEALTHY');

    // Only at the recovered-HEALTHY checkpoint — the inventory may be
    // unavailable mid-failure, so the dead-relay transient states below are
    // deliberately not asserted.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'resilience-recovered' });
  });
});

test.describe('relay-death-destroy', () => {
  test.use({
    deployzScenario: 'retained-resources',
    deployzRelayOptions: { dieDuringDestroy: true },
  });

  test('@scenario:relay-death-destroy a relay dying mid-DESTROY leaves an honest DELETING, never a false DELETED or FAILED', async ({
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

    const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, {
      data: {},
    });
    expect(destroy.status()).toBe(202);

    // The teardown genuinely starts in the account, but the invocation
    // dies mid-command — no progress, no result, no heartbeat, ever.
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'destroy.requested');
        },
        { timeout: 15_000, message: 'waiting for the destroy to be requested' },
      )
      .toBe(true);

    // Give the harness enough real time that a false settlement WOULD have
    // landed (the whole retained-resources destroy timeline spans well under
    // this), then pin the honest state: still DELETING — the watchdog never
    // times a DESTROY out, and nothing fabricates a completion the relay
    // never reported. Force-complete (gated on a 60-minute staleness window
    // production-side) is the vendor's escape hatch beyond this point.
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'destroy.completed')).toBe(false);
    expect(events.some((e) => e.eventType === 'destroy.failed')).toBe(false);

    const after = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(after.state).toBe('DELETING');

    // The vendor force-complete gate refuses because the relay is still
    // connected (dieDuringDestroy leaves the last heartbeat intact, so
    // relayStatus stays CONNECTED) — see DZ-AUDIT-038 for the gate spec.
    const forceCompleteResp = await request.post(
      `${API_URL}/api/deployments/${deploymentId}/disconnect/force-complete`,
      { data: {} },
    );
    expect(forceCompleteResp.status()).toBe(409);
    const fcBody = (await forceCompleteResp.json()) as { error: { code: string } };
    expect(['RELAY_NOT_OFFLINE', 'DESTROY_NOT_STALE']).toContain(fcBody.error.code);

    // The deployment stays honestly DELETING — the force-complete refusal
    // did not accidentally settle anything.
    const stillDeleting = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(stillDeleting.state).toBe('DELETING');
  });
});

// ── Item 5: force-complete via repeated DESTROY failures ─────────────────────
test.describe('force-complete-repeated-failures', () => {
  test.use({ deployzScenario: 'delete-failure' });

  test('@scenario:force-complete-repeated-failures force-complete is gated on staleness; the honest gate refuses in the simulated window', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, { timeout: 15_000 })
      .toBe('HEALTHY');
    // HEALTHY lands before the post-install auto-deploy settles; a DESTROY in
    // that window is correctly refused 409 by operation exclusivity.
    await waitForInstallAutoDeploy(api, deploymentId);

    // First DESTROY → FAILED (delete-failure outcome).
    const destroy1 = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
    expect(destroy1.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for first destroy to report FAILED',
      })
      .toBe('FAILED');

    // Second DESTROY from FAILED: the relay is connected so it should work.
    // The relay's destroy executor will run again → fails again → FAILED.
    const destroy2 = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
    expect(destroy2.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for second destroy to settle',
      })
      .toBe('FAILED');

    // Two FAILED DESTROY jobs exist now. The force-complete route requires
    // DESTROY_PENDING_STALE_AFTER_MS (60 min) to have elapsed — in the
    // simulated window this cannot pass, proving the honest gate.
    const forceCompleteResp = await request.post(
      `${API_URL}/api/deployments/${deploymentId}/disconnect/force-complete`,
      { data: {} },
    );
    expect(forceCompleteResp.status()).toBe(409);
    const fcBody = (await forceCompleteResp.json()) as { error: { code: string } };
    expect(fcBody.error.code).toBe('DESTROY_NOT_STALE');

    // The deployment stays FAILED — force-complete refused and nothing changed.
    const stillFailed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(stillFailed.state).toBe('FAILED');
  });
});
