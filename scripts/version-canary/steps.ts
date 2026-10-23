/**
 * The canary's building blocks — each one drives the product exactly the
 * way a vendor or customer would (control-plane routes, the Quick Create
 * template, the live app), then verifies the outcome at four layers:
 * Deployz (state + pointers + job), the relay/job, AWS (CloudFormation /
 * ECS / ECR read directly), and the live application.
 *
 * Every step records what it saw into the run's evidence; a failing
 * assertion throws with the facts in the message.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  allowedSizeTiers,
  applicationStackNameForInstallation,
  currentInfrastructureSizeProfile,
  profileKey,
  releaseImageTag,
  type InfrastructureSizeTier,
} from '@deployz/contracts';

import { probeLiveApp, probeUrl, readMarker, sampleLiveApp, writeMarker } from './app.js';
import { withDiagnosticsOnFailure } from './diagnostics.js';
import {
  albDnsName,
  callerIdentity,
  createBootstrapStack,
  describeRunningService,
  describeStack,
  ecrDigestForTag,
  lambdaFunctionNames,
  readStackSizing,
  targetHealth,
  templateBucketName,
} from './aws.js';
import { releaseVersionFor, type CanaryConfig, type CanaryProfile } from './config.js';
import {
  ControlPlane,
  ControlPlaneError,
  describeDeployment,
  findJob,
  isTerminalJobState,
  sleep,
  waitFor,
  type DeploymentDetail,
  type PublicInstallConfirmInput,
} from './control-plane.js';
import type { Evidence } from './evidence.js';
import { FIXTURE_RELEASES, type FixtureRelease } from './fixture-repo.js';
import { compareSizing, plannedSizingFromFootprint } from './sizing.js';

export const ECR_REPOSITORY = 'deployz-images';

const MINUTE = 60_000;

export interface Canary {
  readonly config: CanaryConfig;
  readonly evidence: Evidence;
  readonly api: ControlPlane;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function digestSuffix(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  return at >= 0 ? value.slice(at + 1) : value;
}

// ── Preflight ─────────────────────────────────────────────────────────────

export async function preflight(canary: Canary): Promise<void> {
  const { config, evidence, api } = canary;
  await evidence.step('Preflight: AWS identity, region, control plane, fixture repo', async (details) => {
    const identity = await callerIdentity();
    details['identity'] = identity;
    assert(
      identity.account === config.expectedAccountId,
      `AWS account ${identity.account} is not the expected test account ${config.expectedAccountId} — refusing to run`,
    );
    details['region'] = config.region;

    const health = await fetch(`${config.apiUrl}/health`);
    assert(health.status === 200, `control plane ${config.apiUrl}/health answered ${health.status}`);
    const healthBody: unknown = await health.json().catch(() => null);
    const ready = await fetch(`${config.apiUrl}/health/ready`);
    const readyBody: unknown = await ready.json().catch(() => null);
    // Whatever these endpoints expose today (apps/api/src/server.ts): no
    // commit/version field exists yet, so this records the full body rather
    // than a field that would silently be undefined. Recorded in run.json
    // (not just this step's own evidence file) so a canary run against the
    // production control plane keeps which control-plane response it saw.
    evidence.run.controlPlaneHealth = { health: { status: health.status, body: healthBody }, ready: { status: ready.status, body: readyBody } };
    evidence.save();
    details['controlPlaneHealth'] = evidence.run.controlPlaneHealth;

    const bucket = await templateBucketName(config.controlPlaneRegion);
    details['templateBucket'] = bucket;

    const tags = resolveFixtureTags(config.fixtureRepo);
    details['fixtureTags'] = tags;
    evidence.run.fixtureTags = tags;
    for (const release of FIXTURE_RELEASES) {
      assert(tags[release.tag], `fixture repo ${config.fixtureRepo} has no tag ${release.tag} — run pnpm canary:fixture-repo`);
    }
    details['apiUrl'] = api.apiUrl;
  });
}

/** Resolves every fixture tag to its commit and content commit (`<tag>^`). */
export function resolveFixtureTags(repo: string): Record<string, { sha: string; contentSha: string }> {
  const out: Record<string, { sha: string; contentSha: string }> = {};
  const refs = execFileSync('git', ['ls-remote', '--tags', `https://github.com/${repo}.git`], {
    encoding: 'utf8',
  });
  const shaByTag = new Map<string, string>();
  for (const line of refs.split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    const match = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref);
    if (match?.[1]) shaByTag.set(match[1], sha);
  }
  for (const release of FIXTURE_RELEASES) {
    const sha = shaByTag.get(release.tag);
    if (!sha) continue;
    const parent = gh<{ parents: { sha: string }[] }>(`repos/${repo}/commits/${sha}`).parents[0]?.sha ?? '';
    out[release.tag] = { sha, contentSha: parent };
  }
  return out;
}

function gh<T>(path: string): T {
  return JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })) as T;
}

// ── Vendor + application ───────────────────────────────────────────────────

/** The requirements the application must carry: the profile's shape when one
 * is configured; otherwise the legacy request exactly — databaseRequired
 * true, redisRequired never sent (analysis owns it). */
function applicationRequirements(profile: CanaryProfile | null): { databaseRequired: boolean; redisRequired?: boolean } {
  return profile ? { databaseRequired: profile.postgres, redisRequired: profile.redis } : { databaseRequired: true };
}

export async function setUpVendorAndApplication(canary: Canary): Promise<string> {
  const { config, evidence, api } = canary;
  const requirements = applicationRequirements(config.profile);
  const applicationId = await evidence.step('Vendor sign-up, GitHub binding, application', async (details) => {
    if (config.vendor) {
      await api.signIn(config.vendor);
      evidence.run.vendor = { email: config.vendor.email };
      details['vendorEmail'] = config.vendor.email;
    } else {
      const email = `canary-${config.runId.toLowerCase()}@deployz-canary.example.com`;
      const password = `Canary-${config.runId}-${randomBytes(9).toString('base64url')}`;
      await api.signUp({ name: `Canary ${config.runId}`, email, password });
      evidence.run.vendor = { email };
      evidence.saveCredentials(email, password);
      details['vendorEmail'] = email;
    }

    await api.bindGithubInstallation(config.githubInstallationId);
    const installations = await api.listGithubInstallations();
    details['installations'] = installations;
    assert(
      installations.some((i) => i.id === config.githubInstallationId),
      `installation ${config.githubInstallationId} not bound to the canary org`,
    );

    const application = await api.createApplication({
      name: `deployz-canary-${config.runId}`,
      githubInstallationId: config.githubInstallationId,
      repoFullName: config.fixtureRepo,
      repoUrl: `https://github.com/${config.fixtureRepo}`,
      defaultBranch: 'main',
      containerPort: 3000,
      healthPath: '/health',
      ...requirements,
    });
    evidence.run.applicationId = application.id;
    details['applicationId'] = application.id;
    return application.id;
  });

  await evidence.step('Application analysis reaches a deployable manifest', async (details) => {
    // The analyser is asynchronous (worker Lambda). Vendor overrides are a
    // product feature; the canary sets the three fields the readiness gate
    // hard-fails on plus the health path, exactly as the dashboard's
    // Configuration form would, then waits for the readiness report.
    await api.patchApplication(applicationId, {
      containerPort: 3000,
      healthPath: '/health',
      dockerfilePath: 'Dockerfile',
      startCommand: 'node dist/server.js',
      ...requirements,
    });
    await api.triggerAnalysis(applicationId);
    const readiness = await waitFor(
      'application readiness',
      () => api.getReadiness(applicationId),
      (r) => (r.analysisStatus === 'COMPLETE' || r.analysisStatus === 'FAILED' ? r : null),
      { timeoutMs: 10 * MINUTE, intervalMs: 15_000, describe: (r) => `${r.analysisStatus}/${r.state}` },
    );
    details['readiness'] = readiness;
    assert(readiness.analysisStatus === 'COMPLETE', `analysis ended ${readiness.analysisStatus}`);
    assert(
      readiness.state === 'READY' || readiness.state === 'ALMOST_READY',
      `readiness state ${readiness.state}: ${JSON.stringify(readiness.findings).slice(0, 800)}`,
    );

    // The analysis persists the fixture's package.json `migrate` script as
    // the application's migration command. A profile without PostgreSQL must
    // not carry one: the manifest gate refuses a migration command without a
    // database (MANIFEST_NOT_COMPATIBLE). Cleared after the analysis settled,
    // exactly as a vendor would in the Configuration form; nothing re-analyses
    // the application later in the run.
    if (config.profile && !config.profile.postgres) {
      await api.patchApplication(applicationId, { migrationCommand: null });
      const application = await api.getApplication(applicationId);
      assert(
        application['migrationCommand'] === null || application['migrationCommand'] === undefined,
        `migration command still set on a ${config.profile.name} profile: ${String(application['migrationCommand'])}`,
      );
      details['migrationCommandCleared'] = true;
    }
  });

  return applicationId;
}

// ── Releases ───────────────────────────────────────────────────────────────

export async function buildRelease(canary: Canary, fixtureTag: string): Promise<{ id: string; digest: string }> {
  const { config, evidence, api } = canary;
  const release = FIXTURE_RELEASES.find((r) => r.tag === fixtureTag);
  assert(release, `unknown fixture tag ${fixtureTag}`);
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');
  const tagInfo = evidence.run.fixtureTags?.[fixtureTag];
  assert(tagInfo, `fixture tag ${fixtureTag} unresolved`);

  // ── Existing-image mode: skip CodeBuild, use the supplied digest ──────
  if (config.existingImageDigest) {
    return buildReleaseWithExistingImage(canary, fixtureTag, release, applicationId, tagInfo);
  }

  return evidence.step(`Build release ${fixtureTag}`, async (details) => {
    const version = releaseVersionFor(config.runId, fixtureTag);
    const created = await api.createRelease(applicationId, {
      version,
      gitSha: tagInfo.sha,
      ...(release.migrationCommand ? { migrationCommand: release.migrationCommand } : {}),
    });
    evidence.run.releases[fixtureTag] = { id: created.id, version, gitSha: tagInfo.sha, imageTag: releaseImageTag(applicationId, version) };
    evidence.save();
    details['releaseId'] = created.id;
    details['version'] = version;
    details['gitSha'] = tagInfo.sha;

    const ready = await waitFor(
      `release ${version} build`,
      async () => (await api.listReleases(applicationId)).find((r) => r.id === created.id),
      (r) => (r && r.status !== 'BUILDING' ? r : null),
      { timeoutMs: 20 * MINUTE, intervalMs: 20_000, describe: (r) => r?.status ?? 'missing' },
    );
    details['buildStatus'] = ready.status;
    assert(ready.status === 'READY', `release ${version} build ${ready.status}: ${ready.failureReason ?? ''}`);

    const imageTag = releaseImageTag(applicationId, version);
    const digest = await ecrDigestForTag(config.controlPlaneRegion, ECR_REPOSITORY, imageTag);
    assert(digest, `ECR has no image tagged ${imageTag}`);
    details['ecrDigest'] = digest;
    evidence.run.releases[fixtureTag]!.imageDigest = digest;
    evidence.save();
    return { id: created.id, digest };
  });
}

/**
 * Existing-image mode: creates the release record through the API but skips
 * the CodeBuild wait and records the digest from `config.existingImageDigest`.
 * Deploy/rollback use the release ID as normal; the control plane compiles
 * the install template from the frozen manifest, and the image pinning
 * happens through the release.
 *
 * In this mode, all versions (v1, v2, …) share the same digest.
 * // ponytail: single digest for all versions, version verification relies on
 * release/deployment records rather than differing images. If per-version
 * images are needed later, require a separate --existing-image per version.
 */
async function buildReleaseWithExistingImage(
  canary: Canary,
  fixtureTag: string,
  release: FixtureRelease,
  applicationId: string,
  tagInfo: { sha: string; contentSha: string },
): Promise<{ id: string; digest: string }> {
  const { config, evidence, api } = canary;
  const digest = config.existingImageDigest!;

  return evidence.step(`Existing-image release ${fixtureTag} (no CodeBuild)`, async (details) => {
    const version = releaseVersionFor(config.runId, fixtureTag);
    const created = await api.createRelease(applicationId, {
      version,
      gitSha: tagInfo.sha,
      ...(release.migrationCommand ? { migrationCommand: release.migrationCommand } : {}),
    });
    evidence.run.releases[fixtureTag] = { id: created.id, version, gitSha: tagInfo.sha, imageDigest: digest, imageTag: releaseImageTag(applicationId, version) };
    evidence.save();
    details['releaseId'] = created.id;
    details['version'] = version;
    details['gitSha'] = tagInfo.sha;
    details['imageDigest'] = digest;
    details['mode'] = 'existing-image';
    // ponytail: release stays in BUILDING state on the API side (no CodeBuild
    // triggered). The deploy/rollback path uses the release ID; if the API
    // rejects a non-READY release, the deploy call will fail with a clear
    // error from the control plane.
    return { id: created.id, digest };
  });
}

// ── Install ────────────────────────────────────────────────────────────────

export async function createDeploymentAndInstall(canary: Canary): Promise<string> {
  const { config, evidence, api } = canary;
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');

  const deploymentId = await evidence.step('Create customer deployment and launch the install', async (details) => {
    const customer = await api.createCustomer({
      name: `Canary customer ${config.runId}`,
      email: `customer-${config.runId.toLowerCase()}@deployz-canary.example.com`,
    });
    evidence.run.customerId = customer.id;
    const deployment = await api.createDeployment({
      applicationId,
      customerId: customer.id,
      region: config.region,
      ...(config.size ? { sizeProfile: config.size } : {}),
    });
    evidence.run.deploymentId = deployment.id;
    evidence.run.installLinkId = deployment.installLinkId;
    evidence.save();
    details['deploymentId'] = deployment.id;
    return launchInstall(canary, deployment.installLinkId, deployment.installLinkToken, deployment.id, details);
  });

  await waitForInstallHealthy(canary, deploymentId);
  return deploymentId;
}

/**
 * Continues an install from an install link that already exists - the
 * customer's side of the public-link journey, where the confirmation (not the
 * vendor) created the deployment.
 */
export async function continueInstallFromLink(canary: Canary, installLinkId: string, installLinkToken: string): Promise<string> {
  const { evidence, api } = canary;
  const deploymentId = await evidence.step('Launch the install from the confirmed link', async (details) => {
    const info = await api.getInstallInfo(installLinkId, installLinkToken);
    evidence.run.deploymentId = info.deploymentId;
    evidence.run.installLinkId = installLinkId;
    evidence.save();
    details['deploymentId'] = info.deploymentId;
    return launchInstall(canary, installLinkId, installLinkToken, info.deploymentId, details);
  });
  await waitForInstallHealthy(canary, deploymentId);
  return deploymentId;
}

async function launchInstall(canary: Canary, installLinkId: string, installLinkToken: string, deploymentId: string, details: Record<string, unknown>): Promise<string> {
  const { config, evidence, api } = canary;
  const info = await api.getInstallInfo(installLinkId, installLinkToken);
  assert(info.quickCreateUrl, 'install link carries no Quick Create URL (bootstrap template unpublished?)');
  const quick = parseQuickCreateUrl(info.quickCreateUrl);
  details['quickCreate'] = { templateUrl: quick.templateUrl, stackName: quick.stackName, parameters: Object.keys(quick.parameters) };

  // What the browser does when the customer presses "Deploy to AWS".
  const launched = await api.markInstallLaunched(installLinkId);
  assert(launched.state === 'WAITING_FOR_RELAY', `launched -> ${launched.state}`);

  // What the customer's console does on "Create stack": pass the Quick
  // Create parameters through unchanged, plus the canary tags. The
  // control plane compiles the install template from the frozen manifest,
  // so there is no application-template override to apply.
  const stackId = await createBootstrapStack(config.region, {
    stackName: quick.stackName,
    templateUrl: quick.templateUrl,
    parameters: quick.parameters,
    runId: config.runId,
  });
  evidence.run.bootstrapStackName = quick.stackName;
  evidence.save();
  details['bootstrapStackId'] = stackId;
  return deploymentId;
  return deploymentId;
}

async function waitForInstallHealthy(canary: Canary, deploymentId: string): Promise<void> {
  const { config, evidence, api } = canary;
  await evidence.step('Bootstrap stack creates and the connector enrolls', async (details) => {
    const stackName = evidence.run.bootstrapStackName!;
    const stack = await waitFor(
      `bootstrap stack ${stackName}`,
      () => describeStack(config.region, stackName),
      (s) => (s && !s.status.endsWith('IN_PROGRESS') ? s : null),
      { timeoutMs: 15 * MINUTE, describe: (s) => s?.status ?? 'absent' },
    );
    details['bootstrapStackStatus'] = stack.status;
    assert(stack.status === 'CREATE_COMPLETE', `bootstrap stack ${stack.status}: ${stack.statusReason ?? ''}`);
    const installationId = stack.outputs['InstallationId'];
    assert(installationId, 'bootstrap stack has no InstallationId output');
    evidence.run.installationId = installationId;
    evidence.run.applicationStackName = applicationStackNameForInstallation(installationId);
    evidence.run.bootstrapLambdaNames = await lambdaFunctionNames(config.region, stackName);
    evidence.save();
    details['installationId'] = installationId;
    details['applicationStackName'] = evidence.run.applicationStackName;
    details['bootstrapLambdaNames'] = evidence.run.bootstrapLambdaNames;

    const enrolled = await waitFor(
      'relay enrollment',
      () => api.getDeployment(deploymentId),
      (d) => (d.installationId ? d : null),
      { timeoutMs: 12 * MINUTE, describe: describeDeployment },
    );
    assert(enrolled.installationId === installationId, `control plane bound installation ${enrolled.installationId}`);
  });

  await evidence.step('Install reaches HEALTHY with a verified runtime', async (details) =>
    withDiagnosticsOnFailure(canary, details, async () => {
      const detail = await waitFor(
        'install',
        () => api.getDeployment(deploymentId),
        (d) => (d.state === 'HEALTHY' || d.state === 'UPDATE_AVAILABLE' || d.state === 'FAILED' ? d : null),
        { timeoutMs: 45 * MINUTE, describe: describeDeployment },
      );
      details['deployment'] = summarizeDeployment(detail);
      assert(detail.state !== 'FAILED', `install FAILED: ${JSON.stringify(detail.deploymentStatus.failure)}`);
      const installJob = detail.jobs.find((j) => j.type === 'INSTALL');
      assert(installJob && (installJob.state === 'SUCCEEDED' || installJob.state === 'SUCCESS'), 'INSTALL job not settled successfully');
      recordJob(canary, installJob.id, 'INSTALL');

      const appStack = await describeStack(config.region, evidence.run.applicationStackName!);
      assert(appStack?.status === 'CREATE_COMPLETE', `application stack ${appStack?.status ?? 'absent'}`);
      details['applicationStackStatus'] = appStack.status;
      const alb = await albDnsName(config.region, evidence.run.applicationStackName!);
      assert(alb, 'application stack has no load balancer');
      evidence.run.albEndpoint = `http://${alb}`;
      evidence.save();
      details['albEndpoint'] = evidence.run.albEndpoint;
      details['apiAppUrl'] = detail.appUrl;

      // Plan-vs-inventory: at HEALTHY the manifest's required components and
      // the relay's persisted inventory must agree — logical presence only;
      // raw resource counts stay snapshotInfrastructure's job. The snapshot can
      // land moments after the state flips, so give it a bounded settle.
      const inventory = await waitFor(
        'infrastructure expectations',
        () => api.infrastructure(deploymentId),
        (i) => (i.expectations && i.expectations.missing.length === 0 && i.expectations.unexpected.length === 0 ? i : null),
        {
          timeoutMs: 5 * MINUTE,
          describe: (i) =>
            i.expectations
              ? `missing=[${i.expectations.missing.join(',')}] unexpected=[${i.expectations.unexpected.join(',')}] (${i.snapshotState})`
              : 'no expectations yet',
        },
      );
      details['infrastructure'] = { snapshotState: inventory.snapshotState, expectations: inventory.expectations };
    }),
  );
}

/**
 * Default HTTPS reaches ACTIVE and the health path answers below 500
 * through it — ported from `scripts/repository-deployment/deploy.ts`'s
 * "Default HTTPS becomes ACTIVE" step so `core` and `profile` both prove the
 * permanent `d-<id>.deployz.dev` address works, not just the ALB. ACTIVE is
 * the product's word; the edge in front of the ALB can lag it by a sample,
 * so the health probe gets its own bounded wait and a final attempt beyond
 * it (same pattern Stage B uses).
 */
export async function waitForDefaultHttpsActive(canary: Canary, healthPath = '/health'): Promise<DeploymentDetail> {
  const { evidence, api } = canary;
  const deploymentId = evidence.run.deploymentId;
  assert(deploymentId, 'no deployment yet');
  return evidence.step('Default HTTPS becomes ACTIVE and the health path answers over HTTPS', async (details) => {
    const detail = await waitFor(
      'default HTTPS',
      () => api.getDeployment(deploymentId),
      (d) => (d.defaultHttps?.status === 'ACTIVE' || d.defaultHttps?.status === 'ERROR' ? d : null),
      { timeoutMs: 20 * MINUTE, describe: (d) => `${d.defaultHttps?.status ?? 'none'} ${describeDeployment(d)}` },
    );
    const https = detail.defaultHttps;
    details['defaultHttps'] = https;
    assert(https?.status === 'ACTIVE', `default HTTPS ${https?.status ?? 'none'}: ${https?.lastError ?? ''}`);
    assert(https.hostname, 'default HTTPS is ACTIVE but the deployment carries no hostname');
    const url = `https://${https.hostname}`;
    details['appUrl'] = url;
    const healthUrl = `${url}${healthPath}`;
    const probe = await waitFor(
      'HTTPS health path',
      () => probeUrl(healthUrl),
      (p) => (p.status !== null && p.status < 500 ? p : null),
      { timeoutMs: 5 * MINUTE, describe: (p) => String(p.status ?? p.error ?? 'no response') },
    ).catch(() => probeUrl(healthUrl));
    details['httpsHealth'] = probe;
    assert(probe.status !== null && probe.status < 500, `HTTPS health path ${healthPath} answered ${probe.status ?? probe.error ?? 'no response'} after ACTIVE`);
    return detail;
  });
}

export function parseQuickCreateUrl(url: string): {
  templateUrl: string;
  stackName: string;
  parameters: Record<string, string>;
} {
  const hash = url.split('#')[1] ?? '';
  const query = new URLSearchParams(hash.split('?')[1] ?? '');
  const templateUrl = query.get('templateURL');
  const stackName = query.get('stackName');
  assert(templateUrl && stackName, `Quick Create URL lacks templateURL/stackName: ${url}`);
  const parameters: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key.startsWith('param_')) parameters[key.slice('param_'.length)] = value;
  }
  return { templateUrl, stackName, parameters };
}

/**
 * What `GET /canary/bindings` (packages/fixture/src/server.ts) reports: for
 * each env-injected binding, whether it is present and a non-reversible
 * SHA-256 prefix of its value; a raw-TCP redis PING when a REDIS_* binding
 * is configured.
 */
export interface BindingsReport {
  readonly bindings: Record<string, { present: boolean; sha256Prefix: string | null }>;
  readonly redis: { attempted: boolean; ok: boolean; detail: string };
}

/** Which bindings a profile requires the application to carry — the legacy
 * (profile-less) core ladder always requires postgres and never redis, the
 * same rule `applicationRequirements` above applies to the manifest. */
export function expectedBindings(profile: CanaryProfile | null): { database: boolean; redis: boolean } {
  return profile ? { database: profile.postgres, redis: profile.redis } : { database: true, redis: false };
}

/**
 * Proves the application stack actually injected the env/secret bindings
 * its manifest promised — DATABASE_URL when postgres is required, the S3
 * bucket (storage is always required), and a working REDIS_* binding when
 * redis is required. Skips the redis assertion entirely when the profile
 * has none, rather than asserting an absence.
 */
export async function assertBindings(canary: Canary): Promise<void> {
  const { config, evidence } = canary;
  await evidence.step('Application bindings: DATABASE_URL / storage / redis env injection', async (details) => {
    const baseUrl = await liveBaseUrl(canary);
    const response = await fetch(`${baseUrl}/canary/bindings`);
    assert(response.status === 200, `GET /canary/bindings -> ${response.status}`);
    const report = (await response.json()) as BindingsReport;
    details['bindings'] = report;

    const expected = expectedBindings(config.profile);
    if (expected.database) {
      assert(report.bindings['DATABASE_URL']?.present === true, 'DATABASE_URL binding missing though this profile requires postgres');
    }
    assert(report.bindings['STORAGE_BUCKET']?.present === true, 'STORAGE_BUCKET binding missing — storage is always provisioned');

    if (expected.redis) {
      assert(report.redis.attempted, 'no REDIS_URL/REDIS_HOST binding present though this profile requires redis');
      assert(report.redis.ok, `redis PING failed: ${report.redis.detail}`);
    }
    // expected.redis === false: nothing to assert about redis — this profile has none.
  });
}

// ── Version assertions ─────────────────────────────────────────────────────

export interface ExpectedState {
  /** The fixture tag that must be serving (live /version) and be currentReleaseId. */
  readonly serving: string;
  readonly previous?: string | null;
  readonly deploymentState?: string[];
  readonly failureCode?: string | null;
}

/** Waits for the release pointer to name `tag`, then verifies all four layers. */
export async function waitForPointer(canary: Canary, tag: string, timeoutMs = 12 * MINUTE): Promise<DeploymentDetail> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release, `no release for ${tag}`);
  return waitFor(
    `release pointer → ${tag}`,
    () => api.getDeployment(evidence.run.deploymentId!),
    (d) => (d.currentReleaseId === release.id ? d : null),
    { timeoutMs, describe: describeDeployment },
  );
}

/**
 * Base URL to probe the running application on.
 *
 * `albEndpoint` is captured once, at install. The default-HTTPS flow then
 * switches the ALB's port-80 listener to a 301 that preserves `#{host}`, so
 * the raw ALB DNS name redirects to itself over TLS — where the certificate
 * covers `d-<deployment>.deployz.dev` only. Every probe of the recorded
 * endpoint fails hostname verification after that and reads as "the app
 * answered nothing" (observed on real AWS: job SUCCEEDED, ECS rollout
 * COMPLETED, ALB targets healthy, live /version empty).
 *
 * Probe the URL the product advertises to the customer instead, and keep the
 * ALB endpoint as the fallback for before a domain is configured.
 */
/**
 * ALB target health once the rollout's churn has settled.
 *
 * Every rollout — successful or circuit-breaker-reverted — leaves the
 * replaced task's target `draining` for the deregistration delay, and a new
 * one `initial` while it registers. Neither contradicts "this version is
 * serving", but an `unhealthy` target that does not clear does. So poll
 * until nothing is `unhealthy` and something is `healthy`, and let the
 * assertion below judge whatever the window ends with.
 */
async function settledTargetHealth(region: string, stackName: string): Promise<string[]> {
  const deadline = Date.now() + 4 * MINUTE;
  let targets = await targetHealth(region, stackName);
  while (Date.now() < deadline && !isServing(targets)) {
    await sleep(15_000);
    targets = await targetHealth(region, stackName);
  }
  return targets;
}

function isServing(targets: string[]): boolean {
  return targets.some((t) => t === 'healthy') && !targets.some((t) => t === 'unhealthy');
}

/**
 * The invariant a serving version must hold at the ALB: traffic reaches it,
 * and nothing is stuck failing its health check. `draining` and `initial`
 * are in-flight states of a rollout, not faults — requiring every target to
 * be `healthy` failed a correct run whose replaced task was still draining
 * (real AWS, run 20260910-120851-9df9, step 18: the v3 deploy had already
 * FAILED, ECS had rolled back to v2 and ran only the v2 digest, and the ALB
 * read `healthy, draining`).
 */
export function assertTargetsServing(targets: string[]): void {
  assert(targets.length > 0, 'ALB has no targets');
  assert(
    targets.some((t) => t === 'healthy'),
    `ALB targets: ${targets.join(', ')} — none healthy`,
  );
  assert(
    !targets.some((t) => t === 'unhealthy'),
    `ALB targets: ${targets.join(', ')} — a target is still unhealthy`,
  );
}

export function probeBaseUrl(appUrl: string | null | undefined, albEndpoint: string | undefined): string {
  const base = appUrl ?? albEndpoint;
  assert(base, 'no endpoint to probe the application on');
  return base;
}

async function liveBaseUrl(canary: Canary, detail?: DeploymentDetail): Promise<string> {
  const current = detail ?? (await canary.api.getDeployment(canary.evidence.run.deploymentId!));
  return probeBaseUrl(current.appUrl, canary.evidence.run.albEndpoint);
}

export async function assertServing(canary: Canary, expected: ExpectedState, details: Record<string, unknown>): Promise<DeploymentDetail> {
  const { config, evidence, api } = canary;
  const release = evidence.run.releases[expected.serving];
  assert(release?.imageDigest, `no built release for ${expected.serving}`);
  const detail = await api.getDeployment(evidence.run.deploymentId!);
  details['deployment'] = summarizeDeployment(detail);

  // Deployz layer.
  assert(detail.currentReleaseId === release.id, `currentReleaseId=${detail.currentReleaseId} (${detail.version}), expected ${expected.serving} (${release.id})`);
  if (expected.previous !== undefined) {
    const previousId = expected.previous ? evidence.run.releases[expected.previous]?.id ?? null : null;
    assert(detail.previousReleaseId === previousId, `previousReleaseId=${detail.previousReleaseId}, expected ${expected.previous} (${previousId})`);
  }
  if (expected.deploymentState) {
    assert(expected.deploymentState.includes(detail.state), `deployment state ${detail.state}, expected one of ${expected.deploymentState.join('/')}`);
  }
  if (expected.failureCode !== undefined) {
    const code = detail.deploymentStatus.failure?.code ?? null;
    assert(code === expected.failureCode, `deploymentStatus.failure.code=${code}, expected ${expected.failureCode}`);
  }
  assert(detail.deploymentStatus.stage !== 'FAILED', `stage is FAILED while ${expected.serving} should be serving`);

  // AWS layer: what ECS is actually running.
  const service = await describeRunningService(config.region, evidence.run.applicationStackName!);
  assert(service, 'no ECS service in the application stack');
  details['ecs'] = service;
  assert(service.runningDigests.length === 1, `ECS runs ${service.runningDigests.length} distinct digests: ${service.runningDigests.join(', ')}`);
  assert(
    service.runningDigests[0] === digestSuffix(release.imageDigest),
    `running digest ${service.runningDigests[0]} != release ${expected.serving} digest ${release.imageDigest}`,
  );
  const ecr = await ecrDigestForTag(config.controlPlaneRegion, ECR_REPOSITORY, release.imageTag ?? release.version);
  assert(ecr === digestSuffix(release.imageDigest), `ECR digest for ${release.version} is ${ecr}, release row says ${release.imageDigest}`);
  assert(
    digestSuffix(detail.runningImageDigest) === digestSuffix(release.imageDigest),
    `control plane observed digest ${detail.runningImageDigest}, expected ${release.imageDigest}`,
  );
  const targets = await settledTargetHealth(config.region, evidence.run.applicationStackName!);
  details['targetHealth'] = targets;
  assertTargetsServing(targets);

  // Live layer.
  const baseUrl = await liveBaseUrl(canary, detail);
  const live = await sampleLiveApp(baseUrl);
  details['live'] = {
    baseUrl,
    versions: live.versions,
    healthStatuses: live.healthStatuses,
    probeErrors: live.probes.flatMap((p) => (p.error ? [p.error] : [])),
  };
  assert(live.versions.length === 1 && live.versions[0] === expected.serving, `live /version answered ${live.versions.join(', ')}, expected ${expected.serving}`);
  assert(live.healthStatuses.length === 1 && live.healthStatuses[0] === 200, `live /health answered ${live.healthStatuses.join(', ')}`);
  const expectedCommit = evidence.run.fixtureTags?.[expected.serving]?.contentSha;
  const probe = live.probes[0];
  if (expectedCommit && probe?.version) {
    assert(probe.version.commit === expectedCommit, `live /version.commit ${probe.version.commit} != ${expectedCommit} (content commit of ${expected.serving})`);
  }
  return detail;
}

// ── Operations ─────────────────────────────────────────────────────────────

function recordJob(canary: Canary, jobId: string, type: string, releaseTag?: string): void {
  const { evidence } = canary;
  if (!evidence.run.jobs.some((j) => j.id === jobId)) {
    evidence.run.jobs.push({ id: jobId, type, ...(releaseTag ? { releaseTag } : {}) });
  }
  evidence.save();
}

function settleJobRecord(canary: Canary, detail: DeploymentDetail, jobId: string): void {
  const job = findJob(detail, jobId);
  const record = canary.evidence.run.jobs.find((j) => j.id === jobId);
  if (job && record) {
    record.state = job.state;
    record.failureCode = job.failureCode;
    canary.evidence.save();
  }
}

export async function waitForJob(canary: Canary, jobId: string, timeoutMs: number): Promise<DeploymentDetail> {
  const { evidence, api } = canary;
  const detail = await waitFor(
    `job ${jobId.slice(0, 8)}`,
    () => api.getDeployment(evidence.run.deploymentId!),
    (d) => {
      const job = findJob(d, jobId);
      return job && isTerminalJobState(job.state) ? d : null;
    },
    { timeoutMs, describe: (d) => `${findJob(d, jobId)?.state ?? '?'} ${describeDeployment(d)}` },
  );
  settleJobRecord(canary, detail, jobId);
  return detail;
}

export function summarizeDeployment(detail: DeploymentDetail): Record<string, unknown> {
  return {
    state: detail.state,
    stage: detail.deploymentStatus.stage,
    currentActivity: detail.deploymentStatus.currentActivity,
    currentReleaseId: detail.currentReleaseId,
    previousReleaseId: detail.previousReleaseId,
    version: detail.version,
    healthStatus: detail.healthStatus,
    relayStatus: detail.relayStatus,
    runningImageDigest: detail.runningImageDigest,
    appUrl: detail.appUrl,
    failure: detail.deploymentStatus.failure,
    lastJob: detail.jobs.at(-1) ? { id: detail.jobs.at(-1)!.id, type: detail.jobs.at(-1)!.type, state: detail.jobs.at(-1)!.state } : null,
  };
}

/** Deploys `tag`, expecting success; verifies the pointer and all four layers. */
export async function deployAndVerify(canary: Canary, tag: string, expectedPrevious: string | null): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Deploy ${tag} succeeds and becomes the serving release`, async (details) =>
    withDiagnosticsOnFailure(canary, details, async () => {
      const requested = await api.deploy(evidence.run.deploymentId!, release.id);
      details['request'] = requested;
      assert(requested.status === 202, `deploy ${tag} -> ${requested.status} (expected 202, a new attempt)`);
      recordJob(canary, requested.jobId, 'DEPLOY_RELEASE', tag);
      const settled = await waitForJob(canary, requested.jobId, 30 * MINUTE);
      const job = findJob(settled, requested.jobId)!;
      details['job'] = { state: job.state, failureCode: job.failureCode, payloadDigest: job.payload?.['imageDigest'], result: job.result };
      assert(job.state === 'SUCCEEDED', `deploy ${tag} job ${job.state} (${job.failureCode ?? 'no code'}): ${JSON.stringify(job.result).slice(0, 400)}`);
      assert(job.payload?.['imageDigest'] === digestSuffix(release.imageDigest), `job payload digest ${job.payload?.['imageDigest']} != release ${release.imageDigest}`);
      await waitForPointer(canary, tag);
      await assertServing(canary, { serving: tag, previous: expectedPrevious, deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
      const events = await api.events(evidence.run.deploymentId!);
      assert(events.some((e) => e.eventType === 'deploy.completed' && e.jobId === requested.jobId), 'no deploy.completed event for this job');
    }),
  );
}

/** Rolls back to `tag` through the product route; verifies the immutable digest chain. */
export async function rollbackAndVerify(canary: Canary, tag: string, expectedPrevious: string): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Rollback to ${tag} restores the original artifact`, async (details) =>
    withDiagnosticsOnFailure(canary, details, async () => {
      const before = await api.getDeployment(evidence.run.deploymentId!);
      details['before'] = summarizeDeployment(before);
      const requested = await api.rollback(evidence.run.deploymentId!, release.id);
      details['request'] = requested;
      assert(requested.status === 202, `rollback -> ${requested.status} (expected 202, a new attempt)`);
      recordJob(canary, requested.jobId, 'ROLLBACK', tag);
      const settled = await waitForJob(canary, requested.jobId, 30 * MINUTE);
      const job = findJob(settled, requested.jobId)!;
      details['job'] = { state: job.state, failureCode: job.failureCode, payloadDigest: job.payload?.['imageDigest'], result: job.result };
      assert(job.state === 'SUCCEEDED', `rollback job ${job.state} (${job.failureCode ?? 'no code'}): ${JSON.stringify(job.result).slice(0, 400)}`);
      // The digest chain: original release digest == rollback payload digest == running digest (checked in assertServing).
      assert(job.payload?.['imageDigest'] === digestSuffix(release.imageDigest), `rollback payload digest ${job.payload?.['imageDigest']} != original ${release.imageDigest}`);
      await waitForPointer(canary, tag);
      await assertServing(canary, { serving: tag, previous: expectedPrevious, deploymentState: ['HEALTHY', 'UPDATE_AVAILABLE'] }, details);
      const events = await api.events(evidence.run.deploymentId!);
      assert(events.some((e) => e.eventType === 'rollback.requested' && e.jobId === requested.jobId), 'no rollback.requested event');
      assert(events.some((e) => e.eventType === 'rollback.completed' && e.jobId === requested.jobId), 'no rollback.completed event');
      // History, not rewriting: the earlier deploy jobs are still there.
      assert(settled.jobs.length >= before.jobs.length + 1, 'rollback did not add a deployment attempt');
    }),
  );
}

/** Deploys a release expected to FAIL; the previous release must keep serving. */
export async function deployExpectingFailure(canary: Canary, tag: string, stillServing: string, expectedPrevious: string | null): Promise<void> {
  const { evidence, api } = canary;
  const release = evidence.run.releases[tag];
  assert(release?.imageDigest, `release ${tag} not built`);
  await evidence.step(`Deploy ${tag} fails and ${stillServing} keeps serving`, async (details) =>
    withDiagnosticsOnFailure(canary, details, async () => {
      const requested = await api.deploy(evidence.run.deploymentId!, release.id);
      details['request'] = requested;
      assert(requested.status === 202, `deploy ${tag} -> ${requested.status}`);
      recordJob(canary, requested.jobId, 'DEPLOY_RELEASE', tag);
      // Circuit breaker needs several task launches to fail; allow well beyond
      // the relay's runtime bound so a watchdog re-offer is observed too.
      const settled = await waitForJob(canary, requested.jobId, 50 * MINUTE);
      const job = findJob(settled, requested.jobId)!;
      details['job'] = { state: job.state, failureCode: job.failureCode, result: job.result, reconcileCount: (job as unknown as { reconcileCount?: number }).reconcileCount };
      assert(job.state === 'FAILED', `deploy ${tag} job ${job.state}, expected FAILED`);
      assert(job.failureCode === 'ECS_DEPLOYMENT_FAILED' || job.failureCode === 'IMAGE_HEALTH_CHECK_FAILED', `failureCode ${job.failureCode}`);
      // Give the heartbeat a cycle to report the restored digest, then verify.
      await sleep(30_000);
      await assertServing(
        canary,
        { serving: stillServing, previous: expectedPrevious, deploymentState: ['UPDATE_AVAILABLE', 'HEALTHY'], failureCode: job.failureCode },
        details,
      );
      const stillFailedRelease = (await api.listReleases(evidence.run.applicationId!)).find((r) => r.id === release.id);
      details['failedReleaseStatus'] = stillFailedRelease?.status;
      const events = await api.events(evidence.run.deploymentId!);
      assert(events.some((e) => e.eventType === 'deploy.failed' && e.jobId === requested.jobId), 'no deploy.failed event');
      assert(!events.some((e) => e.eventType === 'deploy.completed' && e.jobId === requested.jobId), 'a failed deploy emitted deploy.completed');
    }),
  );
}

// ── Persistence ────────────────────────────────────────────────────────────

export async function seedMarker(canary: Canary, name: string): Promise<string> {
  const { config, evidence } = canary;
  const key = `${name}_${config.runId}`;
  await evidence.step(`Seed persistent data ${key} through the running application`, async (details) => {
    const baseUrl = await liveBaseUrl(canary);
    const live = await probeLiveApp(baseUrl);
    const written = await writeMarker(baseUrl, key, live.version?.version ?? 'unknown');
    details['written'] = written;
    const read = await readMarker(baseUrl, key);
    details['read'] = read;
    assert(read && read['key'] === key, `marker ${key} not readable after write`);
    evidence.run.markers.push(key);
    evidence.save();
  });
  return key;
}

export async function assertMarkers(canary: Canary, details: Record<string, unknown>): Promise<void> {
  const { evidence } = canary;
  const baseUrl = await liveBaseUrl(canary);
  const found: Record<string, unknown> = {};
  for (const key of evidence.run.markers) {
    const record = await readMarker(baseUrl, key);
    assert(record, `persistent marker ${key} is gone`);
    found[key] = record;
  }
  details['markers'] = found;
}

// ── Reuse-stack helpers ─────────────────────────────────────────────────────

const PERSISTENT_TAG_KEY = 'DeployzPersistent';
const PERSISTENT_TAG_VALUE = 'true';
const TEST_MODE_TAG_KEY = 'DeployzTestMode';
const TEST_MODE_TAG_VALUE = 'canary';

/**
 * Verify that a stack exists and carries the persistent-canary tags.
 * Throws a clear message on failure; returns the stack summary on success.
 */
export async function verifyReuseStackTags(
  region: string,
  stackName: string,
): Promise<{ stackName: string; status: string }> {
  const stack = await describeStack(region, stackName);
  if (!stack) {
    throw new Error(
      `No stack "${stackName}" found. --reuse-stack requires a standing stack. ` +
        `Provision one intentionally (e.g. run without --reuse-stack first) or omit --reuse-stack.`,
    );
  }
  if (stack.tags[PERSISTENT_TAG_KEY] !== PERSISTENT_TAG_VALUE) {
    throw new Error(
      `Stack "${stackName}" is missing tag ${PERSISTENT_TAG_KEY}=${PERSISTENT_TAG_VALUE} ` +
        `(found: ${stack.tags[PERSISTENT_TAG_KEY] ?? 'unset'}). ` +
        `--reuse-stack will not adopt an unknown stack.`,
    );
  }
  if (stack.tags[TEST_MODE_TAG_KEY] !== TEST_MODE_TAG_VALUE) {
    throw new Error(
      `Stack "${stackName}" is missing tag ${TEST_MODE_TAG_KEY}=${TEST_MODE_TAG_VALUE} ` +
        `(found: ${stack.tags[TEST_MODE_TAG_KEY] ?? 'unset'}). ` +
        `--reuse-stack will not adopt an unknown stack.`,
    );
  }
  return { stackName: stack.name, status: stack.status };
}

// ── Infrastructure ─────────────────────────────────────────────────────────

export interface InfraSnapshot {
  readonly stackResourceCount: number;
  readonly rdsCount: number;
  readonly albCount: number;
  readonly targetGroupCount: number;
  readonly serviceCount: number;
  readonly bucketCount: number;
  readonly securityGroupCount: number;
  readonly stackStatus: string | null;
}

export async function snapshotInfrastructure(canary: Canary): Promise<InfraSnapshot> {
  const { config, evidence } = canary;
  const stackName = evidence.run.applicationStackName!;
  const stack = await describeStack(config.region, stackName);
  const { listStackResources } = await import('./aws.js');
  const resources = await listStackResources(config.region, stackName);
  const count = (type: string) => resources.filter((r) => r.type === type).length;
  return {
    stackResourceCount: resources.length,
    rdsCount: count('AWS::RDS::DBInstance'),
    albCount: count('AWS::ElasticLoadBalancingV2::LoadBalancer'),
    targetGroupCount: count('AWS::ElasticLoadBalancingV2::TargetGroup'),
    serviceCount: count('AWS::ECS::Service'),
    bucketCount: count('AWS::S3::Bucket'),
    securityGroupCount: count('AWS::EC2::SecurityGroup'),
    stackStatus: stack?.status ?? null,
  };
}

export function assertSameInfrastructure(before: InfraSnapshot, after: InfraSnapshot): void {
  for (const key of Object.keys(before) as (keyof InfraSnapshot)[]) {
    if (key === 'stackStatus') continue;
    assert(before[key] === after[key], `infrastructure changed: ${key} ${before[key]} → ${after[key]}`);
  }
  assert(after.stackStatus === 'CREATE_COMPLETE' || after.stackStatus === 'UPDATE_COMPLETE', `application stack now ${after.stackStatus}`);
}

// ── Idempotency helpers ────────────────────────────────────────────────────

export async function expectBusyOrReplay(
  canary: Canary,
  action: () => Promise<{ status: number; jobId: string }>,
  activeJobId: string,
  details: Record<string, unknown>,
  label: string,
): Promise<'replayed' | 'busy'> {
  try {
    const response = await action();
    details[label] = response;
    assert(response.status === 200 && response.jobId === activeJobId, `${label}: ${response.status} job ${response.jobId} — a second mutation was created`);
    return 'replayed';
  } catch (error) {
    if (error instanceof ControlPlaneError && error.status === 409 && error.code === 'DEPLOYMENT_BUSY') {
      details[label] = { status: 409, code: error.code };
      return 'busy';
    }
    throw error;
  }
}

export function fixtureRelease(tag: string): FixtureRelease {
  const release = FIXTURE_RELEASES.find((r) => r.tag === tag);
  assert(release, `unknown fixture tag ${tag}`);
  return release;
}

// ── Sizing ─────────────────────────────────────────────────────────────────

/**
 * Proves the deployment runs the size it was created with: the frozen size on
 * the deployment, the install plan footprint (plan parity) and the live AWS
 * resources (ECS task definitions of every service, the RDS instance, the
 * ElastiCache group) all equal the current profile of `expectedTier`. The
 * expected tier is `--size`, else the Deployz default (small).
 */
export async function assertSizing(canary: Canary, expectedTier: InfrastructureSizeTier = canary.config.size ?? 'small'): Promise<void> {
  const { config, evidence, api } = canary;
  const deploymentId = evidence.run.deploymentId;
  const stackName = evidence.run.applicationStackName;
  assert(deploymentId && stackName, 'no installed deployment to check the size of');
  await evidence.step(`Sizing: ${expectedTier} matches the frozen size, the plan and AWS`, async (details) => {
    const bindings = expectedBindings(config.profile);
    const detail = await api.getDeployment(deploymentId);
    const plan = await api.plan(deploymentId, 'install');
    assert(plan.footprint, 'the install plan carries no footprint');
    const planned = plannedSizingFromFootprint(plan.footprint);
    const observed = await readStackSizing(config.region, stackName);
    const profile = currentInfrastructureSizeProfile(expectedTier);
    details['expected'] = { tier: expectedTier, profileKey: profileKey(profile), workload: profile.workload, database: profile.database, cache: profile.cache };
    details['actual'] = { frozenSize: detail.size ?? null, plan: planned, aws: observed };
    evidence.run.sizing = { tier: expectedTier, profileKey: profileKey(profile), frozenSize: detail.size?.profileKey ?? null };
    evidence.save();
    const problems = compareSizing({
      expectation: { tier: expectedTier, expectDatabase: bindings.database, expectCache: bindings.redis },
      observed,
      planned,
      frozenSize: detail.size ?? null,
    });
    details['mismatches'] = problems;
    assert(problems.length === 0, `size ${expectedTier} (${profileKey(profile)}) mismatch:\n  - ${problems.join('\n  - ')}`);
  });
}

// ── Journey: vendor settings -> link override -> customer choice ────────────

/** The application sizes the journey sets: the default differs from both the link recommendation and the customer's choice. */
export const JOURNEY_APPLICATION_SIZES = { defaultSizeProfile: 'medium', minimumSizeProfile: 'small' } as const;
export const JOURNEY_LINK_RECOMMENDATION: InfrastructureSizeTier = 'large';
/** Applied again when the journey ends, so the shared canary application keeps the Deployz defaults. */
export const RESTORED_APPLICATION_SIZES = { defaultSizeProfile: 'small', minimumSizeProfile: 'small' } as const;

/** The body of the customer's confirmation (a targeted invitation sends no `customer`). */
export function journeyConfirmBody(input: { idempotencyKey: string; region: string; sizeProfile: InfrastructureSizeTier; planFingerprint: string }): PublicInstallConfirmInput {
  return { ...input, config: [] };
}

/** A size that is neither the customer's choice nor the vendor default, so a fingerprint for it is wrong for the choice. */
export function otherTier(chosen: InfrastructureSizeTier): InfrastructureSizeTier {
  return chosen === 'small' ? 'medium' : 'small';
}

export async function setApplicationSizes(
  canary: Canary,
  sizes: { defaultSizeProfile: InfrastructureSizeTier; minimumSizeProfile: InfrastructureSizeTier },
): Promise<void> {
  const { evidence, api } = canary;
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');
  await evidence.step(`Vendor sets the application sizes: default ${sizes.defaultSizeProfile}, minimum ${sizes.minimumSizeProfile}`, async (details) => {
    await api.patchApplication(applicationId, sizes);
    const application = await api.getApplication(applicationId);
    details['application'] = { defaultSizeProfile: application['defaultSizeProfile'], minimumSizeProfile: application['minimumSizeProfile'] };
    assert(
      application['defaultSizeProfile'] === sizes.defaultSizeProfile && application['minimumSizeProfile'] === sizes.minimumSizeProfile,
      `application sizes did not persist: ${JSON.stringify(details['application'])}`,
    );
  });
}

export interface JourneyInvitation {
  readonly linkId: string;
  readonly token: string;
}

/** The vendor creates a customer and a targeted invitation whose recommendation overrides the application default. */
export async function createJourneyInvitation(canary: Canary): Promise<JourneyInvitation> {
  const { config, evidence, api } = canary;
  const applicationId = evidence.run.applicationId;
  assert(applicationId, 'no application yet');
  return evidence.step(`Vendor invites a customer with the link recommendation ${JOURNEY_LINK_RECOMMENDATION}`, async (details) => {
    const customer = await api.createCustomer({
      name: `Canary customer ${config.runId}`,
      email: `customer-${config.runId.toLowerCase()}@deployz-canary.example.com`,
    });
    evidence.run.customerId = customer.id;
    evidence.save();
    const invitation = await api.createInvitation(customer.id, {
      applicationId,
      recommendedRegion: config.region,
      recommendedSizeProfile: JOURNEY_LINK_RECOMMENDATION,
    });
    details['invitationId'] = invitation.id;
    details['recommendedSizeProfile'] = invitation.recommendedSizeProfile;
    assert(
      invitation.recommendedSizeProfile === JOURNEY_LINK_RECOMMENDATION,
      `invitation recommends ${invitation.recommendedSizeProfile}, expected ${JOURNEY_LINK_RECOMMENDATION}`,
    );
    return { linkId: invitation.id, token: invitation.token };
  });
}

/**
 * The customer's side, with no session: resolve the invitation, check the
 * link recommendation and the offered sizes, review the plan for the chosen
 * size, prove a plan approved for another size is refused, then confirm.
 * Returns the install link id the existing install flow continues from.
 */
export async function customerConfirmsChosenSize(canary: Canary, invitation: JourneyInvitation, chosen: InfrastructureSizeTier): Promise<{ installLinkId: string; installLinkToken: string }> {
  const { config, evidence, api } = canary;
  return evidence.step(`Customer reviews the invitation and confirms the ${chosen} size`, async (details) => {
    const view = await api.publicInstall(invitation.linkId, invitation.token);
    details['sizing'] = view.sizing;
    assert(
      view.sizing.recommended === JOURNEY_LINK_RECOMMENDATION,
      `the page recommends ${view.sizing.recommended}, expected the link recommendation ${JOURNEY_LINK_RECOMMENDATION}`,
    );
    assert(view.sizing.minimum === JOURNEY_APPLICATION_SIZES.minimumSizeProfile, `the page minimum is ${view.sizing.minimum}`);
    const offered = view.sizing.options.map((option) => option.id).join(',');
    const expectedOffered = allowedSizeTiers(JOURNEY_APPLICATION_SIZES.minimumSizeProfile).join(',');
    assert(offered === expectedOffered, `the page offers ${offered}, expected ${expectedOffered}`);
    for (const option of view.sizing.options) {
      const expectedKey = profileKey(currentInfrastructureSizeProfile(option.id as InfrastructureSizeTier));
      assert(option.profileKey === expectedKey, `option ${option.id} is ${option.profileKey}, expected ${expectedKey}`);
    }

    const plan = await api.publicInstallPlan(invitation.linkId, invitation.token, config.region, chosen);
    const other = otherTier(chosen);
    const otherPlan = await api.publicInstallPlan(invitation.linkId, invitation.token, config.region, other);
    details['plans'] = {
      [chosen]: { sizeProfile: plan.sizeProfile, planFingerprint: plan.planFingerprint },
      [other]: { sizeProfile: otherPlan.sizeProfile, planFingerprint: otherPlan.planFingerprint },
    };
    assert(plan.sizeProfile === chosen, `plan for ${chosen} answered size ${plan.sizeProfile}`);
    assert(plan.planFingerprint && otherPlan.planFingerprint, `no plan fingerprint for ${config.region} (undeployable Region?)`);
    assert(plan.planFingerprint !== otherPlan.planFingerprint, `plans for ${chosen} and ${other} carry the same fingerprint`);
    assert(plan.costEstimate && otherPlan.costEstimate, 'a plan carries no cost estimate');
    assert(JSON.stringify(plan.costEstimate) !== JSON.stringify(otherPlan.costEstimate), `plans for ${chosen} and ${other} carry the same cost estimate`);

    const stale = await api.publicInstallConfirm(
      invitation.linkId,
      invitation.token,
      journeyConfirmBody({ idempotencyKey: randomUUID(), region: config.region, sizeProfile: chosen, planFingerprint: otherPlan.planFingerprint }),
      [409],
    );
    details['staleConfirm'] = { status: stale.status, code: stale.body.error?.code };
    assert(stale.status === 409 && stale.body.error?.code === 'PLAN_CHANGED', `a stale fingerprint was answered ${stale.status} ${stale.body.error?.code ?? ''}, expected 409 PLAN_CHANGED`);

    const confirmed = await api.publicInstallConfirm(
      invitation.linkId,
      invitation.token,
      journeyConfirmBody({ idempotencyKey: randomUUID(), region: config.region, sizeProfile: chosen, planFingerprint: plan.planFingerprint }),
    );
    assert(confirmed.status === 201 && confirmed.body.installLinkId && confirmed.body.installLinkToken, `confirm -> ${confirmed.status}, expected 201 with an installLinkId and installLinkToken`);
    details['installLinkId'] = confirmed.body.installLinkId;
    return { installLinkId: confirmed.body.installLinkId, installLinkToken: confirmed.body.installLinkToken };
  });
}
