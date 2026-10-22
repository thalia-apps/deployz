import type { APIRequestContext, Page } from '@playwright/test';

import { API_URL, expect, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { fixtureSha } from './fixture-sha.js';

/**
 * Phase E: browser-level UI coverage for the simulated scenarios — the same
 * production pipeline e2e/scenario-install.spec.ts, scenario-provisioning.spec.ts
 * and scenario-lifecycle.spec.ts already exercise over the raw HTTP API, now
 * driven through a real Chromium browser against both surfaces: the customer
 * install page (`/install/:installLinkId`) and the vendor deployment detail
 * page (`/dashboard/deployments/:id`). No route mocking, no AWS-specific
 * anything in the browser layer — see
 * docs/testing/simulated-e2e.md.
 *
 * Uses the page-based `deployzBrowserInstall` fixture (./simulation/fixtures.ts)
 * rather than the request-based `deployzInstall` the other scenario specs use,
 * so the vendor session is a real signed-up-through-the-browser one. Titles
 * carry `@scenario:<id>` so this file joins the `--grep "@scenario"` suite.
 * Deliberately four tests, not one per scenario — UI coverage of every
 * scenario is not the goal (see e2e/scenario-install.spec.ts et al. for that).
 */

const JARGON = /\b(CloudFormation|IAM|ECS|ALB|Lambda|VPC|CFN|RDS)\b/;

interface VendorDeploymentStatus {
  stage: string;
  step: string;
  failure: { code: string | null; message: string; awsStatus: string | null } | null;
}

interface DeploymentResponse {
  state: string;
  applicationId: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  deploymentStatus: VendorDeploymentStatus;
}

interface ReleaseResponse {
  id: string;
  version: string;
}

interface EventRow {
  eventType: string;
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

async function getEvents(request: APIRequestContext, deploymentId: string): Promise<EventRow[]> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId}/events -> ${response.status()}`);
  }
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

async function getDeployment(page: Page, deploymentId: string): Promise<DeploymentResponse> {
  const response = await page.request.get(`${API_URL}/api/deployments/${deploymentId}`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId} -> ${response.status()}`);
  }
  return (await response.json()) as DeploymentResponse;
}

// Unlike the API-only scenario specs (which set `mode: 'parallel'` since
// they're cheap), these four tests each drive a real Chromium page against a
// `next dev` server — running them concurrently competes for the same dev
// server's on-demand route compilation and CPU, a real source of flakiness
// on a modest local machine (observed directly: Playwright's default
// scheduler still ran multiple of these tests — including repeats from
// `--repeat-each` — concurrently even with no `mode: 'parallel'` requested,
// since that only opts IN to parallelism and its absence doesn't force
// workers=1). `mode: 'serial'` on this wrapping describe is what actually
// pins the whole file to one worker, one test at a time, regardless of the
// runner's default worker count or `--repeat-each`. The four tests stay
// independent/isolated (each seeds its own org and deployment) — 'serial'
// mode's "skip the rest after a failure" behavior is accepted here as the
// trade-off for eliminating shared-dev-server contention, which is what
// actually caused every timeout-flavored failure seen while developing this
// file (fixture-setup navigations and the slow-provision timing window are
// the most sensitive to it).
test.describe('scenario-ui browser suite', () => {
  test.describe.configure({ mode: 'serial' });

  test.describe('happy-path (browser)', () => {
  test.use({ deployzScenario: 'happy-path' });
  // A generous ceiling, not the usual 30s — and set at the describe level
  // (not `test.setTimeout()` inside the body) specifically because it must
  // also cover `deployzBrowserInstall`'s own setup (sign-up through the
  // browser, seeding, the route warm-up navigations, starting the relay):
  // a `test.setTimeout()` call only takes effect from the line it executes,
  // so it never protects time already spent in fixtures before the test body
  // even starts. Under a loaded dev server (e.g. many heavy browser tests
  // back to back — see this file's verification notes) that setup alone can
  // occasionally take longer than the plain 60s default. Steady-state runs
  // finish this whole test in well under 30s.
  test.describe.configure({ timeout: 90_000 });

  test('@scenario:happy-path customer install page and vendor detail page both render the healthy outcome', async ({
    page,
    deployzBrowserInstall,
  }) => {
    const { deploymentId, installLinkId, api } = deployzBrowserInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');

    // ── Customer install page. No custom domain is configured in this phase
    // (see e2e/scenario-install.spec.ts's own comment on this), so the base
    // install stays HTTP-only and the honest terminal presentation here is
    // VERIFYING/TLS — "Checking your application" with the secure-address
    // nudge — not the READY "Your application is ready" headline, which
    // requires an https:// URL nothing in this test ever sets up.
    await page.goto(`/install/${installLinkId}`);
    await expect(
      page.getByRole('heading', { name: 'Checking your application' }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByText(/Set up a custom domain below for a secure address\./),
    ).toBeVisible();
    // The grouped step list reflects real progress, not a percentage: every
    // rung through health is done, https is the one still active. Completed
    // rungs collapse into "N steps done" (ux-guidelines §9) — expand it to
    // see them. A rung's label follows its own state (never a static word):
    // the done infrastructure/application/health rungs read their done copy,
    // and the active https rung says what it waits for.
    // The anchored regexes keep the label spans from substring-colliding with
    // the activity feed's own sentences ("Application passed health checks.").
    // The legacy wire-step list shares labels with the redesigned rung text
    // (same source: STEP_LABEL.done), so the assertions are scoped to its
    // own testid to keep Playwright strict mode from matching both.
    await page.getByRole('button', { name: 'Deployment details' }).click();
    await page.getByTestId('step-list-done-toggle').click();
    const doneList = page.getByTestId('step-list-done-list');
    await expect(doneList.getByText(/^Network created/)).toBeVisible();
    await expect(doneList.getByText(/^Database & storage created/)).toBeVisible();
    await expect(doneList.getByText(/^Application started/)).toBeVisible();
    await expect(doneList.getByText(/^Health check/)).toBeVisible();
    // The active wire step is rendered OUTSIDE the done-list (it carries
    // its own (in progress) annotation + the awaiting-domain detail line
    // below it). Asserting its label inside the done-list would be wrong
    // by construction — the done-list only contains steps the deployment
    // has finished. The awaiting-domain detail is the customer-facing
    // proof that the TLS step is the one still active.
    await expect(
      page.getByTestId('tracker-current-detail').getByText('Waiting for a custom domain to be added.'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Access' })).toBeVisible();
    await page.getByRole('button', { name: 'Deployment details' }).click();
    const customerBodyText = await page.locator('body').innerText();
    expect(customerBodyText).not.toMatch(JARGON);

    // ── Vendor deployment detail page: healthy lifecycle state, the same
    // honest VERIFYING stage on the progress card, the Infrastructure section
    // populated from the persisted resource inventory, and the raw
    // CloudFormation event feed behind its own disclosure.
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    await expect(page.getByTestId('deployment-status-badge')).toHaveText('Live', { timeout: 15_000 });
    // Still VERIFYING on the wire (HTTP-only), but the app is confirmed
    // healthy and reachable, so the vendor hero reads as live and carries
    // the address.
    const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
    await expect(progressCard.locator('[aria-live="polite"]')).toHaveText('Your application is live');
    await expect(progressCard.getByRole('link', { name: 'Open application' })).toBeVisible();

    const infraSection = page.locator('section[aria-labelledby="infrastructure"]');
    await expect(infraSection.getByText('Application', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(infraSection.getByText('Database', { exact: true })).toBeVisible();
    await expect(infraSection.getByText('Storage', { exact: true })).toBeVisible();
    await expect(infraSection.getByText('Secure endpoint', { exact: true })).toBeVisible();

    // Infrastructure events: the raw CFN feed, default-collapsed (§ raw-
    // diagnostics surface — docs/ui-system.md), behind its own disclosure
    // inside the collapsed Technical details section.
    await page.getByRole('button', { name: 'Technical details' }).click();
    const eventsTrigger = page.getByRole('button', { name: /Infrastructure events/ });
    await expect(eventsTrigger).toBeVisible();
    await eventsTrigger.click();
    // happy-path's timeline reports ApplicationDatabase twice (CREATE_IN_PROGRESS,
    // then CREATE_COMPLETE) — two distinct persisted rows, so `.first()` here.
    await expect(page.getByText('ApplicationDatabase', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('AWS::RDS::DBInstance', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('CREATE_COMPLETE').first()).toBeVisible();
  });
});

test.describe('slow-provision (browser)', () => {
  test.use({ deployzScenario: 'slow-provision' });
  // See happy-path's describe block above for why this is set here (covers
  // fixture setup) rather than via `test.setTimeout()` in the body.
  test.describe.configure({ timeout: 90_000 });

  test('@scenario:slow-provision customer install page shows genuine in-flight provisioning, then the healthy outcome', async ({
    page,
    deployzBrowserInstall,
  }) => {
    const { deploymentId, installLinkId, api } = deployzBrowserInstall;

    // The scenario holds RDS at CREATE_IN_PROGRESS for ~3.5 real seconds (see
    // ./simulation/scenarios/slow-provision.ts) — a real window to catch a
    // genuine mid-flight rendering in, not an artificial delay this test
    // adds. The install page is a `force-dynamic` server component, so each
    // navigation re-derives its own server truth; poll by re-navigating
    // rather than relying on the client's 5s poll interval to land inside
    // this short window.
    await expect
      .poll(
        async () => {
          await page.goto(`/install/${installLinkId}`, { waitUntil: 'domcontentloaded' });
          return page.getByText('Creating database & storage').isVisible();
        },
        { timeout: 3_200, message: 'waiting for the install page to render the DATABASE_STORAGE step' },
      )
      .toBe(true);

    await expect(
      page.getByRole('heading', { name: 'Creating application infrastructure' }),
    ).toBeVisible();
    // A real step in progress — never a false completion of a later step or
    // the terminal outcome.
    await expect(page.getByRole('heading', { name: 'Your application is ready' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Checking your application' })).toHaveCount(0);
    // No percentages or countdowns anywhere in this product.
    const midFlightText = await page.locator('body').innerText();
    expect(midFlightText).not.toContain('%');

    // Terminal outcome: still reaches the same honest healthy presentation as
    // happy-path (no custom domain configured, so VERIFYING/TLS, not READY).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');
    await page.goto(`/install/${installLinkId}`);
    await expect(
      page.getByRole('heading', { name: 'Checking your application' }),
    ).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('cloudformation-rollback (browser)', () => {
  test.use({ deployzScenario: 'cloudformation-rollback' });
  // See happy-path's describe block above for why this is set here (covers
  // fixture setup) rather than via `test.setTimeout()` in the body.
  test.describe.configure({ timeout: 90_000 });

  test('@scenario:cloudformation-rollback vendor and customer surfaces both show an honest failure, never a stuck or false-healthy install', async ({
    page,
    deployzBrowserInstall,
  }) => {
    const { deploymentId, installLinkId, api } = deployzBrowserInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    // ── Vendor detail page.
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
    // A destructive tone renders the §6 recovery panel (FailurePanel): the
    // headline is its AlertTitle, not a plain heading.
    await expect(
      progressCard.locator('[aria-live="polite"]'),
    ).toHaveText('Install failed', { timeout: 15_000 });
    // §29 human-readable failure copy (packages/copy-map), not raw AWS jargon
    // at the top level — refined server-side to DATABASE_CREATE_FAILED (the
    // failed resource is the RDS instance), so the database remediation text.
    // The same vendorMessage also doubles as `currentActivity`
    // (apps/api/src/deployment-status.ts), so it legitimately renders twice
    // on this card (the activity line, and the failure Alert's title) — `.first()`
    // rather than a stricter locator, since either occurrence proves the copy.
    await expect(
      page.getByText('The database could not be created.').first(),
    ).toBeVisible();
    // Scoped to the sections a vendor reads as the primary explanation of
    // this failure — NOT the whole page. The infrastructure section is
    // excluded: since §16.2 it shows the resource snapshot on failed
    // installs (component story first, AWS service chips and stack status
    // as the vendor's technical inventory, deeper detail behind each row's
    // disclosure), which is asserted separately below. Product finding
    // (not fixed here, per this task's instructions): the Recent Activity
    // section's `eventFailureReason` (apps/web/src/lib/deployment-vocabulary.ts),
    // rendered at the top level of each ActivityFeed row (apps/web/src/
    // components/activity-feed.tsx), surfaces the relay's raw internal error
    // string — which for a STACK_CREATE_FAILED install embeds a raw CFN
    // resource type ("AWS::RDS::DBInstance") — outside that component's own
    // documented disclosure boundary ("the raw event type, result code, and
    // payload live behind an accessible button-driven disclosure"). That is
    // a real §65 jargon leak into primary vendor UI, reported separately;
    // this assertion pins the sections that ARE honestly jargon-free rather
    // than silently widening the regex or touching product code.
    for (const sectionId of ['actions', 'deployment-progress', 'overview']) {
      const sectionText = await page.locator(`section[aria-labelledby="${sectionId}"]`).innerText();
      expect(sectionText).not.toMatch(JARGON);
    }

    // A failed, never-installed deployment: Retry deployment is the one
    // primary action, day-2 actions are not offered at all (nothing ever
    // ran), and Disconnect stays available in the overflow menu — the relay
    // registered and reported its capabilities before the install itself
    // failed, so it is not gated on having ever completed one (see
    // `everInstalled`/`actionSupported` in
    // apps/web/src/lib/deployment-vocabulary.ts).
    const actionsSection = page.locator('section[aria-labelledby="actions"]');
    await expect(actionsSection.getByRole('button', { name: 'Retry deployment' })).toBeEnabled();
    await expect(actionsSection.getByRole('button', { name: 'Deploy Update' })).toHaveCount(0);
    await expect(actionsSection.getByRole('button', { name: 'Configuration' })).toHaveCount(0);
    await actionsSection.getByRole('button', { name: 'More actions' }).click();
    await expect(page.getByRole('menuitem', { name: 'Rollback' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Restart' })).toHaveCount(0);
    await expect(page.getByRole('menuitem', { name: 'Remove deployment' })).toBeEnabled();
    await page.keyboard.press('Escape');
    // The activity feed's top level is jargon-free too: the classified
    // failure's plain-English summary, never the relay's raw error string.
    const activitySection = page.locator('section[aria-labelledby="activity"]');
    expect(await activitySection.innerText()).not.toMatch(JARGON);

    // Infrastructure: §16.2 failure visibility — the resource snapshot is
    // shown on failed installs so the vendor can debug. The redesigned
    // section leads with the plain-English service summary (Database,
    // Network, Relay), and the deeper per-component inventory — lifecycle
    // copy included — sits behind the "View components and N AWS resources"
    // disclosure.
    const infrastructureSection = page.locator('section[aria-labelledby="infrastructure"]');
    await expect(infrastructureSection.getByText('Database', { exact: true })).toBeVisible();
    await expect(infrastructureSection.getByText('Network', { exact: true })).toBeVisible();
    await expect(infrastructureSection.getByText('Deployz connector', { exact: true })).toBeVisible();
    await infrastructureSection
      .getByRole('button', { name: /View components and \d+ AWS resource/ })
      .click();
    await expect(
      infrastructureSection.getByText('Retained when deployment is removed.'),
    ).toBeVisible();

    // The real classification is folded into the recovery panel.
    await expect(page.getByTestId('diagnostic-explanation')).toBeVisible();
    await expect(page.getByTestId('diagnostic-explanation').getByText('How to fix it')).toBeVisible();

    // ── Customer install page: the failure shown honestly, no stuck spinner,
    // never a false Healthy/Ready.
    await page.goto(`/install/${installLinkId}`);
    await expect(page.getByRole('heading', { name: 'Deployment failed' })).toBeVisible();
    await expect(page.getByText('What happened', { exact: true })).toBeVisible();
    // Refined server-side to DATABASE_CREATE_FAILED — the customer sees the
    // database description, not the generic stack one.
    await expect(page.getByText("The database couldn't be created.")).toBeVisible();
    await expect(page.locator('svg.animate-spin')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your application is ready' })).toHaveCount(0);
    await expect(page.getByText('Healthy', { exact: true })).toHaveCount(0);
    const customerBodyText = await page.locator('body').innerText();
    expect(customerBodyText).not.toMatch(JARGON);
  });
});

test.describe('update-failure then rollback-success (browser)', () => {
  // rollback-success's `updateRollouts` ([succeed, succeed, fail, succeed]) is
  // exactly update-failure's own setup plus the rollback outcome this test needs —
  // one scenario definition covers both halves of this flow.
  test.use({ deployzScenario: 'rollback-success' });
  // The most expensive of the four: three real relay job round trips
  // (INSTALL, two DEPLOY_RELEASE, one ROLLBACK) plus several full page
  // reloads, so it gets the largest ceiling of the four — still well under
  // it in the common case (see this file's verification notes). Set at the
  // describe level (see happy-path's describe block above) so it also
  // covers `deployzBrowserInstall`'s own setup time.
  test.describe.configure({ timeout: 120_000 });

  test('@scenario:update-failure @scenario:rollback-success a failed update reflects on the vendor page, then rollback restores healthy', async ({
    page,
    deployzBrowserInstall,
  }) => {
    const { deploymentId, api } = deployzBrowserInstall;
    // Authenticated calls in this test go through `page.request` (the
    // browser's own session cookie — see ./simulation/fixtures.ts's
    // `deployzBrowserInstall`), never the bare `request` fixture, which
    // holds no session at all here.
    const request = page.request;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    await waitForInstallAutoDeploy(api, deploymentId);
    const installed = await getDeployment(page, deploymentId);
    const applicationId = installed.applicationId;

    // Releases are authored by a CI build reporting back (or, locally, the
    // inline READY fallback) — there is no browser flow that publishes one,
    // so this is seeded via the API exactly like scenario-lifecycle.spec.ts
    // does. It is not part of the deploy/rollback action surface this test
    // is pinning.
    const v1ReleaseId = await createRelease(request, applicationId, '1.0.0');

    // ── v1 deploys through the REAL "Deploy Update" button. Scoped to the
    // Actions section throughout this test for the same reason as the
    // cloudformation-rollback test's action-button assertions: Playwright's
    // role-name matching is a case-insensitive substring match, and the
    // Recent Activity feed can carry raw text that collides with a short
    // action-button name.
    const actionsSection = page.locator('section[aria-labelledby="actions"]');
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    await expect(actionsSection.getByRole('button', { name: 'Deploy Update' })).toBeEnabled();
    await actionsSection.getByRole('button', { name: 'Deploy Update' }).click();
    const deployPanel = page.getByTestId('deploy-update-panel');
    await expect(deployPanel).toBeVisible();
    await deployPanel.getByRole('button', { name: 'Deploy update' }).click();
    await expect(deployPanel).toBeHidden();

    // Poll the release POINTER, not the state: this deployment is already
    // HEALTHY when the deploy starts, so polling `state` can return on its
    // very first read and assert the pointer before the deploy has settled
    // (seen failing in CI while the sibling run passed).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).currentReleaseId, {
        timeout: 15_000,
        message: 'waiting for the v1 deploy to advance the release pointer',
      })
      .toBe(v1ReleaseId);
    const afterV1 = await getDeployment(page, deploymentId);
    expect(afterV1.state).toBe('HEALTHY');

    // ── v2 is published (API — same reasoning as v1 above) and deployed
    // through the REAL "Deploy Update" button; the ECS deployment circuit
    // breaker trips per this scenario's `updateRollouts`.
    const v2ReleaseId = await createRelease(request, applicationId, '2.0.0');
    await page.reload();
    // 30s, not the usual 15s: when the whole scenario suite runs in one local
    // pass, this reload competes with every other test for the dev server's
    // route compilation and CPU, and this re-enable was the one observed
    // local-flake point in the suite.
    await expect(actionsSection.getByRole('button', { name: 'Deploy Update' })).toBeEnabled({
      timeout: 30_000,
    });
    await actionsSection.getByRole('button', { name: 'Deploy Update' }).click();
    await expect(deployPanel).toBeVisible();
    await deployPanel.getByRole('button', { name: 'Deploy update' }).click();

    // Failed-update semantics: the deployment returns to UPDATE_AVAILABLE —
    // the circuit breaker restored v1, which never stopped serving — and the
    // FAILED job carries the failure. Never a whole-deployment FAILED.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for the v2 rollout to fail',
      })
      .toBe('UPDATE_AVAILABLE');
    // The release pointer never advanced to v2 — v1 is still what is
    // actually running behind the load balancer.
    const afterV2 = await getDeployment(page, deploymentId);
    expect(afterV2.currentReleaseId).toBe(v1ReleaseId);
    expect(afterV2.currentReleaseId).not.toBe(v2ReleaseId);

    // ── The vendor page reflects the failed update honestly WITHOUT
    // presenting the deployment as down: the hero names the failed update,
    // says the running release is unaffected, and the release pointer never
    // advanced past the last release that actually deployed (v1).
    await page.reload();
    const progressCard = page.locator('section[aria-labelledby="deployment-progress"]');
    await expect(
      progressCard.locator('[aria-live="polite"]'),
    ).toHaveText('Update failed', { timeout: 15_000 });
    await expect(
      progressCard.getByText('The new version could not be rolled out.'),
    ).toBeVisible();
    // The impact line names v1.0.0 as the running release; while its own
    // health checks fail it must not also call it unaffected.
    await expect(progressCard.getByText(/^Release v1\.0\.0 is still (live and unaffected|the running release)/)).toBeVisible();
    await expect(page.getByText('v1.0.0', { exact: true }).first()).toBeVisible();

    // The Rollback button targets `previousReleaseId` — production's own
    // "roll back one step" semantics — which is the release v1 replaced (the
    // post-install auto-deployed 0.1.0), because v2's deploy never succeeded
    // (only a SUCCEEDED job ever advances the release pointers, per
    // apps/api/src/server.ts's job-result handler). There is genuinely no
    // button on this page that can target "roll back to v1" specifically,
    // even though v1 is exactly what is still running behind the load
    // balancer. This is a real product/UI gap, not a harness limitation, so
    // this test falls back to the API (as scenario-lifecycle.spec.ts's
    // rollback-success test does) for the rollback itself, after first
    // pinning what the button honestly offers.
    await actionsSection.getByRole('button', { name: 'More actions' }).click();
    const rollbackItem = page.getByRole('menuitem', { name: /Rollback/ });
    await expect(rollbackItem).toBeEnabled();
    await expect(rollbackItem).toContainText('Rollback to v0.1.0');
    await page.keyboard.press('Escape');

    const rollbackResponse = await request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
      data: { releaseId: v1ReleaseId },
    });
    expect(rollbackResponse.status()).toBe(202);

    // The ROLLBACK job's own event is the settlement signal (not
    // deployment.state — see scenario-lifecycle.spec.ts's rollback-success
    // test for why polling state here would race production's own
    // self-healing state-recovery rule).
    await expect
      .poll(
        async () => {
          const events = await getEvents(request, deploymentId);
          return events.some((e) => e.eventType === 'rollback.completed');
        },
        { timeout: 15_000, message: 'waiting for the rollback job to settle' },
      )
      .toBe(true);

    // ── The vendor page shows healthy again.
    await page.reload();
    await expect(page.getByTestId('deployment-status-badge')).toHaveText('Live', { timeout: 15_000 });
    await expect(progressCard.locator('[aria-live="polite"]')).toHaveText('Your application is live');
    await expect(page.getByText('The new version could not be rolled out.')).toHaveCount(0);
    await expect(page.getByText('v1.0.0', { exact: true }).first()).toBeVisible();
    const afterRollback = await getDeployment(page, deploymentId);
    // UPDATE_AVAILABLE is truthful after the rollback: v2 is still READY and
    // newer than the running v1 (a rollback is an older-release deployment —
    // DZ-AUDIT-007's invariant). The page must still show v1 as live.
    expect(afterRollback.state).toBe('UPDATE_AVAILABLE');
    expect(afterRollback.currentReleaseId).toBe(v1ReleaseId);
    // The rollback recorded the pointer the deployment carried into it —
    // v1, the very release it restored — so previous == current. The page
    // must not offer a rollback to the version already running.
    expect(afterRollback.previousReleaseId).toBe(v1ReleaseId);
    await actionsSection.getByRole('button', { name: 'More actions' }).click();
    const rollbackAfter = page.getByRole('menuitem', { name: /Rollback/ });
    await expect(rollbackAfter).toBeDisabled();
    await expect(rollbackAfter).toContainText(
      'The previous release is already running.',
    );
    await page.keyboard.press('Escape');
  });
  });
});
