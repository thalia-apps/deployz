/**
 * Vendor blocker dispute (docs/ai-analysis.md#vendor-disputes) — ONE
 * continuous test over the real HTTP API and the real relay executors:
 *
 *   analyse deployz-demo/mongodb-app (real analyser: a MongoDB blocker,
 *   NOT_COMPATIBLE) → the vendor marks MongoDB as "not used in production"
 *   → the forced re-analysis drops the blocker → preflight lets the
 *   deployment through → the install reaches HEALTHY with no database.
 *
 * A finding that is not on the allowlist is refused, and the answer is kept
 * across a later re-analysis.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { installLinkHeaders } from './install-link.js';
import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi } from './simulation/fixtures.js';

const MONGO_FINDING = 'unsupported-database-mongo';

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  findings: Array<{ id: string; blocking?: boolean; technicalEvidence: string }>;
  vendorDismissedRejections?: Array<{ findingId: string; stale?: boolean }>;
}

async function readiness(request: APIRequestContext, applicationId: string): Promise<ReadinessResponse> {
  const response = await request.get(`${API_URL}/api/applications/${applicationId}/readiness`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as ReadinessResponse;
}

async function settledReadiness(request: APIRequestContext, applicationId: string): Promise<ReadinessResponse> {
  await expect
    .poll(async () => (await readiness(request, applicationId)).analysisStatus, {
      timeout: 15_000,
      message: 'waiting for the analysis to complete',
    })
    .toBe('COMPLETE');
  return readiness(request, applicationId);
}

test.describe.configure({ mode: 'serial' });

test.describe('vendor-dispute', () => {
  test('@scenario:vendor-dispute a disputed false MongoDB blocker lets the app install without a database', async ({
    request,
  }) => {
    test.setTimeout(120_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `Dispute Vendor ${suffix}`, email: `e2e-dispute-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `Dispute App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/mongodb-app',
        repoUrl: 'https://github.com/deployz-demo/mongodb-app',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    expect((await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {})).ok()).toBeTruthy();
    const before = await settledReadiness(request, application.id);
    const mongo = before.findings.find((finding) => finding.id === MONGO_FINDING);
    expect(mongo?.blocking).toBe(true);

    // ── A hard constraint is refused; the allowlisted blocker is accepted. ──
    const refused = await request.post(`${API_URL}/api/applications/${application.id}/blocker-disputes`, {
      data: { findingId: 'unsupported-gpu', reason: mongo!.technicalEvidence },
    });
    expect(refused.status()).toBe(422);

    const disputed = await request.post(`${API_URL}/api/applications/${application.id}/blocker-disputes`, {
      data: { findingId: MONGO_FINDING, reason: mongo!.technicalEvidence },
    });
    expect(disputed.status()).toBe(202);

    const after = await settledReadiness(request, application.id);
    expect(after.findings.some((finding) => finding.id === MONGO_FINDING)).toBe(false);
    expect(after.findings.some((finding) => finding.blocking === true)).toBe(false);
    expect(after.vendorDismissedRejections).toEqual([expect.objectContaining({ findingId: MONGO_FINDING })]);

    // ── A later re-analysis keeps the answer. ──────────────────────────────
    expect(
      (await request.post(`${API_URL}/api/applications/${application.id}/analyse`, { data: { force: true } })).ok(),
    ).toBeTruthy();
    const again = await settledReadiness(request, application.id);
    expect(again.findings.some((finding) => finding.id === MONGO_FINDING)).toBe(false);
    expect(again.vendorDismissedRejections?.[0]?.stale).toBeUndefined();

    // ── The deployment passes preflight and installs with no database. ────
    await createReadyRelease(request, application.id);
    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `Dispute Customer ${suffix}`, email: `dispute-customer-${suffix}@example.com` },
    });
    expect(customerResponse.ok()).toBeTruthy();
    const customer = (await customerResponse.json()) as { id: string };

    const created = await request.post(`${API_URL}/api/deployments`, {
      data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
    });
    if (!created.ok()) {
      throw new Error(`create deployment failed: ${created.status()} ${await created.text()}`);
    }
    const { id: deploymentId, installLinkId } = (await created.json()) as {
      id: string;
      installLinkId: string;
    };

    expect((await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} })).ok()).toBeTruthy();
    const installInfo = (await request
      .get(`${API_URL}/api/install/${installLinkId}`, { headers: await installLinkHeaders(request, installLinkId) })
      .then((r) => r.json())) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const enrollmentCode = extractQuickCreateParam(installInfo.quickCreateUrl!, 'EnrollmentCode');
    const relay = startSimulatedRelay({
      scenario: getScenario('vendor-dispute'),
      apiUrl: API_URL,
      installationId: `inst-${suffix}`,
      enrollmentCode,
      relayToken: extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential'),
    });

    try {
      await expect
        .poll(
          async () => {
            const response = await request.get(`${API_URL}/api/deployments/${deploymentId}`);
            return ((await response.json()) as { state: string }).state;
          },
          { timeout: 30_000, message: 'waiting for install to reach HEALTHY' },
        )
        .toBe('HEALTHY');
      const api = buildApi(request);
      await expect
        .poll(
          async () => ((await api.getInfrastructure(deploymentId)) as { summary: { technicalResourceCount: number } }).summary.technicalResourceCount,
          { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
        )
        .toBeGreaterThan(0);
      const infra = (await api.getInfrastructure(deploymentId)) as { components: Array<{ kind: string }> };
      expect(infra.components.some((component) => component.kind === 'database')).toBe(false);
      expect(infra.components.some((component) => component.kind === 'application')).toBe(true);
    } finally {
      relay.stop();
    }
  });
});
