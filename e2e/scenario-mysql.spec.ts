/**
 * Phase 4B RDS MySQL lifecycle — ONE continuous test driving ONE MySQL
 * application through the whole chain:
 *
 *   analyse (real analyser over deployz-demo/mysql-api — mysql2 + a
 *   mysql:// DATABASE_URL, so `mysql.required` is true) → readiness READY →
 *   install (a managed database, engine 'mysql') → healthy → v1 deploy →
 *   delete (the database is RETAINED by policy) → purge (the retained
 *   MySQL instance + its subnet group are swept by the generic purge path).
 *
 * Everything rides the real HTTP API and the real relay executors over the
 * `mysql-sweep` scenario definition (see ./simulation/scenarios/
 * mysql-sweep.ts). The engine is proven on the plan surface: the plan embeds
 * the COMPILED spec's footprint verbatim, and its database row resolves
 * service 'rds-mysql' with engine 'mysql'. The relay purge path itself is
 * engine-agnostic — the assertion is that the SAME retained-resource sweep
 * deletes the MySQL instance.
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
}

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  findings: Array<{ id: string; severity?: string; blocking?: boolean }>;
}

interface PlanResponse {
  footprint: {
    resources: Array<{ id: string; service: string; configuration: Record<string, unknown> }>;
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

test.describe('mysql-sweep', () => {
  test('@scenario:mysql-sweep a MySQL app installs, deploys, and the purge sweeps the retained RDS MySQL instance', async ({
    request,
  }) => {
    test.setTimeout(180_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // ── Sign up + analyse the MySQL fixture through the REAL analyser. ─────
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `MySQL Vendor ${suffix}`, email: `e2e-mysql-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `MySQL App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/mysql-api',
        repoUrl: 'https://github.com/deployz-demo/mysql-api',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    const analyse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
    expect(analyse.ok()).toBeTruthy();

    // ── Readiness: READY — MySQL is a supported managed database, never a
    // blocker. ──────────────────────────────────────────────────────────────
    const readiness = (await request
      .get(`${API_URL}/api/applications/${application.id}/readiness`)
      .then((r) => r.json())) as ReadinessResponse;
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('READY');
    expect(readiness.findings.some((f) => f.blocking === true)).toBe(false);

    // The analysis of this fixture already resolves port/start/Dockerfile;
    // only the READY release the install gate needs is seeded here.
    await createReadyRelease(request, application.id);

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `MySQL Customer ${suffix}`, email: `mysql-customer-${suffix}@example.com` },
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

    // ── The plan freezes an rds-mysql database row. The plan endpoint embeds
    // the COMPILED spec's footprint verbatim when the deployment has one, so
    // this row is the frozen-spec proof of the aws.rds-mysql resolution. ───
    const plan = (await buildApi(request).getPlan(deploymentId, 'install')) as unknown as PlanResponse;
    const database = plan.footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.service).toBe('rds-mysql');
    expect(database.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });

    const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
    expect(launch.ok()).toBeTruthy();

    // ── Install — the real relay drives the mysql-sweep scenario. ──────────
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCredential = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-${suffix}`;
    const relay = startSimulatedRelay({
      scenario: getScenario('mysql-sweep'),
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

      // The post-install auto-deploy is a real DEPLOY_RELEASE: one migration
      // run (the analysed migration command runs for MySQL exactly as for
      // PostgreSQL).
      await waitForInstallAutoDeploy(buildApi(request), deploymentId);
      expect(relay.account.migrationRuns).toBe(1);

      // ── Successful v1 deploy. ────────────────────────────────────────────
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

      // ── Delete: the managed MySQL database is RETAINED by policy. ────────
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
      expect((await getDeployment(request, deploymentId)).cleanupState).not.toBe('COMPLETE');

      // ── Purge: the generic retained-resource sweep deletes the MySQL
      // instance and its subnet group. ──────────────────────────────────────
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
      expect(relay.purgeDeletedDb).toEqual(['deployz-primary-db-mysql']);
    } finally {
      relay.stop();
    }
  });
});
