import { expect, test, type Page } from '@playwright/test';

import { createReadyRelease } from './seed-ready-manifest.js';

// Environment variables setup (docs/environment-variables.md): the vendor
// → customer → release lifecycle for one required
// runtime secret. Modelled on e2e/scenario-sweep.spec.ts's use of the
// `deployz-demo/config-required-app` fixture (real analyser, real
// GITHUB_FIXTURE_MODE tree: the code reads LICENSE_KEY with no fallback,
// and SESSION_SECRET is classified as Deployz-generated) and on how
// e2e/install.spec.ts and e2e/config.spec.ts drive the public/vendor
// surfaces. Everything after sign-up rides the real HTTP API (readiness,
// environment-settings, public-install-links, public-install, config) and
// the real UI for the parts a customer or vendor would actually click
// through: the Overview state card, the Environment variables section, and
// the public install page's Application settings.

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

interface ApplicationRow {
  id: string;
  name: string;
}

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  environmentSetup: { needsDecision: number; missingValue: number } | null;
}

interface EnvironmentSetting {
  key: string;
  stage: 'build' | 'runtime';
  required: boolean;
  secret: boolean;
  provider: 'deployz' | 'vendor' | 'customer' | 'none';
  label?: string;
  help?: string;
}

interface EnvironmentSettingsResponse {
  settings: EnvironmentSetting[] | null;
}

interface PublicInstallLinkCreated {
  id: string;
  url: string;
  enabled: boolean;
}

interface DeploymentListRow {
  id: string;
  installLinkId: string;
  customerId: string;
}

async function signUp(page: Page): Promise<void> {
  const email = `e2e-envsetup-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('Env Setup Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

test('vendor configures a customer-provided secret, publishes an install link, and a customer installs it', async ({
  page,
}) => {
  test.setTimeout(90_000);

  // ── 1. Sign up, add the fixture app, analyse. ────────────────────────────
  await signUp(page);
  const suffix = crypto.randomUUID().slice(0, 8);
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: `Env Setup App ${suffix}`,
      githubInstallationId: 'e2e-installation',
      repoFullName: 'deployz-demo/config-required-app',
      repoUrl: 'https://github.com/deployz-demo/config-required-app',
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as ApplicationRow;

  const analyse = await page.request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
  expect(analyse.ok()).toBeTruthy();

  const readiness = (await page.request
    .get(`${API_URL}/api/applications/${application.id}/readiness`)
    .then((r) => r.json())) as ReadinessResponse;
  expect(readiness.analysisStatus).toBe('COMPLETE');
  // LICENSE_KEY is a genuine required+secret env var with no saved
  // decision yet — needsDecision is 1 (SESSION_SECRET is Deployz-generated,
  // never counted here).
  expect(readiness.environmentSetup?.needsDecision).toBe(1);

  // Overview: "Configuration needs review", never "Analysis failed" — an
  // analysis that completes with variables to decide is not a failure.
  await page.goto(`/dashboard/applications/${application.id}`);
  await expect(page.getByTestId('application-state-heading')).toHaveText('Configuration needs review');
  const reviewAction = page.getByTestId('readiness-review-blocker');
  await expect(reviewAction).toHaveText('Review required changes');

  // ── 2. Configuration → Environment variables: decide LICENSE_KEY. ───────
  await reviewAction.click();
  await page.waitForURL(`**/dashboard/applications/${application.id}/config#environment-variables`);

  const section = page.getByTestId('environment-variables-section');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('environment-variables-summary')).toContainText('1 needs a decision');
  const licenseRow = page.getByTestId('environment-variable-row-LICENSE_KEY');
  await expect(licenseRow).toBeVisible();
  await expect(licenseRow).toContainText('Needs a decision');

  await page.getByTestId('environment-variable-edit-LICENSE_KEY').click();
  await page.getByTestId('environment-variable-LICENSE_KEY-provider').click();
  await page.getByRole('option', { name: 'Set by customer' }).click();
  await page.locator('#env-label-LICENSE_KEY').fill('License key');
  await page.locator('#env-help-LICENSE_KEY').fill('Enter the license key we emailed you.');

  const analyseRequestsDuringSave: string[] = [];
  const onRequest = (request: { method: () => string; url: () => string }) => {
    if (request.method() === 'POST' && /\/analyse$/.test(request.url())) {
      analyseRequestsDuringSave.push(request.url());
    }
  };
  page.on('request', onRequest);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  page.off('request', onRequest);
  // Saving decisions never re-runs analysis.
  expect(analyseRequestsDuringSave).toEqual([]);

  // Overview no longer shows the review state — LICENSE_KEY now has an
  // explicit "customer" decision, so it no longer counts as needing one.
  await page.goto(`/dashboard/applications/${application.id}`);
  await expect(page.getByTestId('application-state-heading')).not.toHaveText('Configuration needs review');
  await expect(page.getByTestId('application-state-heading')).not.toHaveText('Analysis failed');

  // ── 3. Publish the public install link — succeeds although the customer
  // value is still pending. Fixture build mode (BUILD_FIXTURE_MODE) marks a
  // release READY immediately, but the fixture GITHUB_FIXTURE_MODE analysis
  // never records a commit SHA (real-mode only, see analysis.ts), so the
  // link's own auto-create-a-release fallback cannot run here — publish one
  // first, exactly as a vendor who already built a release would.
  await createReadyRelease(page.request, application.id);
  const linkResponse = await page.request.post(
    `${API_URL}/api/applications/${application.id}/public-install-links`,
  );
  expect(linkResponse.ok(), await linkResponse.text()).toBeTruthy();
  const link = (await linkResponse.json()) as PublicInstallLinkCreated;
  expect(link.enabled).toBe(true);

  // ── 4. Open the public install page as the customer. ────────────────────
  await page.goto(`/install/${link.id}`);
  await expect(page.getByRole('heading', { name: `Install ${application.name}` })).toBeVisible();

  const settingsSection = page.locator('section[aria-labelledby="public-config"]');
  await expect(settingsSection).toBeVisible();
  await expect(settingsSection.getByText('License key', { exact: true })).toBeVisible();
  await expect(settingsSection.getByText('Enter the license key we emailed you.')).toBeVisible();
  await expect(settingsSection.getByText('LICENSE_KEY', { exact: true })).toBeVisible();
  // Generated/managed keys are never asked of the customer.
  await expect(page.locator('#SESSION_SECRET')).toHaveCount(0);
  await expect(page.locator('#DATABASE_URL')).toHaveCount(0);
  await expect(page.locator('#PORT')).toHaveCount(0);

  const continueButton = page.getByRole('button', { name: 'Continue to setup' });
  await expect(continueButton).toBeDisabled();
  // One line names what blocks the action, in form order: Region first.
  await expect(page.getByText('Select an AWS Region to continue.')).toBeVisible();

  // Region choice is explicit — there is no silent first-region default.
  // The trigger has no accessible name (see final report), so it is scoped
  // by its section instead of matched by role name.
  await page.locator('section[aria-labelledby="public-region"]').getByRole('combobox').click();
  await page.getByRole('option', { name: 'US East (N. Virginia)' }).click();
  await expect(page.getByText('Complete the required application settings to continue.')).toBeVisible();

  const customerEmail = `customer-${suffix}@example.com`;
  const secretValue = `super-secret-license-${suffix}`;
  await page.locator('#customer-name').fill('Acme Customer');
  await page.locator('#customer-email').fill(customerEmail);
  await page.locator('#LICENSE_KEY').fill(secretValue);
  await expect(continueButton).toBeEnabled();
  await continueButton.click();

  await page.waitForURL((url) => /\/install\/[0-9a-f-]{36}$/.test(url.pathname) && !url.pathname.endsWith(link.id));
  const installLinkId = page.url().split('/install/')[1]!.split(/[?#]/)[0]!;
  expect(installLinkId).not.toBe(link.id);

  // ── 5. Secret redaction: the vendor never sees the typed value. ─────────
  const deployments = (await page.request
    .get(`${API_URL}/api/deployments?applicationId=${application.id}`)
    .then((r) => r.json())) as { deployments: DeploymentListRow[] };
  const createdDeployment = deployments.deployments.find((d) => d.installLinkId === installLinkId);
  expect(createdDeployment).toBeDefined();
  const customerId = createdDeployment!.customerId;

  const vendorConfig = await page.request.get(
    `${API_URL}/api/applications/${application.id}/config?customerId=${customerId}`,
  );
  expect(vendorConfig.ok()).toBeTruthy();
  const configBody = (await vendorConfig.json()) as {
    customerOverrides: { key: string; value: string | null; isSecret: boolean }[];
  };
  const licenseOverride = configBody.customerOverrides.find((entry) => entry.key === 'LICENSE_KEY');
  expect(licenseOverride).toMatchObject({ isSecret: true, value: null });

  await page.goto(`/dashboard/applications/${application.id}/config?customer=${customerId}#environment-variables`);
  const configPageText = await page.locator('body').innerText();
  expect(configPageText).not.toContain(secretValue);

  // ── 6. Build gate: a required build-stage vendor value with no value
  // refuses release creation; providing it unblocks the release. ──────────
  const currentSettings = (await page.request
    .get(`${API_URL}/api/applications/${application.id}/environment-settings`)
    .then((r) => r.json())) as EnvironmentSettingsResponse;
  const buildSetting: EnvironmentSetting = {
    key: 'NEXT_PUBLIC_API_BASE',
    stage: 'build',
    required: true,
    secret: false,
    provider: 'vendor',
  };
  const settingsWithBuildVar = [...(currentSettings.settings ?? []), buildSetting];
  const settingsWrite = await page.request.put(
    `${API_URL}/api/applications/${application.id}/environment-settings`,
    { data: { settings: settingsWithBuildVar } },
  );
  expect(settingsWrite.ok()).toBeTruthy();

  const blockedRelease = await page.request.post(`${API_URL}/api/applications/${application.id}/releases`, {
    data: { version: `1.0.0-${suffix}`, gitSha: `sha-blocked-${suffix}` },
  });
  expect(blockedRelease.status()).toBe(422);
  const blockedBody = (await blockedRelease.json()) as { error: { code: string } };
  expect(blockedBody.error.code).toBe('BUILD_CONFIGURATION_MISSING');

  const buildValueWrite = await page.request.put(`${API_URL}/api/applications/${application.id}/config`, {
    data: {
      customerId: null,
      entries: [{ key: 'NEXT_PUBLIC_API_BASE', value: 'https://api.example.com', isSecret: false }],
    },
  });
  expect(buildValueWrite.ok()).toBeTruthy();

  const unblockedRelease = await page.request.post(`${API_URL}/api/applications/${application.id}/releases`, {
    data: { version: `1.0.1-${suffix}`, gitSha: `sha-unblocked-${suffix}` },
  });
  expect(unblockedRelease.ok()).toBeTruthy();
});
