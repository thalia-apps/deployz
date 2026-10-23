import { expect, type APIRequestContext } from '@playwright/test';
import { fixtureSha } from './fixture-sha';

const API_URL = `http://localhost:${process.env.API_PORT ?? 3001}`;

/**
 * Phase 2 readiness gate: `POST /api/deployments` refuses applications whose
 * normalized deployment manifest is not READY. The demo repos these specs
 * seed have no real analysis, so give the application the same vendor
 * overrides the scenario fixtures use — just the three fields the readiness
 * evaluator hard-fails on (Dockerfile, port, start command). It also refuses
 * (409 RELEASE_NOT_PUBLISHED) an application with no READY release, so build
 * one too.
 */
export async function makeApplicationDeployable(
  request: APIRequestContext,
  applicationId: string,
): Promise<void> {
  const response = await request.patch(`${API_URL}/api/applications/${applicationId}`, {
    data: {
      containerPort: 3000,
      dockerfilePath: 'Dockerfile',
      startCommand: 'npm start',
    },
  });
  expect(
    response.ok(),
    `makeApplicationDeployable failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
  await createReadyRelease(request, applicationId);
}

/**
 * The install runs the application's newest READY release. BUILD_FIXTURE_MODE
 * (playwright.config.ts) marks a new release READY at once. The version is
 * below the 1.0.0+ versions the specs create themselves, so it never collides.
 * Idempotent: a second call finds the release already there.
 */
export async function createReadyRelease(
  request: APIRequestContext,
  applicationId: string,
): Promise<void> {
  const response = await request.post(`${API_URL}/api/applications/${applicationId}/releases`, {
    data: { version: '0.1.0', gitSha: fixtureSha('0.1.0') },
  });
  const body = await response.text();
  expect(
    response.ok() || (response.status() === 409 && body.includes('RELEASE_VERSION_EXISTS')),
    `createReadyRelease failed: ${response.status()} ${body}`,
  ).toBeTruthy();
}
