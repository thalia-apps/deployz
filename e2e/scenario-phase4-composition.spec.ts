/**
 * Phase 4D — the full Phase-4 composition, ONE continuous test over ONE
 * deployment whose application is analysed (real analyser, fixture mode)
 * from deployz-demo/composed-app: web + email-worker + import-worker + a
 * migration workload, over a managed MySQL database AND Redis.
 *
 *   analyse → readiness READY (MySQL + Redis detected) → frozen spec proves
 *   the whole topology → install reaches HEALTHY → the auto-deploy runs the
 *   frozen migration ONCE, BEFORE any service rolls (operation-log order) →
 *   per-workload READY component seats → RESTART redeploys all 3 services
 *   and runs NO migration → v1 deploy runs the migration again (new
 *   identity) → ROLLBACK rolls all workloads back and runs NO migration →
 *   re-deploy of v1 (SAME identity) SKIPS the migration → DESTROY retains
 *   rds/redis/secrets/bucket → PURGE sweeps the retained MySQL instance.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, expectPlanMatchesInventory, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
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
    workloads: Array<{ id: string; role: string }>;
    resources: Array<{ id: string; service: string; configuration: Record<string, unknown> }>;
  };
}

interface ReleaseResponse {
  id: string;
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
    data: { version, gitSha: `sha-${version}` },
  });
  if (!response.ok()) {
    throw new Error(`create release ${version} failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as ReleaseResponse).id;
}

test.describe.configure({ mode: 'serial' });

test.describe('phase4-composition', () => {
  test('@scenario:phase4-composition the full Phase-4 topology: MySQL + Redis, 3 services + migration, restart/rollback/skip semantics, retain + purge', async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // ── Sign up + analyse the composed fixture through the REAL analyser. ──
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `Phase4 Vendor ${suffix}`, email: `e2e-p4-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `Phase4 App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/composed-app',
        repoUrl: 'https://github.com/deployz-demo/composed-app',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    const analyse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
    expect(analyse.ok()).toBeTruthy();

    // ── Readiness: READY — MySQL and Redis are supported, and the declared
    // workers are first-class workloads, never blockers. ─────────────────────
    const readiness = (await request
      .get(`${API_URL}/api/applications/${application.id}/readiness`)
      .then((r) => r.json())) as ReadinessResponse;
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('READY');
    expect(readiness.findings).toContainEqual(
      expect.objectContaining({ id: 'worker-process', severity: 'recommended', blocking: false }),
    );
    expect(readiness.findings.some((f) => f.blocking === true)).toBe(false);

    await createReadyRelease(request, application.id);

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `Phase4 Customer ${suffix}`, email: `p4-customer-${suffix}@example.com` },
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

    // ── The frozen plan proves the COMPOSITION: four workloads (web, two
    // workers, the one-shot migration), an rds-mysql database and a cache. ──
    const plan = (await buildApi(request).getPlan(deploymentId, 'install')) as unknown as PlanResponse;
    expect(plan.footprint.workloads.map((workload) => ({ id: workload.id, role: workload.role }))).toEqual([
      { id: 'web', role: 'web' },
      { id: 'email-worker', role: 'worker' },
      { id: 'import-worker', role: 'worker' },
      { id: 'migration', role: 'migration' },
    ]);
    const database = plan.footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.service).toBe('rds-mysql');
    expect(database.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });
    expect(plan.footprint.resources.find((resource) => resource.id === 'cache')).toBeDefined();

    const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
    expect(launch.ok()).toBeTruthy();

    // ── Install — the real relay drives the phase4-composition scenario. ───
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCredential = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-${suffix}`;
    const relay = startSimulatedRelay({
      scenario: getScenario('phase4-composition'),
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
      expect((await getDeployment(request, deploymentId)).relayStatus).toBe('CONNECTED');

      // ── Auto-deploy: the frozen migration runs ONCE, BEFORE any service
      // rolls; then all three services reach their first-start counts. ──────
      const autoReleaseId = await waitForInstallAutoDeploy(buildApi(request), deploymentId);
      expect(relay.account.migrationRuns).toBe(1);
      const migrationIndex = relay.account.operationLog.findIndex((entry) => entry.startsWith('migration:'));
      const firstUpdateIndex = relay.account.operationLog.findIndex((entry) => entry.startsWith('update:'));
      expect(migrationIndex).toBeGreaterThanOrEqual(0);
      expect(firstUpdateIndex).toBeGreaterThan(migrationIndex);
      expect(relay.account.operationLog.filter((entry) => entry.startsWith('update:'))).toHaveLength(3);

      // ── Per-workload READY seats: the web workload keeps the runtime seat;
      // each worker is verified through its OWN service. ─────────────────────
      const healthy = await getDeployment(request, deploymentId);
      expect(healthy.deploymentStatus.components).toContainEqual(
        expect.objectContaining({ key: 'runtime', label: 'Application runtime', status: 'READY' }),
      );
      expect(healthy.deploymentStatus.components).toContainEqual(
        expect.objectContaining({ key: 'email-worker', label: 'Worker email-worker', status: 'READY' }),
      );
      expect(healthy.deploymentStatus.components).toContainEqual(
        expect.objectContaining({ key: 'import-worker', label: 'Worker import-worker', status: 'READY' }),
      );
      expect(healthy.deploymentStatus.components).toContainEqual(
        expect.objectContaining({ key: 'redis', status: 'READY' }),
      );

      const afterAutoDeploy = relay.account.serviceSnapshots();
      expect(afterAutoDeploy.map((service) => service.logicalId)).toEqual([
        'WebService',
        'EmailWorkerService',
        'ImportWorkerService',
      ]);
      for (const service of afterAutoDeploy) {
        expect(service.desiredCount).toBe(1);
        expect(service.healthy).toBe(true);
      }

      // ── RESTART: every service redeploys; the migration does NOT run. ──────
      const restart = await request.post(`${API_URL}/api/deployments/${deploymentId}/restart`, { data: {} });
      expect(restart.status()).toBe(202);
      await expect
        .poll(async () => relay.account.restarts, {
          timeout: 20_000,
          message: 'waiting for the restart executor to touch all three services',
        })
        .toBe(3);
      expect(relay.account.migrationRuns).toBe(1);
      // The restart job settles on its rollout, on a later relay poll.
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the restart rollout to settle',
        })
        .toBe('HEALTHY');

      // ── v1 deploy: a NEW migration identity runs the migration again. ──────
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
        expect(service.runningImageDigest).not.toBe(afterAutoDeploy[0]!.runningImageDigest);
      }

      // ── ROLLBACK: every workload rolls back; the migration never runs. ─────
      const rollback = await request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
        data: { releaseId: autoReleaseId },
      });
      expect(rollback.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the rollback to promote the previous release',
        })
        .toBe(autoReleaseId);
      expect((await getDeployment(request, deploymentId)).deploymentStatus.failure).toBeNull();
      expect(relay.account.migrationRuns).toBe(2);
      const afterRollback = relay.account.serviceSnapshots();
      for (const service of afterRollback) {
        expect(service.runningImageDigest).toBe(afterAutoDeploy[0]!.runningImageDigest);
        expect(service.healthy).toBe(true);
      }

      // ── Re-deploy v1: SAME migration identity → the migration is SKIPPED;
      // only the services roll. ───────────────────────────────────────────────
      const redeploy = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v1ReleaseId },
      });
      expect(redeploy.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the same-identity re-deploy to promote v1 again',
        })
        .toBe(v1ReleaseId);
      expect((await getDeployment(request, deploymentId)).state).toBe('HEALTHY');
      expect(relay.account.migrationRuns).toBe(2);

      // ── DESTROY: the data resources are RETAINED by policy. ────────────────
      const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
      expect(destroy.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the destroy to complete',
        })
        .toBe('DELETED');
      expect((await getDeployment(request, deploymentId)).cleanupState).not.toBe('COMPLETE');
      await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-destroy' });
      // The retained inventory keeps the database and storage (Retain by
      // policy — MySQL is retained engine-blind, exactly like PostgreSQL).
      // The cache is stateless by design (lifecycle 'delete'): it is removed
      // with the deployment and rebuilt by the next install, so its status
      // is 'removed', never 'retained'.
      const inventory = (await buildApi(request).getInfrastructure(deploymentId)) as {
        components: Array<{ kind: string; status: string }>;
      };
      const retainedKinds = Object.fromEntries(
        inventory.components.map((component) => [component.kind, component.status]),
      );
      expect(retainedKinds['database']).toBe('retained');
      expect(retainedKinds['storage']).toBe('retained');
      expect(retainedKinds['cache']).toBe('removed');

      // ── PURGE: the generic sweep deletes the retained MySQL instance. ──────
      const purge = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, { data: {} });
      expect(purge.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).cleanupState, {
          timeout: 20_000,
          message: 'waiting for the purge to complete',
        })
        .toBe('COMPLETE');
      expect(relay.purgeDeletedDb).toEqual(['deployz-primary-db-mysql']);
      await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-purge' });
    } finally {
      relay.stop();
    }
  });
});
