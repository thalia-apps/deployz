/**
 * Phase 5 — the async & scheduled-workloads composition, ONE continuous test
 * over ONE deployment whose application is analysed (real analyser, fixture
 * mode) from deployz-demo/async-app: a web service that produces to an SQS
 * queue, a worker service that consumes it (and its dead-letter queue), and a
 * `cleanup` scheduled job (EventBridge Scheduler → a one-shot ECS task
 * definition), over a managed MySQL database.
 *
 *   analyse → readiness READY (architecture card: the queue/DLQ/schedule
 *   ride the Messaging group, the scheduled job rides Application like every
 *   other workload) → frozen spec proves the composition (IR resources,
 *   footprint, cost estimate) → simulated INSTALL reaches HEALTHY (every
 *   compiled resource — queues, schedule, scheduled-job task definition —
 *   reaches CREATE_COMPLETE) → the generic `queue`/`schedule` verification
 *   checks pass, and a queue that never reaches a complete state fails
 *   verification naming it → specComponents shows the queue/DLQ/schedule with
 *   friendly labels, never a raw CFN type → DEPLOY_RELEASE rolls web+worker
 *   and registers the release image into the cleanup family → RESTART
 *   touches no family → ROLLBACK re-registers the cleanup family with the
 *   rollback image → a scheduled-job task failure never touches deployment
 *   health → DESTROY stops a running standalone cleanup task, then retains
 *   the database while removing the queues/schedule → PURGE sweeps the
 *   retained MySQL instance.
 */

import { expect, test, type APIRequestContext } from '@playwright/test';

import { verifyInstallation } from '@deployz/relay/verify';

import { createReadyRelease } from './seed-ready-manifest.js';
import { extractQuickCreateParam, startSimulatedRelay } from './simulation/relay-harness.js';
import { getScenario } from './simulation/scenarios/index.js';
import { API_URL, buildApi, expectPlanMatchesInventory, waitForInstallAutoDeploy } from './simulation/fixtures.js';
import { installLinkHeaders } from './install-link.js';
import { fixtureSha } from './fixture-sha.js';

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  currentReleaseId: string | null;
  previousReleaseId: string | null;
  relayStatus: string;
  cleanupState: string | null;
  components: Record<string, string> | null;
  deploymentStatus: {
    stage: string;
    failure: { code: string | null } | null;
  };
}

interface ReadinessResponse {
  analysisStatus: string;
  state: string;
  findings: Array<{ id: string; severity?: string; blocking?: boolean }>;
  architecture?: {
    groups: Array<{ group: string; nodes: Array<{ label: string; state: string }> }>;
  };
}

interface PlanResponse {
  footprint: {
    workloads: Array<{ id: string; role: string }>;
    resources: Array<{ id: string; service: string; role: string; configuration: Record<string, unknown> }>;
  };
  costEstimate: {
    complete: boolean;
    items: Array<{ resourceId: string; pricingStatus: string }>;
  };
  components: Array<{ kind: string; group: string; componentId: string }>;
}

interface ReleaseResponse {
  id: string;
}

interface InstallStatusResponse {
  specComponents?: Array<{ componentId: string; label: string; state: string }>;
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
  return ((await response.json()) as ReleaseResponse).id;
}

test.describe.configure({ mode: 'serial' });

test.describe('phase5-composition', () => {
  test('@scenario:phase5-composition queues, dead-letter, scheduled job: readiness, verification, deploy/restart/rollback, standalone-task destroy, purge', async ({
    request,
  }) => {
    test.setTimeout(240_000);
    const suffix = crypto.randomUUID().slice(0, 8);

    // ── Sign up + analyse the async fixture through the REAL analyser. ──────
    const signUp = await request.post(`${API_URL}/api/auth/sign-up/email`, {
      data: { name: `Phase5 Vendor ${suffix}`, email: `e2e-p5-${suffix}@example.com`, password: 'super-secret-1' },
    });
    expect(signUp.ok()).toBeTruthy();

    const appResponse = await request.post(`${API_URL}/api/applications`, {
      data: {
        name: `Phase5 App ${suffix}`,
        githubInstallationId: 'e2e-installation',
        repoFullName: 'deployz-demo/async-app',
        repoUrl: 'https://github.com/deployz-demo/async-app',
        defaultBranch: 'main',
      },
    });
    expect(appResponse.ok()).toBeTruthy();
    const application = (await appResponse.json()) as { id: string };

    const analyse = await request.post(`${API_URL}/api/applications/${application.id}/analyse`, {});
    expect(analyse.ok()).toBeTruthy();

    // ── Readiness: READY — the queue/DLQ/schedule ride the Messaging group,
    // the scheduled job rides Application like every other workload. ────────
    const readiness = (await request
      .get(`${API_URL}/api/applications/${application.id}/readiness`)
      .then((r) => r.json())) as ReadinessResponse;
    expect(readiness.analysisStatus).toBe('COMPLETE');
    expect(readiness.state).toBe('READY');
    expect(readiness.findings.some((f) => f.blocking === true)).toBe(false);

    const applicationGroup = readiness.architecture!.groups.find((g) => g.group === 'application')!;
    expect(applicationGroup.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining(['Web service', 'Background worker', 'Scheduled job cleanup']),
    );
    const messagingGroup = readiness.architecture!.groups.find((g) => g.group === 'messaging')!;
    expect(messagingGroup.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining(['Orders queue', 'Orders queue dead-letter queue', 'Schedule for cleanup']),
    );

    await createReadyRelease(request, application.id);

    const customerResponse = await request.post(`${API_URL}/api/customers`, {
      data: { name: `Phase5 Customer ${suffix}`, email: `p5-customer-${suffix}@example.com` },
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

    // ── The frozen plan proves the composition: web + worker + the cleanup
    // scheduled job, an SQS queue + its DLQ, and a schedule — grouped under
    // 'messaging', priced 'unavailable' so the estimate is honestly
    // incomplete rather than inventing SQS/Scheduler usage. ─────────────────
    const plan = (await buildApi(request).getPlan(deploymentId, 'install')) as unknown as PlanResponse;
    const workloadRoles = plan.footprint.workloads.map((workload) => ({ id: workload.id, role: workload.role }));
    expect(workloadRoles).toHaveLength(3);
    expect(workloadRoles).toEqual(
      expect.arrayContaining([
        { id: 'web', role: 'web' },
        { id: 'worker', role: 'worker' },
        { id: 'cleanup', role: 'scheduled-job' },
      ]),
    );
    const queue = plan.footprint.resources.find((resource) => resource.id === 'orders-queue')!;
    expect(queue.service).toBe('sqs');
    const dlq = plan.footprint.resources.find((resource) => resource.id === 'orders-queue-dlq')!;
    expect(dlq.service).toBe('sqs');
    const schedule = plan.footprint.resources.find((resource) => resource.id === 'cleanup-schedule')!;
    expect(schedule.service).toBe('eventbridge-scheduler');
    const database = plan.footprint.resources.find((resource) => resource.id === 'database')!;
    expect(database.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });

    expect(plan.costEstimate.complete).toBe(false);
    const costItemStatus = (resourceId: string): string | undefined =>
      plan.costEstimate.items.find((item) => item.resourceId === resourceId)?.pricingStatus;
    expect(costItemStatus('orders-queue')).toBe('unavailable');
    expect(costItemStatus('orders-queue-dlq')).toBe('unavailable');
    expect(costItemStatus('cleanup-schedule')).toBe('unavailable');

    const messagingComponents = plan.components.filter((c) => c.group === 'messaging');
    expect(messagingComponents.map((c) => c.componentId).sort()).toEqual(
      ['cleanup-schedule', 'orders-queue', 'orders-queue-dlq'].sort(),
    );
    expect(messagingComponents.find((c) => c.componentId === 'orders-queue')!.kind).toBe('queue');
    expect(messagingComponents.find((c) => c.componentId === 'cleanup-schedule')!.kind).toBe('schedule');
    // The scheduled job itself is a workload, presented like any other —
    // never raw CloudFormation, never lumped in with messaging.
    const cleanupComponent = plan.components.find((c) => c.componentId === 'cleanup')!;
    expect(cleanupComponent.group).toBe('application');

    const launch = await request.post(`${API_URL}/api/install/${installLinkId}/launched`, { data: {} });
    expect(launch.ok()).toBeTruthy();

    // ── Install — the real relay drives the phase5-composition scenario. ───
    const installInfo = (await request.get(`${API_URL}/api/install/${installLinkId}`, {
      headers: await installLinkHeaders(request, installLinkId),
    }).then((r) => r.json())) as {
      quickCreateUrl: string | null;
    };
    expect(installInfo.quickCreateUrl).not.toBeNull();
    const relayCredential = extractQuickCreateParam(installInfo.quickCreateUrl!, 'RelayCredential');
    const installationId = `inst-${suffix}`;
    const relay = startSimulatedRelay({
      scenario: getScenario('phase5-composition'),
      apiUrl: API_URL,
      installationId,
      enrollmentCode,
      relayToken: relayCredential,
    });

    try {
      // ── specComponents shows the queue/DLQ/schedule with friendly labels,
      // never a raw CFN type, while the install is still provisioning (the
      // scenario deliberately completes the queues/schedule ~600ms before
      // the services and the stack itself, so this window is wide relative
      // to an HTTP poll — see phase5-composition.ts). Proven BEFORE waiting
      // for HEALTHY: `GET /api/install/:id/status` only queries stack events
      // (and therefore only ever populates these entries) while the
      // deployment's stage is PROVISIONING (server.ts's
      // `stackOperationActive`) — they are not a durable post-install
      // projection today (see this test's final report for that gap). ──────
      // The schedule completes after the queues on the timeline, so wait for
      // all three in ONE response and assert on that same response — a
      // second read can land after the stage has left PROVISIONING.
      const asyncComponentIds = ['orders-queue', 'orders-queue-dlq', 'cleanup-schedule'];
      let installStatus: InstallStatusResponse | undefined;
      await expect
        .poll(
          async () => {
            const status = (await buildApi(request).getInstallStatus(installLinkId)) as unknown as InstallStatusResponse;
            const complete = asyncComponentIds.every(
              (id) => status.specComponents?.find((c) => c.componentId === id)?.state === 'COMPLETE',
            );
            if (complete) installStatus = status;
            return complete;
          },
          { timeout: 10_000, intervals: [50], message: 'waiting for the queue, DLQ and schedule spec components to reach COMPLETE mid-install' },
        )
        .toBe(true);
      const byComponentId = new Map(installStatus!.specComponents!.map((c) => [c.componentId, c]));
      expect(byComponentId.get('orders-queue')).toMatchObject({ label: 'Orders queue', state: 'COMPLETE' });
      expect(byComponentId.get('orders-queue-dlq')).toMatchObject({
        label: 'Orders queue dead-letter queue',
        state: 'COMPLETE',
      });
      expect(byComponentId.get('cleanup-schedule')).toMatchObject({
        label: 'Schedule for cleanup',
        state: 'COMPLETE',
      });
      // No raw CloudFormation resource type ever leaks into a label.
      for (const component of installStatus!.specComponents!) {
        expect(component.label).not.toMatch(/^AWS::/);
      }

      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 30_000,
          message: 'waiting for install to reach HEALTHY',
        })
        .toBe('HEALTHY');
      expect((await getDeployment(request, deploymentId)).relayStatus).toBe('CONNECTED');

      const autoReleaseId = await waitForInstallAutoDeploy(buildApi(request), deploymentId);
      expect(relay.account.operationLog.filter((entry) => entry.startsWith('update:'))).toHaveLength(2);

      // ── A queue that never reaches a complete state fails the relay's
      // generic 'queue' verification check, naming that exact component —
      // proven directly against the real relay verification function over
      // the same simulated account, independent of how (or whether) the
      // product surfaces it in the UI today. ─────────────────────────────────
      const brokenCheck = await verifyInstallation({
        cfn: relay.account.cloudFormationReader(),
        installationId,
        stackName: relay.account.stackName!,
        redisRequired: false,
        databaseRequired: true,
        resourceChecks: [
          {
            componentId: 'orders-queue-dlq',
            check: 'queue',
            logicalId: 'NeverProvisionedQueue',
            resourceType: 'AWS::SQS::Queue',
          },
        ],
      });
      expect(brokenCheck.verified).toBe(false);
      expect(brokenCheck.reason).toContain('orders-queue-dlq');
      expect(brokenCheck.reason).toContain('NeverProvisionedQueue');

      // ── RESTART: both services redeploy; no scheduled-job family is
      // touched (RESTART never rolls a release, so nothing needs it). ────────
      const restart = await request.post(`${API_URL}/api/deployments/${deploymentId}/restart`, { data: {} });
      expect(restart.status()).toBe(202);
      await expect
        .poll(async () => relay.account.restarts, {
          timeout: 20_000,
          message: 'waiting for the restart executor to touch both services',
        })
        .toBe(2);
      // The restart job settles on its rollout, on a later relay poll.
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the restart rollout to settle',
        })
        .toBe('HEALTHY');

      // ── v1 deploy: web + worker roll, and the cleanup family is
      // registered with the release image once the rollout settles. ─────────
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
      const afterV1 = relay.account.serviceSnapshots();
      expect(afterV1.map((s) => s.logicalId)).toEqual(['WebService', 'WorkerService']);
      const v1Digest = afterV1[0]!.runningImageDigest;
      for (const service of afterV1) expect(service.runningImageDigest).toBe(v1Digest);
      const cleanupDigestAfterV1 = (
        await relay.account.ecsDeployClient().describeTaskDefinition({ taskDefinition: relay.account.taskFamily('cleanup') })
      ).taskDefinition.containerDefinitions[0]!.image as string;
      expect(cleanupDigestAfterV1).toContain(v1Digest!);

      // ── ROLLBACK: every workload rolls back; the cleanup family is
      // re-registered with the rollback image. ───────────────────────────────
      const rollback = await request.post(`${API_URL}/api/deployments/${deploymentId}/rollback`, {
        data: { releaseId: autoReleaseId },
      });
      expect(rollback.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).currentReleaseId, {
          timeout: 20_000,
          message: 'waiting for the rollback to promote the previous release',
        })
        .toBe(autoReleaseId);
      expect((await getDeployment(request, deploymentId)).deploymentStatus.failure).toBeNull();
      const afterRollback = relay.account.serviceSnapshots();
      const rollbackDigest = afterRollback[0]!.runningImageDigest;
      expect(rollbackDigest).not.toBe(v1Digest);
      const cleanupDigestAfterRollback = (
        await relay.account.ecsDeployClient().describeTaskDefinition({ taskDefinition: relay.account.taskFamily('cleanup') })
      ).taskDefinition.containerDefinitions[0]!.image as string;
      expect(cleanupDigestAfterRollback).toContain(rollbackDigest!);
      expect(cleanupDigestAfterRollback).not.toBe(cleanupDigestAfterV1);

      // ── A scheduled-job task failure (a stopped standalone
      // `family:DeployzAppCleanup` task, exit code 1) leaves deployment
      // health/readiness entirely unchanged — nothing in the deploy/verify
      // path ever runs or watches a scheduled job's own tasks. ───────────────
      const failedTaskArn = relay.account.runStandaloneTask(relay.account.taskFamily('cleanup'));
      relay.account.stopStandaloneTask(failedTaskArn);
      const beforeFailureHealth = await getDeployment(request, deploymentId);
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterFailureHealth = await getDeployment(request, deploymentId);
      expect(afterFailureHealth.state).toBe(beforeFailureHealth.state);
      expect(afterFailureHealth.state).toBe('HEALTHY');
      expect(afterFailureHealth.healthStatus).toBe(beforeFailureHealth.healthStatus);

      // ── DESTROY: a RUNNING standalone cleanup task is stopped before the
      // cluster is deleted; the database is RETAINED, the queues/schedule
      // are removed with the stack. ───────────────────────────────────────────
      const runningTaskArn = relay.account.runStandaloneTask(relay.account.taskFamily('cleanup'));
      const destroy = await request.post(`${API_URL}/api/deployments/${deploymentId}/destroy`, { data: {} });
      expect(destroy.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).state, {
          timeout: 20_000,
          message: 'waiting for the destroy to complete',
        })
        .toBe('DELETED');
      expect(relay.account.stoppedStandaloneTaskArns).toContain(runningTaskArn);
      await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-destroy' });
      const inventory = (await buildApi(request).getInfrastructure(deploymentId)) as {
        components: Array<{ kind: string; status: string }>;
      };
      const retainedKinds = Object.fromEntries(inventory.components.map((c) => [c.kind, c.status]));
      expect(retainedKinds['database']).toBe('retained');
      // The queue and the schedule carry no retention policy — DESTROY
      // removes them with the rest of the stack.
      expect(retainedKinds['queue']).toBe('removed');
      expect(retainedKinds['schedule']).toBe('removed');

      // ── PURGE: the generic sweep deletes the retained MySQL instance. ──────
      const purge = await request.post(`${API_URL}/api/deployments/${deploymentId}/purge`, { data: {} });
      expect(purge.status()).toBe(202);
      await expect
        .poll(async () => (await getDeployment(request, deploymentId)).cleanupState, {
          timeout: 20_000,
          message: 'waiting for the purge to complete',
        })
        .toBe('COMPLETE');
      expect(relay.purgeDeletedDb).toEqual(['deployz-primary-db-mysql']);
      await expectPlanMatchesInventory(buildApi(request), deploymentId, { stage: 'post-purge' });
    } finally {
      relay.stop();
    }
  });
});
