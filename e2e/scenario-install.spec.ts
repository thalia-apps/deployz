/**
 * Phase 1 simulated-infrastructure E2E: proves that simulated CloudFormation
 * events flow through the REAL production pipeline — relay collector ->
 * POST /api/relay/commands/:id/progress -> summarizeStackEvents -> DB ->
 * status derivation -> UI-facing wire shapes — and that the resource
 * inventory is populated through the production persistence path (relay
 * listAllStackResources -> POST /api/relay/health -> persistDeploymentResourceSnapshot).
 * See docs/testing/simulated-e2e.md.
 *
 * Every assertion here goes through the real HTTP API (no UI yet — that is a
 * later phase). Test titles carry `@scenario:<id>` so a parallel runner can
 * map `--scenario=X` to `--grep "@scenario:X"`. Each scenario gets its own
 * `test.describe` block so `test.use({ deployzScenario })` (an option
 * fixture — see e2e/simulation/fixtures.ts) scopes correctly.
 */

import { expect, test } from './simulation/fixtures.js';

interface StackEventRow {
  logicalResourceId: string;
  resourceType: string;
  resourceStatus: string;
  resourceStatusReason: string | null;
}

interface InfrastructureResponse {
  stackStatus: string | null;
  summary: { status: string; componentCount: number; technicalResourceCount: number };
  expectations: {
    components: Array<{ kind: string; expected: boolean; present: boolean }>;
    missing: string[];
    unexpected: string[];
  } | null;
}

interface VendorDeploymentStatus {
  stage: string;
  step: string;
  url: string | null;
  failure: {
    code: string | null;
    component: string | null;
    reference: string;
    message: string;
    awsStatus: string | null;
  } | null;
}

interface DeploymentResponse {
  state: string;
  healthStatus: string;
  stepTimings: Record<string, { startedAt: string; completedAt?: string }> | null;
  deploymentStatus: VendorDeploymentStatus;
}

test.describe.configure({ mode: 'parallel' });

test.describe('happy-path', () => {
  test.use({ deployzScenario: 'happy-path' });

  test('@scenario:happy-path install reaches READY through the real pipeline', async ({ deployzInstall }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // The lifecycle state the production `/result` route writes on a
    // successful INSTALL job.
    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.healthStatus).toBe('HEALTHY');
    // Phase 11 default HTTPS is an opt-in in the fixture environment
    // (DEPLOYZ_DEFAULT_HTTPS_FIXTURE): a dedicated default-https run drives
    // the automatic Deployz-owned endpoint to ACTIVE and the deployment to
    // READY on its own. The ordinary fixture suite keeps the HTTP-only
    // behaviour — an installed-and-healthy deployment with no custom domain
    // legitimately holds at VERIFYING/TLS ("Waiting for secure domain
    // setup.") rather than READY. See
    // docs/deployment-resilience.md §5.
    const defaultHttpsEnabled = process.env.DEPLOYZ_DEFAULT_HTTPS_FIXTURE === 'true';
    if (defaultHttpsEnabled) {
      await expect
        .poll(async () => ((await api.getDeployment(deploymentId)) as unknown as DeploymentResponse).deploymentStatus.stage, {
          timeout: 20_000,
          message: 'waiting for the default-HTTPS endpoint to carry the deployment to READY',
        })
        .toBe('READY');
      const ready = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
      expect(ready.deploymentStatus.url).toMatch(/^https:\/\/d-.+\.deployz-fixture\.test$/);
    } else {
      expect(deployment.deploymentStatus.stage).toBe('VERIFYING');
      expect(deployment.deploymentStatus.step).toBe('TLS');
    }

    // Stack events came from the ingest route (persisted rows), not
    // fabricated by the test — every resource in the scenario's timeline
    // shows up, including the ones the collector only reported mid-install.
    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const logicalIds = new Set(events.map((event) => event.logicalResourceId));
    for (const expected of ['ApplicationVpc', 'ApplicationDatabase', 'ApplicationBucket', 'WebService']) {
      expect(logicalIds.has(expected), `expected a stack event for ${expected}`).toBe(true);
    }
    expect(events.every((event) => event.resourceStatus !== 'CREATE_FAILED')).toBe(true);

    // Resource inventory populated via the production persistence path.
    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
    // Honest, observed production behaviour (not forced): `stackStatus` on
    // this endpoint reads `observedState.infraHealth.provisioning.stackStatus`,
    // which only the progress-ingest route and the mid-build heartbeat ever
    // set. `POST /api/relay/health` overwrites `observedState` WHOLESALE with
    // its own payload every poll — including the terminal heartbeat that
    // rides the very same poll cycle a fast install settles in — and a
    // heartbeat taken after `verifyInstallation` passes never re-attaches a
    // provisioning snapshot (see `createObserveHook`'s stack-complete guard
    // in packages/relay/src/index.ts). So once HEALTHY, this field reverts to
    // null rather than freezing at its last in-progress value.
    expect(infra.stackStatus).toBeNull();
    expect(infra.summary.componentCount).toBeGreaterThan(0);

    // Step timings advanced — never a percentage, always semantic steps.
    expect(Object.keys(deployment.stepTimings ?? {}).length).toBeGreaterThan(0);
  });
});

test.describe('cloudformation-rollback', () => {
  test.use({ deployzScenario: 'cloudformation-rollback' });

  test('@scenario:cloudformation-rollback terminal FAILED, not a stuck install', async ({ deployzInstall }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    // The deployment is FAILED from the moment CloudFormation's rollback
    // verdict arrives (stack-event settlement); the terminal
    // ROLLBACK_COMPLETE status follows on a later progress batch while AWS
    // finishes the rollback — poll for it instead of racing one read.
    await expect
      .poll(
        async () =>
          ((await api.getDeployment(deploymentId)) as unknown as DeploymentResponse).deploymentStatus.failure
            ?.awsStatus,
        { timeout: 15_000, message: 'waiting for the terminal rollback stack status' },
      )
      .toBe('ROLLBACK_COMPLETE');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.deploymentStatus.stage).toBe('FAILED');
    expect(deployment.deploymentStatus.failure).not.toBeNull();
    // Server-side refinement (apps/api/src/failure-classification.ts):
    // the failed resource is the RDS instance, so the honest classification
    // is the database, not the generic stack bucket.
    expect(deployment.deploymentStatus.failure!.code).toBe('DATABASE_CREATE_FAILED');
    expect(deployment.deploymentStatus.failure!.awsStatus).toBe('ROLLBACK_COMPLETE');

    // The stack events show the rollback via the real ingest path.
    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const dbEvent = events.find(
      (event) => event.logicalResourceId === 'ApplicationDatabase' && event.resourceStatus === 'CREATE_FAILED',
    );
    expect(dbEvent).toBeDefined();
    expect(dbEvent!.resourceStatusReason).toContain('not supported in this Availability Zone');
  });
});

test.describe('ecs-failure', () => {
  test.use({ deployzScenario: 'ecs-failure' });

  test('@scenario:ecs-failure terminal FAILED with the ECS failure surfaced', async ({ deployzInstall }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach FAILED',
      })
      .toBe('FAILED');

    // The terminal ROLLBACK_COMPLETE status follows the settlement on a
    // later progress batch while AWS finishes the rollback.
    await expect
      .poll(
        async () =>
          ((await api.getDeployment(deploymentId)) as unknown as DeploymentResponse).deploymentStatus.failure
            ?.awsStatus,
        { timeout: 15_000, message: 'waiting for the terminal rollback stack status' },
      )
      .toBe('ROLLBACK_COMPLETE');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.deploymentStatus.stage).toBe('FAILED');
    // Refinement: the ECS service failed its health checks — classified as
    // the health check, not the generic stack bucket.
    expect(deployment.deploymentStatus.failure!.code).toBe('IMAGE_HEALTH_CHECK_FAILED');
    expect(deployment.deploymentStatus.failure!.awsStatus).toBe('ROLLBACK_COMPLETE');

    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const serviceEvent = events.find(
      (event) => event.logicalResourceId === 'WebService' && event.resourceStatus === 'CREATE_FAILED',
    );
    expect(serviceEvent).toBeDefined();
    expect(serviceEvent!.resourceStatusReason).toBe('Service failed health checks');

    // Infra up to the ECS service completed fine — the failure is specific
    // to the application component, not a network/database problem.
    const dbEvent = events.find((event) => event.logicalResourceId === 'ApplicationDatabase');
    expect(dbEvent?.resourceStatus).toBe('CREATE_COMPLETE');
  });
});

test.describe('healthcheck-failure', () => {
  test.use({ deployzScenario: 'healthcheck-failure' });

  test('@scenario:healthcheck-failure install succeeds; runtime health honestly reports UNHEALTHY', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    // CloudFormation reports the stack complete and verifyInstallation
    // independently confirms every required resource is present, so the
    // INSTALL job succeeds. After Phase 1.3 the persisted lifecycle state
    // stays INSTALLING until the relay's runtime health heartbeat reports
    // HEALTHY. In this scenario every ALB target fails its health check, so
    // healthStatus becomes UNHEALTHY while the customer-facing ladder holds
    // at VERIFYING — never FAILED and never READY. The app has a migration, so
    // the install starts no task and the first deploy is the first start: the
    // step stays on starting the application while its targets are unhealthy.
    await expect
      .poll(async () => ((await api.getDeployment(deploymentId)) as unknown as DeploymentResponse).deploymentStatus.stage, {
        timeout: 15_000,
        message: 'waiting for install to complete and runtime verification to begin',
      })
      .toBe('VERIFYING');

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).healthStatus, {
        timeout: 15_000,
        message: 'waiting for the runtime health heartbeat to report UNHEALTHY',
      })
      .toBe('UNHEALTHY');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.state).toBe('INSTALLING');
    expect(deployment.deploymentStatus.stage).toBe('VERIFYING');
    expect(deployment.deploymentStatus.step).toBe('APPLICATION');
    expect(deployment.deploymentStatus.failure).toBeNull();

    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    expect(events.every((event) => event.resourceStatus !== 'CREATE_FAILED')).toBe(true);

    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
.toBeGreaterThan(0);
  });
});

test.describe('stateless', () => {
  test.use({ deployzScenario: 'stateless' });

  test('@scenario:stateless install reaches HEALTHY with no database resources in the inventory', async ({
    deployzInstall,
  }) => {
    test.setTimeout(30_000);
    const { deploymentId, api } = deployzInstall;

    await expect
      .poll(async () => (await api.getDeployment(deploymentId)).state, {
        timeout: 15_000,
        message: 'waiting for deployment.state to reach HEALTHY',
      })
      .toBe('HEALTHY');

    const deployment = (await api.getDeployment(deploymentId)) as unknown as DeploymentResponse;
    expect(deployment.healthStatus).toBe('HEALTHY');

    // Stack events: no ApplicationDatabase resource.
    const events = (await api.getStackEvents(deploymentId)) as StackEventRow[];
    const dbEvent = events.find((e) => e.logicalResourceId === 'ApplicationDatabase');
    expect(dbEvent).toBeUndefined();
    const allGood = events.every((event) => event.resourceStatus !== 'CREATE_FAILED');
    expect(allGood).toBe(true);

    // Resource inventory: the database component should be absent.
    await expect
      .poll(
        async () => {
          const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse;
          return infra.summary.technicalResourceCount;
        },
        { timeout: 15_000, message: 'waiting for the resource inventory to be persisted' },
      )
      .toBeGreaterThan(0);
    const infra = (await api.getInfrastructure(deploymentId)) as unknown as InfrastructureResponse & {
      components: Array<{ kind: string }>;
    };
    expect(infra.components.some((c: { kind: string }) => c.kind === 'database')).toBe(false);
    expect(infra.components.some((c: { kind: string }) => c.kind === 'storage')).toBe(true);
    expect(infra.components.some((c: { kind: string }) => c.kind === 'application')).toBe(true);

    // Phase 6: requirement-aware verification. This stateless deployment's
    // manifest never asked for a database, so its absence is not "missing".
    expect(infra.expectations?.missing).toEqual([]);
    expect(infra.expectations?.unexpected).toEqual([]);
    expect(infra.expectations?.components.find((c) => c.kind === 'database')).toEqual({
      kind: 'database',
      expected: false,
      present: false,
    });
  });
});
