import type { APIRequestContext } from '@playwright/test';

import { API_URL, expect, test, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { fixtureSha } from './fixture-sha.js';

/**
 * P0: a READY release whose image no longer exists in the registry is not a
 * deployable release. The vendor page lists the release while its image
 * still exists, the image is deleted (the BUILD_FIXTURE_MODE registry
 * fixture, `/internal/fixture/release-images`), and the vendor presses
 * Deploy. The API must refuse server-side (409 RELEASE_UNAVAILABLE), queue
 * nothing, keep the running release live, and the next list must read
 * UNAVAILABLE so the deploy picker stops offering it. Same shape as the
 * scenario-ui browser tests: real Chromium, real pipeline, no route mocks.
 */

interface ReleaseRow {
  id: string;
  version: string;
  status: string;
}

async function createRelease(request: APIRequestContext, applicationId: string, version: string): Promise<string> {
  const response = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version, gitSha: fixtureSha(version) },
  });
  if (!response.ok()) {
    throw new Error(`create release ${version} failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

async function listReleases(request: APIRequestContext, applicationId: string): Promise<ReleaseRow[]> {
  const response = await request.get(`${API_URL}/api/applications/${applicationId}/releases`);
  if (!response.ok()) {
    throw new Error(`list releases failed: ${response.status()} ${await response.text()}`);
  }
  return ((await response.json()) as { releases: ReleaseRow[] }).releases;
}

test.describe('release-unavailable browser suite', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ deployzScenario: 'happy-path' });
  // Set at the describe level so it also covers `deployzBrowserInstall`'s own
  // setup (sign-up, seeding, the route warm-up navigations) on a cold dev
  // server — see e2e/scenario-ui.spec.ts for the reasoning.
  test.describe.configure({ timeout: 120_000 });

  test('@scenario:release-unavailable a release whose image was deleted after the page loaded is refused server-side and marked Unavailable', async ({
    page,
    deployzBrowserInstall,
  }) => {
    const { deploymentId, api } = deployzBrowserInstall;
    const request = page.request;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for install to reach HEALTHY',
      })
      .toBe('HEALTHY');
    const runningBefore = await waitForInstallAutoDeploy(api, deploymentId);
    const installed = (await api.getDeployment(deploymentId)) as { applicationId: string };
    const applicationId = installed.applicationId;

    // The release exists and its image exists: the vendor page lists it READY.
    const releaseId = await createRelease(request, applicationId, '1.0.0');
    expect((await listReleases(request, applicationId)).find((r) => r.id === releaseId)?.status).toBe('READY');
    // Publishing a release moves a healthy deployment to UPDATE_AVAILABLE;
    // the refused deploy must leave that state exactly as it is.
    const stateBefore = (await api.getDeployment(deploymentId)).state;

    const actionsSection = page.locator('section[aria-labelledby="actions"]');
    await page.goto(`/dashboard/deployments/${deploymentId}`);
    await expect(actionsSection.getByRole('button', { name: 'Deploy Update' })).toBeEnabled({ timeout: 30_000 });
    await actionsSection.getByRole('button', { name: 'Deploy Update' }).click();
    const deployPanel = page.getByTestId('deploy-update-panel');
    await expect(deployPanel).toBeVisible();

    // The image is deleted from the registry while the dialog is open.
    const deleted = await request.post(`${API_URL}/internal/fixture/release-images`, {
      data: { releaseId, missing: true },
    });
    expect(deleted.ok()).toBe(true);

    await deployPanel.getByRole('button', { name: 'Deploy update' }).click();
    await expect(deployPanel.getByText('This version can no longer be deployed')).toBeVisible();
    await expect(deployPanel.getByText('Create a new release to deploy it again.')).toBeVisible();
    await expect(deployPanel).toBeVisible();

    // Server-side: 409, nothing queued, the running release untouched.
    const direct = await request.post(`${API_URL}/api/deployments/${deploymentId}/deploy`, {
      data: { releaseId },
    });
    expect(direct.status()).toBe(409);
    expect(((await direct.json()) as { error: { code: string } }).error.code).toBe('RELEASE_UNAVAILABLE');
    const after = (await api.getDeployment(deploymentId)) as { state: string; currentReleaseId: string | null };
    expect(after.state).toBe(stateBefore);
    expect(after.currentReleaseId).toBe(runningBefore);
    const events = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
    const eventRows = ((await events.json()) as { events: Array<{ eventType: string; releaseId: string | null }> }).events;
    // The post-install auto-deploy has its own deploy.requested; the refused release has none.
    expect(eventRows.filter((e) => e.eventType === 'deploy.requested' && e.releaseId === releaseId)).toEqual([]);

    // The list now reads UNAVAILABLE and the picker no longer offers it.
    expect((await listReleases(request, applicationId)).find((r) => r.id === releaseId)?.status).toBe('UNAVAILABLE');
    await page.reload();
    await expect(actionsSection.getByRole('button', { name: 'Deploy Update' })).toBeEnabled({ timeout: 30_000 });
    await actionsSection.getByRole('button', { name: 'Deploy Update' }).click();
    await expect(page.getByTestId('deploy-update-panel')).toBeVisible();
    await expect(page.getByTestId('deploy-update-panel').getByText('No deployable releases yet')).toBeVisible();

    // The releases page names the reason in plain words in the row itself.
    await page.goto(`/dashboard/applications/${applicationId}/releases`);
    await expect(page.getByText('Unavailable', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('The build for this version is no longer available.')).toBeVisible();
  });
});
