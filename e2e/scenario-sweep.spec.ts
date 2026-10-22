/**
 * Phase 14 full-lifecycle sweep — ONE continuous test driving ONE deployment
 * through the whole reachable chain, proving the pieces the scenario specs
 * exercise separately actually compose:
 *
 *   analyse → readiness → configuration (enter a value) → install → healthy
 *   → config update (rolled out and settled) → successful update → failed update (previous release
 *   stays live) → rollback → relay reset (disconnect + reconnect) →
 *   day-2 action refused until reconnected → successful update again →
 *   delete → purge.
 *
 * The application is deployz-demo/config-required-app, analysed through the
 * REAL analyser over the fixture tree (GITHUB_FIXTURE_MODE): it is a plain
 * Postgres SaaS app whose code reads LICENSE_KEY with no fallback, so
 * deployment creation refuses MANIFEST_NEEDS_CONFIGURATION until the vendor
 * enters the value — the "enter a value" step is real, not staged. SESSION_SECRET
 * is classified as Deployz-generated (Phase 4) and is never asked for. Deploys
 * carry the analysed migration command, so the relay's Phase 4 migration
 * stage runs for every DEPLOY_RELEASE (and never for a ROLLBACK) — asserted
 * through the simulated account's migration counter.
 *
 * Everything rides the real HTTP API and the real relay executors over the
 * `lifecycle-sweep` scenario definition (see ./simulation/scenarios/
 * lifecycle-sweep.ts). The relay is stopped and re-registered once, through
 * the real `relay/reset` route and a fresh enrollment code read from the
 * install page's Quick Create link — exactly how a rebuilt customer relay
 * reconnects. Without a queue the API runs the CONFIG_UPDATE fan-out
 * inline, so a config change reaches the running deployment through the
 * real relay executor, which settles only once the rollout completed.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, expectPlanMatchesInventory, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';
import { fixtureSha } from './fixture-sha.js';

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  applicationId: string;
  cleanupState: string | null;
  relayStatus: string;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null; message: string; awsStatus: string | null } | null;
  };
  jobs: Array<{ type: string; state: string }>;
}

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  findings: Array<{ id: string; message?: string; plainEnglishExplanation?: string }>;
}

interface ReleaseResponse {
  id: string;
  version: string;
}

interface EventRow {
  eventType: string;
}

async function getDeployment(request: APIRequestContext, deploymentId: string): Promise<DeploymentResponse> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
  }
  return (await response.json()) as DeploymentResponse;
}

async function getEvents(request: APIRequestContext, deploymentId: string): Promise<EventRow[]> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId}/events -> ${response.status()}`);
  }
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

async function waitForEvent(
  request: APIRequestContext,
  deploymentId: string,
  eventType: string,
  timeoutMs = 20_000,
): Promise<void> {
  await expect
    .poll(
      async () => (await getEvents(request, deploymentId)).some((e) => e.eventType === eventType),
      { timeout: timeoutMs, message: `waiting for event ${eventType}` },
    )
    .toBe(true);
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

test.describe.configure({ mode: 'serial' });

test.describe('lifecycle-sweep', () => {
  test('@scenario:lifecycle-sweep one deployment survives the full lifecycle: analyse, config, install, update-fail-rollback, relay reset, delete, purge', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // ── Sign up (the request fixture keeps the session cookie). ─────────────
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `Sweep Vendor ${suffix}`, email: `e2e-sweep-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    // ── Analyse. ─────────────────────────────────────────────────────────────
    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `Sweep App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/config-required-app',
        repoUrl: 'https://github.com/deployz-demo/config-required-app',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    const analyse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
    expect(analyse.ok()).toBeTruthy();

    // ── Readiness: the REAL analysis verdict is READY — no code changes
    // needed, only configuration. ─────────────────────────────────────────────
    const readiness = (await request
      .get(`${API_URL}/api/applications/${application.id}/readiness`)
      .then((r) => r.json())) as ReadinessResponse;
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('READY');

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `Sweep Customer ${suffix}`, email: `sweep-customer-${suffix}@example.com` },
    });
    expect(customerResponse.ok()).toBeTruthy();
    const customer = (await customerResponse.json()) as { id: string };

    // ── Configuration (enter a value): the deployment-creation gate refuses
    // until the required LICENSE_KEY has a provided value. SESSION_SECRET is
    // classified as Deployz-generated (Phase 4), so it is never asked for. ──
    const blocked = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
    });
    expect(blocked.status()).toBe(422);
    const blockedBody = (await blocked.json()) as {
      error: { code: string; message: string; details?: { findings?: Array<{ id: string }> } };
    };
    expect(blockedBody.error.code).toBe('MANIFEST_NEEDS_CONFIGURATION');
    expect(blockedBody.error.details?.findings?.some((f) => f.id === 'required-env-vars-missing')).toBe(true);

    const configWrite = await request.put(`${API_URL}/api/applications/${application.id}/config`, {
      data: { customerId: null, entries: [{ key: 'LICENSE_KEY', value: 'sweep-license-key', isSecret: true }] },
    });
    expect(configWrite.ok()).toBeTruthy();
    await createReadyRelease(request, application.id);

    const created = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
    });
    expect(created.ok()).toBeTruthy();
    const deployment = (await created.json()) as {
      id: string;
      installLinkId: string;
      enrollmentCode: string;
    };
    const { id: deploymentId, installLinkId, enrollmentCode } = deployment;

    const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
    expect(launch.ok()).toBeTruthy();

    // ── Install — the real relay drives the lifecycle-sweep scenario. ───────
    // DZ-AUDIT-013: fetch the server-minted relay credential from the install page.
    const installA = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installA.quickCreateUrl).not.toBeNull();
    const relayCredentialA = extractQuickCreateParam(installA.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-${suffix}`;
    const relayA = startSimulatedRelay({
      scenario: getScenario('lifecycle-sweep'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCredentialA,
    });

    try {
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 30_000,
          message: 'waiting for install to reach HEALTHY',
        })
        .toBe('HEALTHY');
      const healthy = await getDeployment(request, deploymentId);
      expect(healthy.relayStatus).toBe('CONNECTED');
      // The post-install auto-deploy is a real DEPLOY_RELEASE: one migration run.
      await waitForInstallAutoDeploy(buildApi(request), deploymentId);
      expect(relayA.account.migrationRuns).toBe(1);

      // ── Config update while live: a customer-scoped write is accepted,
      // persisted and rolled out; the deployment stays HEALTHY, and the next
      // deploy waits until the configuration update has settled. ───────────
      const liveConfig = await request.put(`${API_URL}/api/applications/${application.id}/config`, {
        data: { customerId: customer.id, entries: [{ key: 'LOG_LEVEL', value: 'debug', isSecret: false }] },
      });
      expect(liveConfig.ok()).toBeTruthy();
      const readBack = await request
        .get(`${API_URL}/api/applications/${application.id}/config?customerId=${customer.id}`)
        .then((r) => r.json()) as { customerOverrides: Array<{ key: string; value: string | null }> };
      expect(readBack.customerOverrides.find((e) => e.key === 'LOG_LEVEL')?.value).toBe('debug');
      await expect
        .poll(
          async () =>
            (await getDeployment(request, deploymentId)).jobs
              .filter((job) => job.type === 'CONFIG_UPDATE')
              .every((job) => job.state === 'SUCCEEDED'),
          { timeout: 20_000, message: 'waiting for the live config update to roll out' },
        )
        .toBe(true);
      expect((await getDeployment(request, deploymentId)).state).toBe('HEALTHY');

      // ── Successful update (v1) — and the migration stage really ran. ──────
      const v1ReleaseId = await createRelease(request, application.id, '1.0.0');
      const deployV1 = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v1ReleaseId },
      });
      expect(deployV1.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the v1 deploy to advance the release pointer',
        })
        .toBe(v1ReleaseId);
      expect((await getDeployment(request, deploymentId)).state).toBe('HEALTHY');
      expect(relayA.account.migrationRuns).toBe(2);

      // ── Failed update (v2): the deployment stays live on v1. ──────────────
      const v2ReleaseId = await createRelease(request, application.id, '2.0.0');
      const deployV2 = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v2ReleaseId },
      });
      expect(deployV2.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the v2 rollout to fail',
        })
        .toBe('UPDATE_AVAILABLE');
      const afterV2 = await getDeployment(request, deploymentId);
      expect(afterV2.deploymentStatus.failure?.code).toBe('ECS_DEPLOYMENT_FAILED');
      expect(afterV2.currentReleaseId).toBe(v1ReleaseId);
      expect(relayA.account.migrationRuns).toBe(3);

      // ── Rollback to v1 succeeds; a rollback never runs migrations. ────────
      const rollback = await request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
        data: { releaseId: v1ReleaseId },
      });
      expect(rollback.status()).toBe(202);
      await waitForEvent(request, deploymentId, 'rollback.completed');
      const afterRollback = await getDeployment(request, deploymentId);
      // UPDATE_AVAILABLE is truthful: v2 is still READY and newer than the
      // running v1 — a rollback is an older-release deployment (DZ-AUDIT-007).
      expect(afterRollback.state).toBe('UPDATE_AVAILABLE');
      expect(afterRollback.currentReleaseId).toBe(v1ReleaseId);
      expect(afterRollback.deploymentStatus.failure).toBeNull();
      expect(relayA.account.migrationRuns).toBe(3);

      // ── Relay disconnect + reconnect. The relay goes silent; the vendor
      // reconnects through relay/reset (the product's recovery path for a
      // lost relay), which clears the binding and mints a fresh enrollment
      // code. Day-2 actions are refused until the new relay registers. ───────
      relayA.stop();
      const reset = await request.post(`${API_URL}/api/deployments/${deploymentId}/relay/reset`, {
        data: {},
      });
      expect(reset.ok()).toBeTruthy();
      const afterReset = await getDeployment(request, deploymentId);
      // Reset preserves the installed deployment's state; UPDATE_AVAILABLE is
      // still truthful (v2 READY, newer than the running v1).
      expect(afterReset.state).toBe('UPDATE_AVAILABLE');
      expect(afterReset.relayStatus).toBe('UNKNOWN');

      // Day-2 action refused while no relay is connected.
      const refused = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v2ReleaseId },
      });
      expect(refused.status()).toBe(409);
      expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('RELAY_NOT_CONNECTED');

      // The fresh single-use code and credential travel only in the existing
      // stack's update values, exactly as the install page hands them to a
      // reconnecting customer. DZ-AUDIT-013: the relay credential is also carried here.
      const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
        quickCreateUrl: string | null;
        existingStackUpdate: { enrollmentCode: string; relayCredential: string | null } | null;
      };
      expect(installInfo.quickCreateUrl).toBeNull();
      expect(installInfo.existingStackUpdate).not.toBeNull();
      expect(installInfo.existingStackUpdate!.relayCredential).not.toBeNull();
      const freshEnrollmentCode = installInfo.existingStackUpdate!.enrollmentCode;
      const freshRelayCredential = installInfo.existingStackUpdate!.relayCredential!;

      const relayB = startSimulatedRelay({
        scenario: getScenario('lifecycle-sweep'),
        apiUrl: API_URL,
        installationId,
        enrollmentCode: freshEnrollmentCode,
        relayToken: freshRelayCredential,
        // The SAME simulated customer account: a rebuilt relay re-enrolls into
        // the account the first relay already installed into.
        account: relayA.account,
      });

      try {
        await expect
          .poll(async () => (await getDeployment(request, deploymentId)).relayStatus, {
            timeout: 20_000,
            message: 'waiting for the re-registered relay to be CONNECTED',
          })
          .toBe('CONNECTED');

        // ── Successful update again (v3), through the reconnected relay. ─────
        const v3ReleaseId = await createRelease(request, application.id, '3.0.0');
        const deployV3 = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
          data: { releaseId: v3ReleaseId },
        });
        expect(deployV3.status()).toBe(202);
        await expect
          .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
            timeout: 20_000,
            message: 'waiting for the post-reconnect deploy to advance the pointer',
          })
          .toBe(v3ReleaseId);
        const afterV3 = await getDeployment(request, deploymentId);
        expect(afterV3.state).toBe('HEALTHY');
        expect(relayB.account.migrationRuns).toBe(4);

        // ── Delete. ──────────────────────────────────────────────────────────
        const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, {
          data: {},
        });
        expect(destroy.status()).toBe(202);
        await expect
          .poll(async () => (await getDeployment(request, deploymentId)).state, {
            timeout: 20_000,
            message: 'waiting for the destroy to complete',
          })
          .toBe('DELETED');
        await waitForEvent(request, deploymentId, 'destroy.completed');
        const deleted = await getDeployment(request, deploymentId);
        expect(deleted.state).toBe('DELETED');
        expect(deleted.cleanupState).not.toBe('COMPLETE');
        // Phase 6 expectation gate after the disconnect: the surviving
        // inventory still matches the plan (retained kinds stay, nothing
        // unexpected appeared).
        await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-disconnect' });

        // ── Purge: the retained-resource cleanup for the DELETED deployment.
        const purge = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, {
          data: {},
        });
        expect(purge.status()).toBe(202);
        await expect
          .poll(async () => (await getDeployment(request, deploymentId)).cleanupState, {
            timeout: 20_000,
            message: 'waiting for the purge to complete',
          })
          .toBe('COMPLETE');
        await waitForEvent(request, deploymentId, 'purge.completed');

        const purged = await getDeployment(request, deploymentId);
        expect(purged.state).toBe('DELETED');
        // Phase 6 expectation gate after the purge (DELETED path): nothing
        // is missing or unexpected in the final preserved inventory.
        await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-purge' });
      } finally {
        relayB.stop();
      }
    } finally {
      relayA.stop();
    }
  });
});

