/**
 * Phase 4C — first-class one-shot migration workloads, end to end in
 * simulation. The deployment's frozen spec carries a `migration` workload
 * (the seeded application analyses with a migration command), so every
 * DEPLOY_RELEASE whose migration identity is not yet confirmed runs the
 * spec-frozen migration task definition BEFORE any service rolls:
 *
 *   @scenario:migration-success — install → auto-deploy runs the migration
 *   exactly once, BEFORE the service update (operation-log order); a NEW
 *   release identity runs it again; a relay reset + re-offer of an
 *   already-confirmed identity (and a ROLLBACK) never re-runs it.
 *
 *   @scenario:migration-failure — the migration task exits 1: the deploy
 *   fails MIGRATION_FAILED with the migration named in the diagnostics, and
 *   NO service ever rolls.
 */

import type { APIRequestContext } from '@playwright/test';

import { startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, expect, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';

interface DeploymentResponse {
  state: string;
  currentReleaseId: string | null;
  relayStatus: string;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null; message: string } | null;
  };
  jobs: Array<{ type: string; state: string; result: { error?: string } | null }>;
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

async function createRelease(request: APIRequestContext, applicationId: string, version: string): Promise<string> {
  const response = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version, gitSha: `sha-${version}` },
  });
  if (!response.ok()) {
    throw new Error(`create release ${version} failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as ReleaseResponse).id;
}

test.describe.configure({ mode: 'serial' });

test.describe('migration workloads (phase 4c)', () => {
  test.use({ deployzScenario: 'migration-success' });

  test('@scenario:migration-success runs once before the rollout; confirmed identity and rollback never re-run it', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(180_000);
    const { deploymentId, installLinkId, installationId, enrollmentCode, relay, api } = deployzInstall;
    expect(relay).toBeDefined();

    // ── Install settles, and the post-install auto-deploy runs the frozen
    // migration BEFORE any service rolled (operation-log order), exactly once.
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).state, {
        timeout: 30_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    const autoReleaseId = await waitForInstallAutoDeploy(api, deploymentId);
    expect(relay!.account.migrationRuns).toBe(1);
    const migrationIndex = relay!.account.operationLog.findIndex((entry) => entry.startsWith('migration:'));
    const firstUpdateIndex = relay!.account.operationLog.findIndex((entry) => entry.startsWith('update:'));
    expect(migrationIndex).toBeGreaterThanOrEqual(0);
    expect(firstUpdateIndex).toBeGreaterThan(migrationIndex);
    // The migration ran an EXACT revision of this installation's own family —
    // never a bare family, never the shared `DeployzAppMigration`.
    const migrationFamily = relay!.account.taskFamily('migration');
    expect(migrationFamily).not.toBe('DeployzAppMigration');
    expect(relay!.account.operationLog[migrationIndex]).toMatch(
      new RegExp(`^migration:arn:aws:ecs:[^:]+:\\d+:task-definition/${migrationFamily}:\\d+$`),
    );

    // ── A NEW release = a new migration identity → the migration runs again.
    const v1ReleaseId = await createRelease(request, (await getApplicationId(request, deploymentId)), '1.0.0');
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
    expect(relay!.account.migrationRuns).toBe(2);

    // ── ROLLBACK never runs migrations — even though the release it rolls
    // back to carries its own, already-confirmed identity.
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
    expect(relay!.account.migrationRuns).toBe(2);

    // ── A relay retry/re-offer after success: the vendor reconnects a rebuilt
    // relay (the product's recovery path) and re-deploys the SAME release.
    // The identity is already confirmed, so the migration must NOT re-run —
    // only the services re-roll.
    relay!.stop();
    const reset = await request.post(`${API_URL}/api/deployments/${deploymentId}/relay/reset`, { data: {} });
    expect(reset.ok()).toBeTruthy();
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
      existingStackUpdate: { enrollmentCode: string; relayCredential: string | null } | null;
    };
    // The connector stack already exists, so the customer updates it with the
    // new values instead of creating a new one.
    expect(installInfo.quickCreateUrl).toBeNull();
    expect(installInfo.existingStackUpdate).not.toBeNull();
    expect(installInfo.existingStackUpdate!.relayCredential).not.toBeNull();
    const freshEnrollmentCode = installInfo.existingStackUpdate!.enrollmentCode;
    const freshRelayCredential = installInfo.existingStackUpdate!.relayCredential!;
    const relayB = startSimulatedRelay({
      scenario: getScenario('migration-success'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode: freshEnrollmentCode,
      relayToken: freshRelayCredential,
      account: relay!.account,
    });
    try {
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).relayStatus, {
          timeout: 20_000,
          message: 'waiting for the re-registered relay to be CONNECTED',
        })
        .toBe('CONNECTED');

      const redeploy = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
        data: { releaseId: v1ReleaseId },
      });
      expect(redeploy.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the re-offered deploy to promote v1 again',
        })
        .toBe(v1ReleaseId);
      expect((await getDeployment(request, deploymentId)).state).toBe('HEALTHY');
      // The confirmed identity was skipped — exactly two migration runs total.
      expect(relayB.account.migrationRuns).toBe(2);
    } finally {
      relayB.stop();
    }
  });
});

test.describe('migration failure (phase 4c)', () => {
  test.use({ deployzScenario: 'migration-failure' });

  test('@scenario:migration-failure a failed migration blocks the rollout with actionable diagnostics', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId, relay } = deployzInstall;
    expect(relay).toBeDefined();

    // Install itself completes (infrastructure + database ready, services at
    // zero), but the post-install auto-deploy's migration exits 1: the
    // deployment fails BEFORE any service started.
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).deploymentStatus.failure?.code ?? null, {
        timeout: 30_000,
        message: 'waiting for the failed migration to surface',
      })
      .toBe('MIGRATION_FAILED');

    const deployment = await getDeployment(request, deploymentId);
    // The ready release keeps the deployment in a live UPDATE_AVAILABLE state
    // (the standard failed-release state) — never a false HEALTHY.
    expect(deployment.state).toBe('UPDATE_AVAILABLE');
    // Actionable: the copy says what happened and for whom...
    const detail = `${deployment.deploymentStatus.failure?.message ?? ''}`;
    expect(detail.toLowerCase()).toContain('migration');
    // ...and the vendor-grade job result names the frozen migration task and
    // the real exit code.
    const failedDeploy = deployment.jobs.find(
      (job) => job.type === 'DEPLOY_RELEASE' && job.state === 'FAILED',
    );
    expect(String(failedDeploy?.result?.error ?? '')).toContain('Migration workload');
    expect(String(failedDeploy?.result?.error ?? '')).toContain('exit code 1');
    expect(relay!.account.migrationRuns).toBe(1);

    // No service ever rolled: no update in the operation log, nothing running.
    expect(relay!.account.operationLog.some((entry) => entry.startsWith('update:'))).toBe(false);
    for (const service of relay!.account.serviceSnapshots()) {
      expect(service.runningImageDigest).toBeNull();
      expect(service.healthy).toBe(false);
    }
  });
});

test.describe('migration recovery on an existing deployment', () => {
  test.use({ deployzScenario: 'migration-correction' });

  async function failedFirstDeploy(request: APIRequestContext, deploymentId: string): Promise<{ applicationId: string; releaseId: string }> {
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).deploymentStatus.failure?.code ?? null, {
        timeout: 30_000,
        message: 'waiting for the frozen migration to fail',
      })
      .toBe('MIGRATION_FAILED');
    expect((await getDeployment(request, deploymentId)).state).toBe('UPDATE_AVAILABLE');
    const applicationId = await getApplicationId(request, deploymentId);
    const releases = (await (await request.get(`${API_URL}/api/applications/${applicationId}/releases`)).json()) as {
      releases: { id: string }[];
    };
    return { applicationId, releaseId: releases.releases[0]!.id };
  }

  async function redeployUntilHealthy(request: APIRequestContext, deploymentId: string, releaseId: string): Promise<void> {
    const response = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } });
    expect(response.status(), await response.text()).toBe(202);
    await expect
      .poll(async () => {
        const deployment = await getDeployment(request, deploymentId);
        return deployment.currentReleaseId === releaseId ? deployment.state : null;
      }, { timeout: 30_000, message: 'waiting for the recovered release to serve' })
      .toBe('HEALTHY');
  }

  test('@scenario:migration-correction a corrected command recovers the same image and keeps the init container', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId, relay } = deployzInstall;
    const { applicationId, releaseId } = await failedFirstDeploy(request, deploymentId);
    const frozen = relay!.account.lastMigrationDefinition();

    const patch = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
      data: { migrationCommand: 'node scripts/migrate.js' },
    });
    expect(patch.ok()).toBe(true);
    await redeployUntilHealthy(request, deploymentId, releaseId);

    // The same release image ran a second, corrected migration revision.
    expect(relay!.account.migrationRuns).toBe(2);
    const corrected = relay!.account.lastMigrationDefinition()!;
    expect(corrected.family).toBe(relay!.account.taskFamily('Migration'));
    const [app, init] = corrected.containerDefinitions;
    expect(app).toMatchObject({ name: 'App', entryPoint: ['sh', '-c'], command: ['node scripts/migrate.js'] });
    expect(app?.image).toBe(frozen?.containerDefinitions[0]?.image);
    expect(init).toEqual(frozen?.containerDefinitions[1]);
    expect(relay!.account.operationLog.filter((entry) => entry.startsWith('migration:'))).toHaveLength(2);

    // A confirmed corrected identity never runs again for the same image.
    const again = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, { data: { releaseId } });
    expect(again.status()).toBe(202);
    await expect
      .poll(async () => (await getDeployment(request, deploymentId)).jobs.filter((job) => job.state === 'SUCCEEDED' && job.type === 'DEPLOY_RELEASE').length, {
        timeout: 30_000,
      })
      .toBe(2);
    expect(relay!.account.migrationRuns).toBe(2);
  });

  test('@scenario:migration-correction "No separate migration" deploys without a migration run', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(120_000);
    const { deploymentId, relay } = deployzInstall;
    const { applicationId, releaseId } = await failedFirstDeploy(request, deploymentId);

    const patch = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
      data: { migrationCommand: null },
    });
    expect(patch.ok()).toBe(true);
    await redeployUntilHealthy(request, deploymentId, releaseId);

    expect(relay!.account.migrationRuns).toBe(1);
    expect(relay!.account.operationLog.some((entry) => entry.startsWith('update:'))).toBe(true);
  });
});

/** Resolves the application that owns a deployment (for release creation). */
async function getApplicationId(request: APIRequestContext, deploymentId: string): Promise<string> {
  const deployment = (await request.get(`${API_URL}/api/deployments/${deploymentId}`).then((r) => r.json())) as {
    applicationId: string;
  };
  return deployment.applicationId;
}
