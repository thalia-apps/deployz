/**
 * Scenarios — compositions of steps.ts building blocks.
 *
 * `core` is the golden path the MVP release gate runs three times in a row:
 *
 *   v1 install → seed data → v2 deploy → rollback to v1 → v2 again →
 *   broken v3 (fails, v2 keeps serving) → recovery (rollback to v1 as the
 *   real mutation; re-deploying the running v2 replays idempotently) →
 *   v4 deploy → destroy → purge → leftovers → leak audit
 *
 * Releases are built just in time: INSTALL success auto-deploys the NEWEST
 * READY release, so building v4 before the install would skip the ladder.
 *
 * Two flags modify the flow:
 * - `--existing-image=<digest>`: skip CodeBuild, use the supplied digest
 *   for every version (v1, v2, v3, v4 share the same digest).
 * - `--reuse-stack`: skip bootstrap/stack creation and final infrastructure
 *   teardown; requires a standing stack tagged DeployzPersistent=true +
 *   DeployzTestMode=canary.
 */
import { applicationStackNameForInstallation } from '@deployz/contracts';

import {
  JOURNEY_APPLICATION_SIZES,
  RESTORED_APPLICATION_SIZES,
  assertBindings,
  assertMarkers,
  assertSameInfrastructure,
  assertServing,
  assertSizing,
  buildRelease,
  continueInstallFromLink,
  createDeploymentAndInstall,
  createJourneyInvitation,
  customerConfirmsChosenSize,
  deployAndVerify,
  deployExpectingFailure,
  preflight,
  rollbackAndVerify,
  seedMarker,
  setApplicationSizes,
  setUpVendorAndApplication,
  snapshotInfrastructure,
  verifyReuseStackTags,
  waitForDefaultHttpsActive,
  waitForJob,
  waitForPointer,
  type Canary,
} from './steps.js';
import { describeStack, describeRunningService } from './aws.js';
import { destroyThroughProduct, leakAudit, removeCanaryLeftovers } from './teardown.js';

/**
 * Reuse-stack shortcut: verify the stack, create a minimal deployment context,
 * and return the installation ID from the existing stack tags.
 */
async function setupReuseStack(canary: Canary): Promise<void> {
  const { config, evidence, api } = canary;
  const stackName = process.env.DEPLOYZ_E2E_CANARY_STACK_NAME ?? 'deployz-app';
  await verifyReuseStackTags(config.region, stackName);

  await evidence.step('Reuse-stack: create deployment for the standing infrastructure', async (details) => {
    // Find the installation ID from the existing stack's deployz:installation tag.
    const stack = await describeStack(config.region, stackName);
    if (!stack) throw new Error(`Stack "${stackName}" disappeared after verification`);
    const installationId = stack.tags['deployz:installation'];
    if (!installationId) throw new Error(`Stack "${stackName}" has no deployz:installation tag`);
    evidence.run.installationId = installationId;
    evidence.run.applicationStackName = applicationStackNameForInstallation(installationId);
    evidence.save();

    // Create a customer + deployment (per-run resources for the control plane).
    const customer = await api.createCustomer({
      name: `Canary customer ${config.runId}`,
      email: `customer-${config.runId.toLowerCase()}@deployz-canary.example.com`,
    });
    evidence.run.customerId = customer.id;
    const deployment = await api.createDeployment({ applicationId: evidence.run.applicationId!, customerId: customer.id, region: config.region });
    evidence.run.deploymentId = deployment.id;
    evidence.run.installLinkId = deployment.installLinkId;
    evidence.save();
    details['installationId'] = installationId;
    details['deploymentId'] = deployment.id;
    details['applicationStackName'] = evidence.run.applicationStackName;
    details['mode'] = 'reuse-stack';
  });
}

/** Shared teardown path: per-run resources always cleaned; infrastructure teardown skipped when --reuse-stack is set. */
async function teardownOrSkipInfrastructure(canary: Canary): Promise<void> {
  if (canary.config.keep) {
    console.log('\n--keep set: leaving the environment in place. Run cleanup --run-id later.');
    return;
  }
  if (canary.config.reuseStack) {
    console.log('\n--reuse-stack set: per-run resources cleaned, infrastructure left standing.');
  }
  await destroyThroughProduct(canary);
  await removeCanaryLeftovers(canary);
  await leakAudit(canary);
}

export async function runCore(canary: Canary): Promise<void> {
  const { evidence, api } = canary;
  await preflight(canary);
  await setUpVendorAndApplication(canary);

  // Phase 4 — v1.
  await buildRelease(canary, 'v1');

  // Reuse-stack: skip bootstrap stack creation/install; use the standing stack.
  if (canary.config.reuseStack) {
    await setupReuseStack(canary);
  } else {
    await createDeploymentAndInstall(canary);
  }

  await evidence.step('v1 is the serving release after install (auto-deploy + digest reconciliation)', async (details) => {
    await waitForPointer(canary, 'v1', 15 * 60_000);
    await assertServing(canary, { serving: 'v1', deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
  });
  if (!canary.config.reuseStack) await waitForDefaultHttpsActive(canary);
  await assertBindings(canary);

  // Phase 5 — persistence baseline + v2.
  await seedMarker(canary, 'CANARY_DATA');
  const baseline = await snapshotInfrastructure(canary);
  await buildRelease(canary, 'v2');
  await deployAndVerify(canary, 'v2', 'v1');
  await evidence.step('Persistent data and infrastructure survive the v2 update', async (details) => {
    await assertMarkers(canary, details);
    const after = await snapshotInfrastructure(canary);
    details['infrastructure'] = { baseline, after };
    assertSameInfrastructure(baseline, after);
  });

  // Phase 6 — rollback to v1.
  await rollbackAndVerify(canary, 'v1', 'v2');
  await evidence.step('Persistent data and infrastructure survive the rollback', async (details) => {
    await assertMarkers(canary, details);
    const after = await snapshotInfrastructure(canary);
    details['infrastructure'] = { baseline, after };
    assertSameInfrastructure(baseline, after);
  });

  // Back to a known-good newer release before the failure test.
  await deployAndVerify(canary, 'v2', 'v1');

  // Phase 7 — broken v3 is isolated.
  await buildRelease(canary, 'v3-bad-health');
  await deployExpectingFailure(canary, 'v3-bad-health', 'v2', 'v1');
  await evidence.step('Persistent data survives the failed release', async (details) => {
    await assertMarkers(canary, details);
  });

  // Phase 8 — recovery, then a normal release after the failure.
  await evidence.step('Re-deploying the running release is a fresh attempt that changes nothing in ECS', async (details) => {
    const v2 = evidence.run.releases['v2']!;
    const before = await describeRunningService(canary.config.region, evidence.run.applicationStackName!);
    const requested = await api.deploy(evidence.run.deploymentId!, v2.id);
    details['request'] = requested;
    if (requested.status !== 202) throw new Error(`re-deploy of the running release -> ${requested.status}, expected a fresh attempt (202)`);
    evidence.run.jobs.push({ id: requested.jobId, type: 'DEPLOY_RELEASE', releaseTag: 'v2' });
    evidence.save();
    const settled = await waitForJob(canary, requested.jobId, 20 * 60_000);
    const job = settled.jobs.find((j) => j.id === requested.jobId)!;
    details['job'] = { state: job.state, failureCode: job.failureCode, result: job.result };
    if (job.state !== 'SUCCEEDED') throw new Error(`re-deploy job ${job.state}`);
    const output = (job.result as { output?: { alreadyRunning?: boolean } } | null)?.output;
    if (output?.alreadyRunning !== true) throw new Error('the relay mutated ECS for a release that was already running');
    const after = await describeRunningService(canary.config.region, evidence.run.applicationStackName!);
    details['taskDefinition'] = { before: before?.taskDefinition, after: after?.taskDefinition };
    if (before?.taskDefinition !== after?.taskDefinition) throw new Error('a new task-definition revision was registered for an already-running release');
    await assertServing(canary, { serving: 'v2', previous: 'v1' }, details);
  });
  await rollbackAndVerify(canary, 'v1', 'v2');
  await buildRelease(canary, 'v4');
  await deployAndVerify(canary, 'v4', 'v1');
  await evidence.step('History keeps every attempt, including the failed v3', async (details) => {
    const detail = await api.getDeployment(evidence.run.deploymentId!);
    const v3 = evidence.run.releases['v3-bad-health']!;
    const failed = detail.jobs.filter((j) => j.type === 'DEPLOY_RELEASE' && j.payload?.['releaseId'] === v3.id);
    details['v3Jobs'] = failed.map((j) => ({ id: j.id, state: j.state, failureCode: j.failureCode }));
    if (!failed.some((j) => j.state === 'FAILED')) throw new Error('failed v3 attempt is no longer in the history');
    await assertMarkers(canary, details);
  });

  // Phase 14 — teardown + audit.
  await teardownOrSkipInfrastructure(canary);
}

/**
 * A single-profile certification run: the core ladder's install head —
 * vendor/application, v1 build, install to HEALTHY with the plan-vs-inventory
 * gate, default HTTPS — under a configured infrastructure profile
 * (config.profile), then the full teardown with its retained-state checks.
 * No markers and no update/rollback ladder: the question is whether the
 * product provisions and tears down THIS shape.
 */
export async function runProfile(canary: Canary): Promise<void> {
  await preflight(canary);
  await setUpVendorAndApplication(canary);
  await buildRelease(canary, 'v1');
  await createDeploymentAndInstall(canary);
  if (!canary.config.reuseStack) await waitForDefaultHttpsActive(canary);
  await assertBindings(canary);
  await assertSizing(canary);
  await teardownOrSkipInfrastructure(canary);
}

/**
 * The size journey through the product API, vendor to customer:
 *
 *   vendor sets the application default (medium) and minimum (small) ->
 *   v1 build -> vendor invites a customer with the link recommendation
 *   (large) -> customer resolves the invitation, reviews the plan for the
 *   chosen size (`--size`, default small), is refused a stale fingerprint
 *   (409 PLAN_CHANGED) and confirms -> install to HEALTHY -> sizing check ->
 *   v2 deploy and rollback to v1, each followed by the sizing check ->
 *   teardown.
 *
 * The chosen size differs from the link recommendation and the application
 * default, so each layer of the precedence is shown to yield to the next.
 * The shared canary application gets the Deployz default sizes back when the
 * journey ends.
 */
export async function runJourney(canary: Canary): Promise<void> {
  const { evidence } = canary;
  const chosen = canary.config.size ?? 'small';
  await preflight(canary);
  await setUpVendorAndApplication(canary);
  try {
    await setApplicationSizes(canary, JOURNEY_APPLICATION_SIZES);
    await buildRelease(canary, 'v1');
    const invitation = await createJourneyInvitation(canary);
    const { installLinkId, installLinkToken } = await customerConfirmsChosenSize(canary, invitation, chosen);
    await continueInstallFromLink(canary, installLinkId, installLinkToken);

    await evidence.step('v1 is the serving release after install (auto-deploy + digest reconciliation)', async (details) => {
      await waitForPointer(canary, 'v1', 15 * 60_000);
      await assertServing(canary, { serving: 'v1', deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
    });
    await waitForDefaultHttpsActive(canary);
    await assertBindings(canary);
    await assertSizing(canary, chosen);

    await buildRelease(canary, 'v2');
    await deployAndVerify(canary, 'v2', 'v1');
    await assertSizing(canary, chosen);
    await rollbackAndVerify(canary, 'v1', 'v2');
    await assertSizing(canary, chosen);
  } finally {
    try {
      await canary.api.patchApplication(evidence.run.applicationId!, RESTORED_APPLICATION_SIZES);
    } catch (error) {
      console.warn(`Could not restore the application sizes: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await teardownOrSkipInfrastructure(canary);
}
