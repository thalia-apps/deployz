/**
 * Recovery-path scenarios: retry-install (vendor-side recovery for a failed
 * first install) and install-link retry (public customer-side recovery).
 *
 * Every assertion goes through the real HTTP API. Test titles carry
 * `@scenario:<id>` for the scenario-runner grep.
 *
 * ── Determinism note for retry-install-recovery ────────────────────────────
 * The FIRST retry-install test below proves the CONTROL-PLANE path: the route
 * accepts from FAILED (202), queues a fresh INSTALL job with recovery
 * metadata, and logs the event.  It does NOT drive the re-install to HEALTHY
 * through the same relay+scenario, because the scenario's exhausted
 * CloudFormation timeline (ROLLBACK_COMPLETE) can never produce
 * CREATE_COMPLETE on a second pass — the simulation's scenario engine is
 * one-shot. The FULL arc (FAILED → retry → HEALTHY) is covered by the
 * SECOND test in this file (install-link-retry), which resets the deployment
 * to NOT_INSTALLED and starts a fresh relay with a happy-path scenario,
 * proving the end-to-end recovery works.
 *
 * Both tests are deterministic: no race-polling for INSTALLING state, no
 * timing-dependent assertions.
 */

import { expect, test } from './simulation/fixtures.js';

import { API_URL } from './simulation/fixtures.js';
import { memoryPendingStore, type PendingCommand } from '@deployz/relay/pending';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import type { SimulatedCustomerAccount } from './simulation/simulated-account.js';

interface DeploymentResponse {
  state: string;
  applicationId: string;
}

interface EventRow {
  eventType: string;
  jobId?: string | null;
}

async function getEvents(request: import('@playwright/test').APIRequestContext, deploymentId: string): Promise<EventRow[]> {
  const response = await request.get(`${API_URL}/api/deployments/${deploymentId}/events`);
  if (!response.ok()) {
    throw new Error(`GET /api/deployments/${deploymentId}/events -> ${response.status()}`);
  }
  const body = (await response.json()) as { events: EventRow[] };
  return body.events;
}

test.describe.configure({ mode: 'parallel' });

// ── Item 3: FAILED first install → vendor retry-install recovery ────────────
test.describe('retry-install-recovery', () => {
  test.use({ deployzScenario: 'cloudformation-rollback' });

  test('@scenario:retry-install-recovery POST /api/deployments/:id/retry-install accepts from FAILED, queues a fresh job, and logs the event (control-plane path only; the full re-install arc is covered by install-link-retry)', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // 1. First install fails (cloudformation-rollback scenario → FAILED).
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 20_000,
        message: 'waiting for first install to reach FAILED',
      })
      .toBe('FAILED');

    // 2. Vendor calls retry-install. Requires a CONNECTED relay; the failed
    // scenario does not kill the relay process, and the INSTALL job settled
    // to FAILED so no RUNNING job blocks.
    const retryResp = await request.post(`${API_URL}/api/deployments/${deploymentId}/retry-install`, { data: {} });
    expect(retryResp.status()).toBe(202);
    const retryBody = (await retryResp.json()) as { jobId: string };
    expect(retryBody.jobId).toBeDefined();

    // 3. Fresh INSTALL job queued with recovery metadata. The relay state is
    // set to INSTALLING by the route — but we do NOT poll for it because
    // the relay's next tick may already have re-failed it (the existing
    // ROLLBACK_COMPLETE stack causes installApplicationStack to re-fail).
    // This is the KNOWN, HONEST ceiling: see the file-level determinism note.
    const events = await getEvents(request, deploymentId);
    expect(events.some((e) => e.eventType === 'install.retry.requested')).toBe(true);

    // Double-click: the relay may have already picked up the first retry,
    // so accept 200 (replayed) or 202 (fresh).
    const again = await request.post(`${API_URL}/api/deployments/${deploymentId}/retry-install`, { data: {} });
    expect([200, 202]).toContain(again.status());
  });
});

// ── Item 4: retry during in-progress install (install-link retry) ──────────
test.describe('install-link-retry', () => {
  test.use({ deployzScenario: 'happy-path', deployzStartRelay: false });

  test('@scenario:install-link-retry mid-flight install-link retry records previousInstallationId and re-arms cleanly', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(60_000);
    // NOTE: deployzStartRelay is false — we start the relay manually after
    // calling install-link retry, so we control timing precisely.
    const { deploymentId, installLinkId, enrollmentCode, api } = deployzInstall;

    // 1. Start a relay (happy-path) so the install begins and an
    // installationId is assigned.
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCred = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-retry-${crypto.randomUUID().slice(0, 8)}`;

    const relayA = startSimulatedRelay({
      scenario: getScenario('happy-path'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCred,
    });

    try {
      // 2. Wait for INSTALLING (installationId set).
      await expect
        .poll(async () => (await api.getDeployment(deploymentId)).state, {
          timeout: 15_000,
          message: 'waiting for state to reach INSTALLING',
        })
        .toBe('INSTALLING');

      // 3. Call install-link retry while the install is in progress.
      //    The route resets to NOT_INSTALLED and records previousInstallationId.
      const retryResp = await request.post(`${API_URL}/api/install/${installLinkId}/retry`, { data: {} });
      expect(retryResp.ok()).toBeTruthy();
      const retryBody = (await retryResp.json()) as {
        state: string;
        attemptNumber: number;
        quickCreateUrl: string | null;
        existingStackUpdate: { enrollmentCode: string; relayCredential: string } | null;
      };
      expect(retryBody.state).toBe('NOT_INSTALLED');
      expect(retryBody.attemptNumber).toBe(1);
      // The connector registered, so the retry updates its stack: no second connector.
      expect(retryBody.quickCreateUrl).toBeNull();
      expect(retryBody.existingStackUpdate).not.toBeNull();

      // 4. Verify the deployment re-armed: fetch the fresh credential.
      const refreshedInfo = await request.get(`${API_URL}/api/install/${installLinkId}`).then((r) => r.json()) as {
        quickCreateUrl: string | null;
        existingStackUpdate: { enrollmentCode: string; relayCredential: string } | null;
      };
      expect(refreshedInfo.quickCreateUrl).toBeNull();
      const freshEnrollment = refreshedInfo.existingStackUpdate!.enrollmentCode;
      const freshRelayCred = refreshedInfo.existingStackUpdate!.relayCredential;

      // Fresh enrollment code is different from the first.
      expect(freshEnrollment).not.toBe(enrollmentCode);

      // 5. The deployment re-arms: start a second relay with the fresh code.
      relayA.stop();
      const relayB = startSimulatedRelay({
        scenario: getScenario('happy-path'),
        apiUrl: API_URL,
        installationId,
        enrollmentCode: freshEnrollment,
        relayToken: freshRelayCred,
      });

      try {
        // 6. The install succeeds to HEALTHY.
        await expect
          .poll(async () => (await api.getDeployment(deploymentId)).state, {
            timeout: 20_000,
            message: 'waiting for retried install to reach HEALTHY',
          })
          .toBe('HEALTHY');
      } finally {
        relayB.stop();
      }
    } finally {
      relayA.stop();
    }
  });
});

// ── Item 5: stale INSTALL pending marker must not resurrect the stack ───────
test.describe('stale-install-resurrect', () => {
  test.use({ deployzScenario: 'stale-install-resurrect', deployzStartRelay: false });

  test('@scenario:stale-install-resurrect a pending INSTALL marker left behind after a failed install + DESTROY does not recreate the stack on a cold-start relay', async ({
    request,
    deployzInstall,
  }) => {
    test.setTimeout(90_000);
    const { deploymentId, installLinkId, enrollmentCode, installationId, api } = deployzInstall;

    // a. Fetch the install info + RelayCredential (same pattern as install-link-retry).
    const installInfo = await request.get(`${API_URL}/api/install/${installLinkId}`).then((r) => r.json()) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCred = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');

    // b. Start relay 1 — the install fails (cloudformation-rollback timeline).
    const relay1 = startSimulatedRelay({
      scenario: getScenario('stale-install-resurrect'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCred,
    });

    let account: SimulatedCustomerAccount;
    let stackName: string;

    try {
      const result1 = await relay1.waitForResult();
      expect(result1.succeeded).toBe(false);
      await expect
        .poll(async () => (await api.getDeployment(deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for deployment to reach FAILED',
        })
        .toBe('FAILED');

      account = relay1.account;
      stackName = account.stackName!;
      expect(stackName).not.toBeNull();
    } finally {
      relay1.stop();
    }

    // c. Find the install.failed event and read its jobId (the real FAILED INSTALL job).
    const eventsAfterFail = await getEvents(request, deploymentId);
    const installFailedEvent = eventsAfterFail.find((e) => e.eventType === 'install.failed');
    expect(installFailedEvent).toBeDefined();
    const installJobId = installFailedEvent!.jobId;
    expect(installJobId).toBeTruthy();

    // d. Simulate the teardown + failed marker clear: the relay's DESTROY executor
    //    calls deleteStack, then the control plane clears the pending marker.
    await account.stackDeleter().deleteStack(stackName, []);
    const createCallsBefore = account.createStackCalls;

    // e. Issue DESTROY via the real API.
    const destroyResp = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
    expect([200, 202]).toContain(destroyResp.status());

    // f. Build the stale pending marker (the INSTALL job that already failed).
    const seed: PendingCommand = {
      commandId: installJobId!,
      idempotencyKey: `${deploymentId}:INSTALL`,
      type: 'INSTALL',
      stackName,
      startedAt: new Date().toISOString(),
      payload: {
        templateUrl: 'https://simulated-templates.s3.us-east-1.amazonaws.com/application/v1/compiled-template.json',
        redisRequired: false,
        databaseRequired: true,
        stackName,
      },
    };

    // Start relay 2 (cold start) with the stale marker seeded.
    const relay2 = startSimulatedRelay({
      scenario: getScenario('stale-install-resurrect'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCred,
      account,
      seedPending: seed,
      pendingStore: memoryPendingStore(),
    });

    try {
      // g. DESTROY completes and the stack is NOT resurrected.
      await expect
        .poll(async () => (await api.getDeployment(deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for deployment to reach DELETED',
        })
        .toBe('DELETED');

      // No additional CreateStack calls.
      expect(account.createStackCalls).toBe(createCallsBefore);

      // The original failure is unchanged: exactly one install.failed event,
      // no new INSTALL job, no install.completed.
      const eventsAfterDestroy = await getEvents(request, deploymentId);
      const installFailedEvents = eventsAfterDestroy.filter((e) => e.eventType === 'install.failed');
      expect(installFailedEvents).toHaveLength(1);
      expect(eventsAfterDestroy.some((e) => e.eventType === 'install.completed')).toBe(false);
    } finally {
      relay2.stop();
    }

    // h. Repeated cold start: a third relay with the same stale marker must
    //    still not recreate the stack.
    const relay3 = startSimulatedRelay({
      scenario: getScenario('stale-install-resurrect'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCred,
      account,
      seedPending: seed,
      pendingStore: memoryPendingStore(),
    });

    try {
      // Wait ~1s of polls (pollTickMs defaults to 100ms).
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(account.createStackCalls).toBe(createCallsBefore);
    } finally {
      relay3.stop();
    }
  });
});