/**
 * Phase 4A multi-workload lifecycle — ONE continuous test driving ONE
 * deployment whose application declares web + TWO background workers through
 * the whole chain:
 *
 *   analyse (real analyser over deployz-demo/multi-worker-app, a Procfile
 *   app with email-worker + import-worker + a migration script) → readiness
 *   READY → install (3 ECS services, workers with NO ALB) → healthy →
 *   per-workload component seats → RESTART (every workload) → v1 deploy →
 *   rollback returns ALL workloads to the previous revision → delete → purge.
 *
 * Everything rides the real HTTP API and the real relay executors over the
 * `multi-worker-sweep` scenario definition (see ./simulation/scenarios/
 * multi-worker-sweep.ts). Per-service truth is read from the simulated
 * account's snapshots (task-definition family, running digest, desired
 * count) — the same state the real executors write.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';
import { fixtureSha } from './fixture-sha.js';

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  currentReleaseId: string | null;
  relayStatus: string;
  cleanupState: string | null;
  components: Record<string, string> | null;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null } | null;
    components: Array<{ key: string; label: string; status: string }>;
  };
}

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  findings: Array<{ id: string; severity?: string; blocking?: boolean }>;
}

interface PlanResponse {
  footprint: {
    workloads: Array<{ id: string; role: string; label: string; quantity: number }>;
  };
}

interface ReleaseResponse {
  id: string;
  version: string;
}

async function getDeployment(request: APIRequestContext, deploymentId: string): Promise<DeploymentResponse> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
  }
  return (await response.json()) as DeploymentResponse;
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

test.describe('multi-worker-sweep', () => {
  test('@scenario:multi-worker-sweep web + two workers: install, per-workload health, restart, deploy, rollback of every service', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // ── Sign up + analyse the multi-worker fixture through the REAL analyser.
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `MultiWorker Vendor ${suffix}`, email: `e2e-mw-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `MultiWorker App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/multi-worker-app',
        repoUrl: 'https://github.com/deployz-demo/multi-worker-app',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    const analyse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
    expect(analyse.ok()).toBeTruthy();

    // ── Readiness: READY — the two declared workers are supported workloads,
    // never a blocker; only the informational worker-process finding remains.
    const readiness = (await request
      .get(`${API_URL}/api/applications/${application.id}/readiness`)
      .then((r) => r.json())) as ReadinessResponse;
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('READY');
    expect(readiness.findings).toContainEqual(
      expect.objectContaining({ id: 'worker-process', severity: 'recommended', blocking: false }),
    );
    expect(readiness.findings.some((f) => f.blocking === true)).toBe(false);

    // The analysis of this fixture already resolves port/start/Dockerfile;
    // only the READY release the install gate needs is seeded here.
    await createReadyRelease(request, application.id);

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `MultiWorker Customer ${suffix}`, email: `mw-customer-${suffix}@example.com` },
    });
    expect(customerResponse.ok()).toBeTruthy();
    const customer = (await customerResponse.json()) as { id: string };

    const created = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
    });
    if (!created.ok()) {
      throw new Error(`create deployment failed: ${created.status()} ${await created.text()}`);
    }
    const deployment = (await created.json()) as {
      id: string;
      installLinkId: string;
      enrollmentCode: string;
    };
    const { id: deploymentId, installLinkId, enrollmentCode } = deployment;

    // ── The plan freezes the application's workloads: web + two worker
    // seats (the compiler's footprint also lists the one-shot migration
    // workload, which compiles no ECS service). ─────────────────────────────
    const plan = (await buildApi(request).getPlan(deploymentId, 'install')) as unknown as PlanResponse;
    expect(plan.footprint.workloads.map((workload) => ({ id: workload.id, role: workload.role }))).toEqual([
      { id: 'web', role: 'web' },
      { id: 'email-worker', role: 'worker' },
      { id: 'import-worker', role: 'worker' },
      { id: 'migration', role: 'migration' },
    ]);

    const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
    expect(launch.ok()).toBeTruthy();

    // ── Install — the real relay drives the multi-worker-sweep scenario. ────
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCredential = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-${suffix}`;
    const relay = startSimulatedRelay({
      scenario: getScenario('multi-worker-sweep'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCredential,
    });

    try {
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 30_000,
          message: 'waiting for install to reach HEALTHY',
        })
        .toBe('HEALTHY');

      // The post-install auto-deploy is a real DEPLOY_RELEASE: the first
      // start scales ALL THREE services up (one migration run).
      await waitForInstallAutoDeploy(buildApi(request), deploymentId);
      expect(relay.account.migrationRuns).toBe(1);

      // ── Per-workload component seats on the vendor status surface: the web
      // workload keeps the historical runtime seat; each worker sits under
      // its own id, verified through its OWN service (no ALB, no HTTP).
      const healthy = await getDeployment(request, deploymentId);
      const statusComponents = healthy.deploymentStatus.components;
      expect(statusComponents).toContainEqual(
        expect.objectContaining({ key: 'runtime', label: 'Application runtime', status: 'READY' }),
      );
      expect(statusComponents).toContainEqual(
        expect.objectContaining({ key: 'email-worker', label: 'Worker email-worker', status: 'READY' }),
      );
      expect(statusComponents).toContainEqual(
        expect.objectContaining({ key: 'import-worker', label: 'Worker import-worker', status: 'READY' }),
      );

      // ── Three services, one task-definition family each; workers run the
      // SAME release image with their own desired count. ─────────────────────
      const afterAutoDeploy = relay.account.serviceSnapshots();
      expect(afterAutoDeploy.map((service) => service.logicalId)).toEqual([
        'WebService',
        'EmailWorkerService',
        'ImportWorkerService',
      ]);
      // One family per workload, unique to this installation.
      expect(afterAutoDeploy.map((service) => service.family)).toEqual([
        relay.account.taskFamily('web'),
        relay.account.taskFamily('email-worker'),
        relay.account.taskFamily('import-worker'),
      ]);
      for (const service of afterAutoDeploy) expect(service.family).toMatch(/^DeployzApp[A-Za-z]+[a-z0-9]+$/);
      for (const service of afterAutoDeploy) {
        expect(service.desiredCount).toBe(1);
        expect(service.healthy).toBe(true);
        expect(service.runningImageDigest).toBe(afterAutoDeploy[0]!.runningImageDigest);
      }
      const autoDeployDigest = afterAutoDeploy[0]!.runningImageDigest!;

      // ── RESTART: the real restart executor forces a new deployment of
      // EVERY workload's current definition. ─────────────────────────────────
      const restart = await request.post(`${API_URL}/api/deployments/${deploymentId}/restart`, {
        data: {},
      });
      expect(restart.status()).toBe(202);
      await expect
        .poll(async () => relay.account.restarts, {
          timeout: 20_000,
          message: 'waiting for the restart executor to touch all three services',
        })
        .toBe(3);
      // The restart job settles on its rollout, on a later relay poll.
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the restart rollout to settle',
        })
        .toBe('HEALTHY');

      // ── Successful v1 deploy — every service rolls to the new revision. ────
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
      expect(relay.account.migrationRuns).toBe(2);

      const afterV1 = relay.account.serviceSnapshots();
      for (const service of afterV1) {
        expect(service.runningImageDigest).not.toBe(autoDeployDigest);
        expect(service.runningImageDigest).toBe(afterV1[0]!.runningImageDigest);
        // Each family advanced to a NEW revision (one register per workload).
        expect(service.taskDefinitionArn).not.toBe(
          afterAutoDeploy.find((before) => before.logicalId === service.logicalId)!.taskDefinitionArn,
        );
      }
      const v1Digest = afterV1[0]!.runningImageDigest!;

      // ── v2 deploy — another full rollout across all three services. ────────
      const v2ReleaseId = await createRelease(request, application.id, '2.0.0');
      const deployV2 = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v2ReleaseId },
      });
      expect(deployV2.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the v2 deploy to advance the release pointer',
        })
        .toBe(v2ReleaseId);
      expect(relay.account.migrationRuns).toBe(3);
      const afterV2 = relay.account.serviceSnapshots();
      for (const service of afterV2) {
        expect(service.runningImageDigest).not.toBe(v1Digest);
      }

      // ── Rollback to v1: ALL workloads return to the v1 revision, each in
      // its own family — and a rollback never runs migrations. The settled
      // state is HEALTHY or UPDATE_AVAILABLE depending on whether the result
      // handler ran before the heartbeat promoted the v1 pointer (v2 is
      // READY and newer either way); the pointer landing on v1 with no
      // failure is the rollback's own truth.
      const rollback = await request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
        data: { releaseId: v1ReleaseId },
      });
      expect(rollback.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the rollback to promote the v1 pointer',
        })
        .toBe(v1ReleaseId);
      const afterRollback = await getDeployment(request, deploymentId);
      expect(['HEALTHY', 'UPDATE_AVAILABLE']).toContain(afterRollback.state);
      expect(afterRollback.deploymentStatus.failure).toBeNull();
      expect(relay.account.migrationRuns).toBe(3);

      const afterRollbackSnapshots = relay.account.serviceSnapshots();
      for (const service of afterRollbackSnapshots) {
        expect(service.runningImageDigest).toBe(v1Digest);
        expect(service.healthy).toBe(true);
        expect(service.taskDefinitionArn).not.toBe(
          afterV1.find((before) => before.logicalId === service.logicalId)!.taskDefinitionArn,
        );
      }

      // ── Delete + purge: the lifecycle ends cleanly. ────────────────────────
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
    } finally {
      relay.stop();
    }
  });
});
