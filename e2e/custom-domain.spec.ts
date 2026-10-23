import { expect, test, type Page } from '@playwright/test';

// Task 12: full custom-domain lifecycle, driven by a SIMULATED relay talking
// the real HTTP protocol (`POST /api/relay/register`, `GET
// /api/relay/commands`, `POST /api/relay/commands/:id/result`) exactly as a
// real relay would, against DOMAIN_FIXTURE_MODE's deterministic DNS/HTTPS
// checks for the reserved `*.deployz-fixture.test` namespace (Task 5).
// Mirrors the signUp/seed/relay conventions already established in
// fleet.spec.ts and diagnostics.spec.ts (sign up via the UI, then drive
// everything else — seeding and the relay protocol — through `page.request`,
// which shares the signed-in session's cookies).

import { extractQuickCreateParam } from './simulation/relay-harness.js';
import { makeApplicationDeployable } from './seed-ready-manifest.js';
import { installLinkHeaders } from './install-link.js';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

interface RelayCommand {
  id: string;
  type: string;
}

async function signUp(page: Page): Promise<void> {
  const email = `e2e-domain-${crypto.randomUUID().slice(0, 8)}@example.com`;
  await page.goto('/sign-up');
  await page.getByLabel('Name').fill('E2E Domain Vendor');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('super-secret-1');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/dashboard');
}

async function seedDeployment(
  page: Page,
  suffix: string,
): Promise<{ deploymentId: string; installLinkId: string; applicationName: string }> {
  const applicationName = `Domain Test App ${suffix}`;
  const appResponse = await page.request.post(`${API_URL}/api/applications`, {
    data: {
      name: applicationName,
      githubInstallationId: 'e2e-installation',
      repoFullName: `deployz-demo/domain-test-${suffix}`,
      repoUrl: `https://github.com/deployz-demo/domain-test-${suffix}`,
      defaultBranch: 'main',
    },
  });
  expect(appResponse.ok()).toBeTruthy();
  const application = (await appResponse.json()) as { id: string };
  await makeApplicationDeployable(page.request, application.id);

  const customerResponse = await page.request.post(`${API_URL}/api/customers`, {
    data: { name: `Domain Customer ${suffix}`, email: `domain-customer-${suffix}@example.com` },
  });
  expect(customerResponse.ok()).toBeTruthy();
  const customer = (await customerResponse.json()) as { id: string };

  const deploymentResponse = await page.request.post(`${API_URL}/api/deployments`, {
    data: { applicationId: application.id, customerId: customer.id, region: 'us-east-1' },
  });
  expect(deploymentResponse.ok()).toBeTruthy();
  const deployment = (await deploymentResponse.json()) as { id: string; installLinkId: string };

  return { deploymentId: deployment.id, installLinkId: deployment.installLinkId, applicationName };
}

test('custom domain: add, verify DNS, connect, activate, appear on the dashboard, then remove', async ({
  page,
}) => {
  // Twelve steps, several of which wait on the card's 5s poll or a
  // relay-command round trip — the default 60s budget is too tight.
  test.setTimeout(90_000);
  // Clicking a DNS record's "Copy" button needs clipboard-write access.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  const suffix = crypto.randomUUID().slice(0, 8);
  const hostname = `app.${suffix}.deployz-fixture.test`;
  const installationId = `e2e-inst-${suffix}`;

  async function fetchRelayCommands(): Promise<RelayCommand[]> {
    const response = await page.request.get(
      `${API_URL}/api/relay/commands?installationId=${installationId}`,
      { headers: relayAuth },
    );
    expect(response.ok()).toBeTruthy();
    const body = (await response.json()) as { commands: RelayCommand[] };
    return body.commands;
  }

  let relayAuth: { Authorization: string };
  async function postRelayResult(jobId: string, data: Record<string, unknown>): Promise<void> {
    const response = await page.request.post(`${API_URL}/api/relay/commands/${jobId}/result`, {
      headers: relayAuth,
      data,
    });
    expect(response.ok()).toBeTruthy();
  }

  // ── 1. Seed vendor + org (UI signup) + application + customer + deployment.
  await signUp(page);
  const { deploymentId, installLinkId, applicationName } = await seedDeployment(page, suffix);

  // ── 2. Fetch the public install page data and pull the enrollment code and
  // relay credential out of the CloudFormation Quick Create link, exactly as a
  // customer's bootstrap stack would receive them as template parameters.
  // DZ-AUDIT-013: the relay credential is also carried in the URL.
  const installResponse = await page.request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(page.request, installLinkId),
    });
  expect(installResponse.ok()).toBeTruthy();
  const installData = (await installResponse.json()) as { quickCreateUrl: string | null };
  expect(installData.quickCreateUrl).not.toBeNull();
  const enrollmentCode = extractQuickCreateParam(installData.quickCreateUrl!, 'EnrollmentCode');
  const relayCredential = extractQuickCreateParam(installData.quickCreateUrl!, 'RelayCredential');
  relayAuth = { Authorization: `Bearer ${relayCredential}` };

  // ── 3. Simulate relay enrollment.
  const registerResponse = await page.request.post(`${API_URL}/api/relay/register`, {
    headers: relayAuth,
    data: { enrollmentCode, installationId, awsAccountId: '123456789012' },
  });
  expect(registerResponse.ok()).toBeTruthy();

  // ── 3b. Drive the base install to healthy. The domain card only renders
  // once the unified deployment status reaches VERIFYING/READY (see
  // InstallProgress's `canAccess` check) — a customer mid-install never sees
  // domain setup, only a customer whose app already passed health checks
  // does. Mirrors the INSTALL + health round trip in
  // deployment-progress.spec.ts's happy-path test.
  const installRound = await fetchRelayCommands();
  const installJob = installRound.find((c) => c.type === 'INSTALL');
  expect(installJob).toBeDefined();
  const albEndpoint = `deployz-alb-${suffix}.us-east-1.elb.amazonaws.com`;
  await postRelayResult(installJob!.id, {
    success: true,
    output: { outputs: { ExportDeployzApplicationPublicEndpoint: albEndpoint } },
  });
  const healthResponse = await page.request.post(`${API_URL}/api/relay/health`, {
    headers: relayAuth,
    data: { installationId, healthStatus: 'HEALTHY' },
  });
  expect(healthResponse.ok()).toBeTruthy();

  // ── 4. The vendor (already signed in from step 1) opens the install page —
  // the enrollment code has been spent, so this is the post-install view —
  // and sees the domain card's empty state (they own this deployment, so the
  // card renders in "manage" mode: an "Add"/"Remove" capable card, not the
  // read-only customer view).
  await page.goto(`/install/${installLinkId}`);
  await expect(page.getByRole('heading', { name: applicationName })).toBeVisible();
  const card = page.getByTestId('custom-domain-card');
  await expect(card.getByRole('heading', { name: 'Custom domain' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Set up custom domain' })).toBeVisible();

  // ── 5. Add the domain.
  await card.getByRole('button', { name: 'Set up custom domain' }).click();
  const addPanel = page.getByTestId('add-domain-panel');
  await addPanel.getByLabel('Domain').fill(hostname);
  await addPanel.getByRole('button', { name: 'Add domain' }).click();
  await expect(card.getByText('Setting up', { exact: true })).toBeVisible();

  // ── 6. Relay round 1: pick up the CONFIGURE_DOMAIN job `createCustomDomain`
  // queued synchronously, and report an ACM cert pending DNS validation. Both
  // the validation and routing targets end in `.deployz-fixture.test` so the
  // fixture CNAME checker (which keys off the NAME argument) approves them.
  const round1 = await fetchRelayCommands();
  const configureJobs1 = round1.filter((c) => c.type === 'CONFIGURE_DOMAIN');
  expect(configureJobs1).toHaveLength(1);
  await postRelayResult(configureJobs1[0]!.id, {
    success: true,
    output: {
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/e2e',
      certificateStatus: 'PENDING_VALIDATION',
      validationName: `_e2e.app.${suffix}.deployz-fixture.test`,
      validationValue: '_e2e.acm-validations.aws.deployz-fixture.test',
      routingTarget: 'e2e-alb.deployz-fixture.test',
      httpsConfigured: false,
    },
  });

  // ── 7. UI (poll picks it up <=5s): Waiting for DNS, both records visible,
  // Copy buttons present; copying one flips its label to "Copied".
  await expect(card.getByText('Waiting for DNS', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(card.getByText('Verify ownership', { exact: true })).toBeVisible();
  await expect(card.getByText('Route traffic', { exact: true })).toBeVisible();
  const copyButtons = card.getByRole('button', { name: 'Copy' });
  await expect(copyButtons).toHaveCount(4); // 2 records x (Name, Value)
  await copyButtons.first().click();
  await expect(card.getByRole('button', { name: 'Copied' })).toBeVisible();

  // Records must stay usable at a mobile viewport width — cheap to check
  // here since the records are already rendered.
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(card.getByText('Verify ownership', { exact: true })).toBeVisible();
  await expect(card.getByText('Route traffic', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 800 });

  // ── 8. Click "Check now": the fixture DNS check passes for both records,
  // which nudges a fresh CONFIGURE_DOMAIN job (relay round 2). Report the
  // cert issued and HTTPS configured.
  await card.getByRole('button', { name: 'Check now' }).click();
  let round2: RelayCommand[] = [];
  await expect
    .poll(
      async () => {
        round2 = await fetchRelayCommands();
        return round2.filter((c) => c.type === 'CONFIGURE_DOMAIN').length;
      },
      { timeout: 10_000, message: 'waiting for relay round 2 CONFIGURE_DOMAIN job' },
    )
    .toBe(1);
  const configureJob2 = round2.find((c) => c.type === 'CONFIGURE_DOMAIN')!;
  await postRelayResult(configureJob2.id, {
    success: true,
    output: {
      certificateArn: 'arn:aws:acm:us-east-1:123456789012:certificate/e2e',
      certificateStatus: 'ISSUED',
      routingTarget: 'e2e-alb.deployz-fixture.test',
      httpsConfigured: true,
    },
  });

  // ── 9. UI: Connecting. The relay's health heartbeat is the *usual* way
  // CONFIGURING advances to ACTIVE, but a stalled relay must not strand the
  // vendor with no recourse — so the card also renders a "Check now" button
  // here (same `CheckAndRemoveRow` used for waiting_for_dns/error). Clicking
  // it drives the exact same `runDomainCheck()` transition (CONFIGURING ->
  // ACTIVE via the fixture HTTPS probe) a relay heartbeat would otherwise
  // trigger, and the card re-renders from the check response.
  await expect(card.getByText('Connecting', { exact: true })).toBeVisible({ timeout: 10_000 });
  await card.getByRole('button', { name: 'Check now' }).click();

  await expect(card.getByText('Active', { exact: true })).toBeVisible({ timeout: 10_000 });
  // Scoped to the Access section: the custom-domain card also renders a link
  // with the same URL, and a page-wide lookup would match both.
  await expect(
    page.getByLabel('Access').getByRole('link', { name: `https://${hostname}` }),
  ).toBeVisible();
  await expect(card.getByRole('link', { name: 'Open domain' })).toBeVisible();

  // ── 10. Dashboard: the hero's access block carries the URL and domain.
  await page.goto(`/dashboard/deployments/${deploymentId}`);
  const access = page.getByTestId('app-url');
  // Generous timeout: when this is the first dashboard visit of the run, the
  // dev server's cold compile of the detail route alone can eat the default.
  await expect(access.getByText(hostname, { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(access.getByText('Active', { exact: true })).toBeVisible();
  const manageLink = access.getByRole('link', { name: 'Manage custom domain' });
  await expect(manageLink).toHaveAttribute('href', `/install/${installLinkId}`);

  await expect(access.getByText('Application URL', { exact: true })).toBeVisible();
  await expect(access.getByText(`https://${hostname}`, { exact: true })).toBeVisible();

  // ── 11. Back on the install page: remove the domain.
  await page.goto(`/install/${installLinkId}`);
  await expect(card.getByText('Active', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Remove domain' }).click();
  const removePanel = page.getByTestId('remove-domain-panel');
  await expect(removePanel.getByText('Remove custom domain?')).toBeVisible();
  await removePanel.getByRole('button', { name: 'Remove domain' }).click();
  await expect(card.getByText('Removing', { exact: true })).toBeVisible();

  // Relay round 3: pick up the REMOVE_DOMAIN job and confirm removal.
  let round3: RelayCommand[] = [];
  await expect
    .poll(
      async () => {
        round3 = await fetchRelayCommands();
        return round3.filter((c) => c.type === 'REMOVE_DOMAIN').length;
      },
      { timeout: 10_000, message: 'waiting for relay round 3 REMOVE_DOMAIN job' },
    )
    .toBe(1);
  const removeJob = round3.find((c) => c.type === 'REMOVE_DOMAIN')!;
  await postRelayResult(removeJob.id, { success: true, output: { removed: true } });

  // UI returns to the empty state once the poll picks up the removal.
  await expect(card.getByRole('button', { name: 'Set up custom domain' })).toBeVisible({
    timeout: 10_000,
  });

  // ── 12. API assertion: the domain is gone for good.
  const finalDomainResponse = await page.request.get(
    `${API_URL}/api/deployments/${deploymentId}/domain`,
  );
  expect(finalDomainResponse.ok()).toBeTruthy();
  const finalDomainBody = (await finalDomainResponse.json()) as { domain: unknown };
  expect(finalDomainBody.domain).toBeNull();
});
