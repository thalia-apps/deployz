import { expect, test, type Page } from '@playwright/test';
import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, fetchInstallCredentials } from './simulation/relay-harness.js';

// Redis Support MVP (tasks 1-9): §7 Redis detection + §8 the managed,
// automatic-provisioning path for supported Redis usage. Fixture mode (Task
// 5) ships two purpose-built fixture repos alongside the existing
// deployz-demo/express-api: `bullmq-worker` (fixture-repo-3) is otherwise
// READY-shaped with a direct BullMQ dependency — a supported, high-confidence
// Redis requirement that should analyse as ready with the "Redis detected —
// provisioned automatically on install" passed check, then carry a Cache
// component through the install plan and the deployment's Infrastructure section.
// `legacy-redis` (fixture-repo-2) depends on Redis Stack modules
// (@redis/json), which fall outside Deployz's managed Redis profile and must
// still hard-reject with "Your app uses Redis features Deployz can't
// provide" (§10). Mirrors
// the signUp/seed-via-page.request conventions of custom-domain.spec.ts and
// the real-analyser conventions of readiness.spec.ts (no fabricated verdicts
// — analysis runs for real against GITHUB_FIXTURE_MODE's fixture file trees).

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

async function signUp(page: Page): Promise<void> {
  const email = `e2e-redis-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Redis Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

/**
 * Creates a real Application from a fixture repo's `fullName` and triggers
 * analysis, exactly as choosing a repo on /dashboard/applications would
 * (RepoRow.onChoose in apps/web). `POST /:id/analyse` runs the real
 * deterministic analyser inline (no queue configured locally), so by the time
 * this resolves `analysisStatus` is already COMPLETE — mirrors the
 * near-instant fixture-mode analysis readiness.spec.ts relies on.
 */
async function seedAnalysedApplication(
  page: Page,
  repoFullName: string,
  suffix: string,
): Promise<{ applicationId: string }> {
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Redis Test ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName,
      repoUrl: `https://github.com/${repoFullName}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };

  const analyseResponse = await page.request.post(
    `${API_URL}/api/applications/${application.id}/analyse`,
  );
  expect(analyseResponse.ok()).toBeTruthy();

  return { applicationId: application.id };
}

async function seedCustomerAndDeployment(
  page: Page,
  applicationId: string,
  suffix: string,
): Promise<{ deploymentId: string; installLinkId: string; installationId: string; enrollmentCode: string; relayCredential: string }> {
  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Redis Customer ${suffix}`, email: `redis-customer-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };
  await createReadyRelease(page.request, applicationId);

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as {
    id: string;
    installLinkId: string;
    enrollmentCode: string;
  };

  const installResponse = await page.request.get(`${API_URL}/api/install/${deployment.installLinkId}`);
  expect(installResponse.ok()).toBeTruthy();
  const installData = (await installResponse.json()) as { quickCreateUrl: string | null };
  expect(installData.quickCreateUrl).not.toBeNull();
  const relayCredential = extractQuickCreateParam(installData.quickCreateUrl!, 'RelayCredential');

  return {
    deploymentId: deployment.id,
    installLinkId: deployment.installLinkId,
    installationId: `inst-${suffix}`,
    enrollmentCode: deployment.enrollmentCode,
    relayCredential,
  };
}

/**
 * Drives a fresh deployment to HEALTHY via the real relay job workflow —
 * mirrors fleet.spec.ts's `driveDeploymentToHealthy`. The Infrastructure
 * section (including the Redis row) only renders once the deployment is past
 * the pre-install states (see `showInfrastructureRows` in
 * apps/web/src/lib/deployment-vocabulary.ts), so a deployment that was never
 * installed shows the section's empty state instead — no Redis row to find.
 */
async function driveDeploymentToHealthy(
  page: Page,
  installationId: string,
  enrollmentCode: string,
  relayCredential: string,
): Promise<void> {
  const authHeaders = { Authorization: `Bearer ${relayCredential}` };
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: authHeaders,
    data: { installationId, enrollmentCode },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const commandsResponse = await page.request.get(
    `${API_URL}/api/relay/commands?installationId=${installationId}`,
    { headers: authHeaders },
  );
  const { commands } = (await commandsResponse.json()) as { commands: { id: string; type: string }[] };
  const installJob = commands.find((command) => command.type === 'INSTALL');
  expect(installJob).toBeDefined();

  const resultResponse = await page.request.post(
    `${API_URL}/api/relay/commands/${installJob!.id}/result`,
    { headers: authHeaders, data: { success: true } },
  );
  expect(resultResponse.ok()).toBeTruthy();
}

test('bullmq-worker: analyses as ready with the managed Redis passed check, then carries a Redis cache through install + deployment detail', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  // ── 1. Sign up, connect the fixture org (implicit — fixture mode serves
  // it), select bullmq-worker, and trigger analysis.
  await signUp(page);
  const { applicationId } = await seedAnalysedApplication(
    page,
    'deployz-demo/bullmq-worker',
    suffix,
  );

  // ── 2. Readiness UI: the app is deployable, and the Redis check is visible
  // in the collapsed Passed checks group — never a fabricated verdict, this
  // is the real §18/§19 analyser run against the fixture file tree.
  await page.goto(`/dashboard/applications/${applicationId}`);
  // The single state card shows the verdict. Recommended findings never
  // block readiness, so the heading is ready.
  await expect(page.getByTestId('application-state-heading')).toHaveText('Ready for a test deployment');

  // The services table lives on the Configuration tab.
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  await expect(page.getByTestId('services-table')).toBeVisible();
  // Scoped to the Configuration tab's own section: the analysis summary.
  await expect(
    page.getByRole('region', { name: 'Resources' }).getByText('No blocking issues'),
  ).toBeVisible();
  // BullMQ jobs run in the web process by default: no worker question (REM-103).
  await expect(
    page
      .getByTestId('services-table')
      .getByText('Background job runner', { exact: false }),
  ).toHaveCount(0);

  // ── 3. Create a customer + deployment for this application, then open the
  // install link page: the "Deployz will create" table includes a Cache
  // component because this application's analysed `redisRequired` is true.
  const { deploymentId, installLinkId, installationId, enrollmentCode, relayCredential } =
    await seedCustomerAndDeployment(page, applicationId, suffix);
  await page.goto(`/install/${installLinkId}`);
  // The customer review names components; the AWS resource names (the
  // ElastiCache cache among them) are in the collapsed "View AWS resources"
  // disclosure.
  const willCreateSection = page.locator('section[aria-labelledby="aws-resources"]');
  await willCreateSection.getByRole('button', { name: 'View AWS resources' }).click();
  await expect(
    willCreateSection.getByRole('cell', { name: 'ElastiCache Valkey cache', exact: true }),
  ).toBeVisible();

  // ── 4. Deployment detail: the Infrastructure section lists the cache
  // component. That section renders from the persisted resource inventory
  // (§59, apps/web/src/components/infrastructure-section.tsx), not from the
  // `components` health map — so a Redis row only appears once the relay's
  // ListStackResources read (including the ElastiCache replication group) is
  // persisted via persistDeploymentResourceSnapshot
  // (packages/db/src/deployment-resources-persist.ts). It also only renders
  // once the deployment is past the pre-install states (see
  // `showInfrastructureRows`), so drive a real install through the relay job
  // workflow first — the same sequence fleet.spec.ts's
  // `driveDeploymentToHealthy` uses — then report the inventory.
  await driveDeploymentToHealthy(page, installationId, enrollmentCode, relayCredential);
  const health = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: { Authorization: `Bearer ${relayCredential}` },
    data: {
      installationId,
      healthStatus: 'HEALTHY',
      observedState: {
        infraHealth: {
          inventory: {
            stackId: `arn:aws:cloudformation:us-east-1:123456789012:stack/e2e-redis-${suffix}/${crypto.randomUUID()}`,
            observedAt: new Date().toISOString(),
            resources: [
              {
                logicalId: 'WebService',
                type: 'AWS::ECS::Service',
                status: 'CREATE_COMPLETE',
                physicalId: 'arn:aws:ecs:us-east-1:123456789012:service/e2e-redis-app',
              },
              {
                logicalId: 'RedisCache',
                type: 'AWS::ElastiCache::ReplicationGroup',
                status: 'CREATE_COMPLETE',
                physicalId: `redis-${suffix}`,
              },
            ],
          },
        },
      },
    },
  });
  expect(health.ok()).toBeTruthy();

  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const infraSection = page.locator('section[aria-labelledby="infrastructure"]');
  await expect(infraSection.getByText('Cache', { exact: true })).toBeVisible();
});

test('legacy-redis: analyses as unsupported — "Your app uses Redis features Deployz can\'t provide"', async ({
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8);

  await signUp(page);
  const { applicationId } = await seedAnalysedApplication(
    page,
    'deployz-demo/legacy-redis',
    suffix,
  );

  await page.goto(`/dashboard/applications/${applicationId}`);
  // The unsupported Redis setup is a blocking rejection, so the state is
  // configuration-required (packages/analysis/src/readiness-report.ts's
  // REDIS_COPY) and the heading reads out the required-change count.
  await expect(page.getByTestId('application-state-heading')).toHaveText(/change[s]? required/);

  // The services table lives on the Configuration tab. The rejection is a
  // 'cache'-category finding, so it folds into the Cache / queue row rather
  // than rendering as its own row (application-configuration.ts).
  await page.getByRole('tab', { name: 'Configuration' }).click();
  await page.waitForURL('**/config');
  const redisRow = page.getByTestId('readiness-setting-redis');
  await expect(redisRow).toBeVisible();
  await expect(redisRow).toContainText('Change required');
  await redisRow.getByRole('button', { name: /Details for/ }).click();
  // Scoped to the popover: the same explanation also appears, unscoped, in
  // the always-visible "Required changes" panel above the table.
  await expect(
    page
      .locator('[data-slot="popover-content"]')
      .getByText('This app uses Redis features Deployz cannot provide', { exact: false }),
  ).toBeVisible();
});
