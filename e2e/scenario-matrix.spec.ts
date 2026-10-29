/**
 * Phase 14 scenario-matrix gaps (§18 A–E) at the E2E level, driven through
 * the REAL HTTP API and — where a deployment is actually reachable — the real
 * relay executors over the simulated account:
 *
 *   D — an unsupported repo (deployz-demo/mongodb-app, a MongoDB app) is
 *       blocked at deployment creation with NO AWS provisioning: the POST
 *       /api/deployments gate refuses (422 MANIFEST_NOT_COMPATIBLE), so no
 *       deployment row — and therefore no INSTALL job — can ever exist.
 *   E — a repairable repo (deployz-demo/local-fs-app, persistent local
 *       filesystem writes) is blocked the same way, AND the coding-agent
 *       repair guidance surfaces through the real fix-instructions route.
 *   B — a successful Redis install: deployz-demo/bullmq-worker analysed
 *       through the real analyser (redisRequired from production analysis)
 *       installs to HEALTHY over the redis-success scenario, and a real
 *       DEPLOY_RELEASE carries the migration through the same deployment.
 *   C — a monorepo (deployz-demo/monorepo) classified by the real analyser
 *       is driven through a build+deploy simulated pass to HEALTHY.
 *
 * Unit-level coverage of the D/E gates already exists
 * (apps/api/src/server.test.ts, manifest.test.ts, redis.spec.ts UI passes);
 * these are the E2E proofs that the real analysis + gate + no-provisioning
 * boundary composes.
 */

import type { APIRequestContext } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, expect, expectPlanMatchesInventory, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';
import { fixtureSha } from './fixture-sha.js';

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  outcome?: string;
  requiredCount: number;
  findings: Array<{
    id: string;
    blocking?: boolean;
    fixClass?: string;
    title?: string;
    plainEnglishExplanation?: string;
    technicalEvidence?: string;
  }>;
}

interface DeploymentResponse {
  state: string;
  currentReleaseId: string | null;
  applicationId: string;
  healthStatus: string;
}

interface ErrorBody {
  error: { code: string; message: string; details?: { findings?: Array<{ id: string; message?: string }> } };
}

interface InfrastructureResponse {
  components: Array<{ kind: string; status: string }>;
  summary: { technicalResourceCount: number };
  expectations: {
    components: Array<{ kind: string; expected: boolean; present: boolean }>;
    missing: string[];
    unexpected: string[];
  } | null;
}

async function signUp(request: APIRequestContext, suffix: string): Promise<void> {
  const email = `e2e-matrix-${suffix}@example.com`;
  const response = await request.post(`${API_URL}/api/auth/sign-up/email`, {
    data: { name: `Matrix Vendor ${suffix}`, email, password: 'super-secret-1' },
  });
  if (!response.ok()) {
    throw new Error(`sign-up failed: ${response.status()} ${await response.text()}`);
  }
}

async function seedAnalysedApplication(
  request: APIRequestContext,
  repoFullName: string,
  suffix: string,
): Promise<{ applicationId: string }> {
  const appResponse = await request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Matrix App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
    },
  });
  if (!appResponse.ok()) {
    throw new Error(`create application failed: ${appResponse.status()} ${await appResponse.text()}`);
  }
  const application = (await appResponse.json()) as { id: string };
  const analyseResponse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`);
  if (!analyseResponse.ok()) {
    throw new Error(`analyse failed: ${analyseResponse.status()} ${await analyseResponse.text()}`);
  }
  return { applicationId: application.id };
}

async function createCustomer(request: APIRequestContext, suffix: string): Promise<string> {
  const response = await request.post(`${API_URL}/api/customers`, {
    data: { name: `Matrix Customer ${suffix}`, email: `matrix-customer-${suffix}@example.com` },
  });
  if (!response.ok()) {
    throw new Error(`create customer failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function getReadiness(
  request: APIRequestContext,
  applicationId: string,
): Promise<ReadinessResponse> {
  const response = await request.get(`${API_URL}/api/applications/${applicationId}/readiness`);
  if (!response.ok()) {
    throw new Error(`GET readiness failed: ${response.status()} ${await response.text()}`);
  }
  return (await response.json()) as ReadinessResponse;
}

test.describe.configure({ mode: 'parallel' });

test.describe('unsupported-database (D)', () => {
  test('@scenario:unsupported-mongodb a MongoDB app is refused at deployment creation — no deployment, no INSTALL job, no provisioning', async ({
    request,
  }) => {
    test.setTimeout(30_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/mongodb-app', suffix);

    // The real analysis classifies the repo as needing changes, with the
    // unsupported database as the ONE blocking finding — the rest of the app
    // (Dockerfile, port, health, start) is ready.
    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('NEEDS_CHANGES');
    const mongo = readiness.findings.find((f) => f.id === 'unsupported-database-mongo');
    expect(mongo).toBeDefined();
    expect(mongo?.blocking).toBe(true);
    expect(mongo?.technicalEvidence).toContain('mongoose');

    const customerId = await createCustomer(request, suffix);
    const blocked = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(blocked.status()).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.code).toBe('MANIFEST_NOT_COMPATIBLE');
    expect(body.error.details?.findings?.some((f) => f.message?.includes('MongoDB'))).toBe(true);

    // No deployment row exists for this application — the refusal happens
    // BEFORE any AWS provisioning can start, so no INSTALL job can ever be
    // created for it (an INSTALL job only exists on a deployment row, minted
    // at relay registration).
    const deployments = await request.get(`${API_URL}/api/deployments?applicationId=${applicationId}`);
    expect(deployments.ok()).toBeTruthy();
    expect(((await deployments.json()) as { deployments: unknown[] }).deployments).toEqual([]);
  });
});

test.describe('repairable-local-filesystem (E)', () => {
  test('@scenario:repairable-local-fs a local-filesystem app is deployable with changes, is refused at deployment creation, and the coding-agent repair guidance surfaces', async ({
    request,
  }) => {
    test.setTimeout(30_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/local-fs-app', suffix);

    // The real analysis classifies the repo as deployable with changes: the
    // persistent-local-disk finding is a repository change (CODE_CHANGE), not a
    // capability gap, so it is required but not blocking in the report.
    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('ALMOST_READY');
    expect(readiness.outcome).toBe('DEPLOYABLE_WITH_CHANGES');
    const localFs = readiness.findings.find((f) => f.id === 'local-file-storage');
    expect(localFs).toBeDefined();
    expect(localFs?.fixClass).toBe('CODE_CHANGE');
    expect(localFs?.blocking).toBe(false);
    expect(localFs?.title).toBe('Files stored on local disk');
    expect(localFs?.technicalEvidence).toContain('VOLUME /data');

    const customerId = await createCustomer(request, suffix);
    const blocked = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(blocked.status()).toBe(422);
    const body = (await blocked.json()) as ErrorBody;
    expect(body.error.code).toBe('MANIFEST_NOT_COMPATIBLE');
    expect(body.error.details?.findings?.some((f) => f.id === 'unsupported')).toBe(true);

    // The coding-agent repair guidance surfaces through the real
    // fix-instructions route: the document classifies the blocker as an
    // application fix and points persistent writes at the Deployz bucket.
    const fix = await request.post(`${API_URL}/api/applications/${applicationId}/fix-instructions`);
    expect(fix.ok()).toBeTruthy();
    const { instructions } = (await fix.json()) as { instructions: string };
    expect(instructions).toContain('Persistent data written to local disk');
    expect(instructions).toContain('- Class: APPLICATION_FIX');
    expect(instructions).toContain('`STORAGE_BUCKET`');
    expect(instructions).toContain('Do not assume Deployz findings are correct');
  });
});

test.describe('redis-success (B)', () => {
  test.use({ deployzScenario: 'redis-success', deployzRepoFullName: 'deployz-demo/bullmq-worker' });

  test('@scenario:redis-success a Redis app installs to HEALTHY and a real deploy runs the migration through the same deployment', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(60_000);
    const { deploymentId, installLinkId, api, relay } = deployzInstall;
    expect(relay).toBeDefined();

    // The analysed bullmq-worker carries a Redis requirement into the install
    // page's "Deployz will create" table (production analysis, not a hand-set
    // flag) and the deployment installs over a Redis-provisioning timeline to
    // HEALTHY — including the ElastiCache resource in the persisted inventory.
    const installInfo = (await api.getInstallInfo(installLinkId)) as {
      plan: { components: { name: string }[] } | null;
    };
    expect(installInfo.plan?.components.map((c) => c.name)).toContain('Cache');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 20_000,
        message: 'waiting for the Redis install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    // The post-install auto-deploy is a real DEPLOY_RELEASE too: it runs the
    // migration once.
    await waitForInstallAutoDeploy(api, deploymentId);
    expect(relay!.account.migrationRuns).toBe(1);

    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    expect(infra.components.some((c) => c.kind === 'cache' && c.status === 'ready')).toBe(true);

    // Phase 6: requirement-aware verification. The real analyser required
    // Redis, and the cache made it into the inventory, so nothing is missing
    // or unexpected.
    expect(infra.expectations?.missing).toEqual([]);
    expect(infra.expectations?.unexpected).toEqual([]);
    expect(infra.expectations?.components.find((c) => c.kind === 'cache')).toEqual({
      kind: 'cache',
      expected: true,
      present: true,
    });

    // A real DEPLOY_RELEASE on the same deployment: the manifest carries the
    // analysed migration command, so the relay's migration stage actually
    // runs a one-off task (the account's migration counter) before the
    // service update — Redis provisioning and migration through one install.
    const installed = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    const releaseResponse = await request.post(
      `${API_URL}/api/applications/${installed.applicationId}/releases`,
      { data: { version: '1.0.0', gitSha: fixtureSha('1.0.0') } },
    );
    expect(releaseResponse.ok()).toBeTruthy();
    const release = (await releaseResponse.json()) as { id: string };

    const deploy = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
      data: { releaseId: release.id },
    });
    expect(deploy.status()).toBe(202);

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId, {
        timeout: 20_000,
        message: 'waiting for the deploy to advance the release pointer',
      })
      .toBe(release.id);
    expect(relay!.account.migrationRuns).toBe(2);

    // Phase 6 expectation gate after the successful update rollout: the
    // inventory still matches the plan.
    await expectPlanMatchesInventory(api, deploymentId, { stage: 'post-update' });
  });
});

test.describe('monorepo-classified-deploy (C)', () => {
  test('@scenario:monorepo-deploy a monorepo classified by the real analyser is driven through a build+deploy simulated pass to HEALTHY', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const suffix = crypto.randomUUID().slice(0, 8);
    await signUp(request, suffix);

    // The application is analysed through the real analyser (no vendor
    // overrides — §35 backfills the detected nested-app container fields), so
    // the manifest the deployment locks in is the genuine monorepo result:
    // app root apps/api, repo-root build context.
    const { applicationId } = await seedAnalysedApplication(request, 'deployz-demo/monorepo', suffix);

    const readiness = await getReadiness(request, applicationId);
    expect(readiness.analysisStatus).toBe('COMPLETE');
    // The classification Phase 7 unit-tests is E2E-real here: ALMOST_READY
    // with the health-check finding only. Phase 5 removed the silent /health
    // default, so the vendor supplies the health path through the override
    // surface; the semantic readiness state is unchanged by the override.
    expect(readiness.state).toBe('ALMOST_READY');
    expect(readiness.findings).toEqual([expect.objectContaining({ id: 'health-check' })]);

    const healthPatch = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
      data: { healthPath: '/health' },
    });
    expect(healthPatch.ok()).toBeTruthy();
    await createReadyRelease(request, applicationId);

    const customerId = await createCustomer(request, suffix);
    const deploymentResponse = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId, customerId, region: 'us-east-1' },
    });
    expect(deploymentResponse.ok()).toBeTruthy();
    const deployment = (await deploymentResponse.json()) as {
      id: string;
      installLinkId: string;
    };
    const launch = await request.post(`${API_URL}/api/install/${deployment.installLinkId}/launched`, {
      data: {},
    });
    expect(launch.ok()).toBeTruthy();

    // Install + a real DEPLOY_RELEASE settle to HEALTHY with the pointer
    // advanced — the classification result composes all the way through the
    // simulated build+deploy pass.
    // DZ-AUDIT-013: fetch the server-minted relay credential from the install page.
    const installInfo = await request.get(`${API_URL}/api/install/${deployment.installLinkId}`, {
      headers: await installLinkHeaders(request, deployment.installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const enrollmentCode = extractQuickCreateParam(installInfo.quickCreateUrl!, 'EnrollmentCode');
    const relayCredential = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    // The monorepo manifest provisions no database and no cache, so the relay
    // runs the stateless timeline — the relay's reported resources must match
    // the deployment's frozen manifest profile (plan/inventory parity).
    const relay = startSimulatedRelay({
      scenario: getScenario('stateless'),
      apiUrl: API_URL,
      installationId: `inst-${suffix}`,
      enrollmentCode,
      relayToken: relayCredential,
    });
    try {
      await expect
        .poll(
          async () =>
            ((await request
              .get(`${API_URL}/api/deployments/${deployment.id}`)
              .then((r) => r.json())) as { state: string }).state,
          { timeout: 30_000, message: 'waiting for the monorepo install to reach HEALTHY' },
        )
        .toBe('HEALTHY');
      await waitForInstallAutoDeploy(buildApi(request), deployment.id);

      const releaseResponse = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
        data: { version: '1.0.0', gitSha: fixtureSha('1.0.0') },
      });
      expect(releaseResponse.ok()).toBeTruthy();
      const release = (await releaseResponse.json()) as { id: string };
      const deploy = await request.post(`${API_URL}/api/deployments/${deployment.id}/deploy`, {
        data: { releaseId: release.id },
      });
      expect(deploy.status()).toBe(202);
      await expect
        .poll(
          async () =>
            ((await request
              .get(`${API_URL}/api/deployments/${deployment.id}`)
              .then((r) => r.json())) as { currentReleaseId: string | null }).currentReleaseId,
          { timeout: 20_000, message: 'waiting for the monorepo deploy to advance the release pointer' },
        )
        .toBe(release.id);
      const after = (await request
        .get(`${API_URL}/api/deployments/${deployment.id}`)
        .then((r) => r.json())) as DeploymentResponse;
      expect(after.state).toBe('HEALTHY');
      await expectPlanMatchesInventory(buildApi(request), deployment.id, { stage: 'post-update' });
    } finally {
      relay.stop();
    }
  });
});
