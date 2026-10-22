import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadConfig } from '../version-canary/config.js';
import type { DeploymentDetail } from '../version-canary/control-plane.js';
import { applyCleanupToClassification, cleanupAttempt } from './cleanup.js';
import { classifyFailure } from './classify.js';
import { appUrlKeys, configFor, deploymentClassFor, loadDeployConfig, parseDeployConfig, providedKeys, requireSmokeContract, secretValue } from './config.js';
import { defaultDeploymentUrl, generateSecret, runRepositoryAttempt, resolveHealthPath, DEFAULT_TIMEOUTS, nextReleaseVersion, reusableRelease, type AwsLike, type ControlPlaneLike, type DeployDeps, reusableReleaseVersion } from './deploy.js';
import { applicationContainerDefinition, arnKind, resourceStillExists, sanitize, stoppedExit } from './evidence.js';
import { manifestFacts, missingKeys, overridesToManifest } from './gate.js';
import { activeRunsBlock, listUnfinishedLedgers, openLedger, readSeries, stageBRun, stageBRunId, writeSeries } from './ledger.js';
import {
  DEPLOY_CONFIG_PATH,
  RECIPES_DIR,
  STAGE_B_DIR,
  assertRealAwsRepos,
  buildPlan,
  ecrDigestLookup,
  identityFor,
  parseRunArgs,
  regionalConfig,
  regionsFor,
  renderPlan,
  repositoryUsedFor,
  requireRealAws,
  selectForRun,
  shouldStopWave,
} from './index.js';
import {
  CLASSIFICATIONS,
  FAILURE_STAGES,
  ROOT_CAUSES,
  buildStageBSummary,
  emptyResult,
  isTrueDeploymentSuccess,
  readResult,
  renderStageBSummary,
  stageBResultSchema,
  writeResult,
  type StageBResult,
} from './results.js';
import { loadTargets, selectTargets, type StageBTarget } from './targets.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

const TARGETS: StageBTarget[] = [
  { id: 'repo-001', repository: 'acme/api', commit: SHA },
  { id: 'repo-002', repository: 'acme/worker', commit: OTHER_SHA },
];

const DEPLOY_CONFIG = parseDeployConfig(`
version: 1
waves:
  wave-1: [repo-002, repo-001]
repositories:
  - id: repo-001
    overrides:
      containerPort: 3000
      healthPath: /healthz
    config:
      - { key: DB_CLIENT, value: pg }
      - { key: APP_URL, value: '\${DEPLOYZ_APP_URL}/app' }
    secrets: [JWT_SECRET, { key: SECRET_KEY, format: hex64 }]
    verify:
      appPath: /
      observationSeconds: 30
`);

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'stage-b-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('deploy-config', () => {
  it('parses and defaults', () => {
    expect(DEPLOY_CONFIG.waves['wave-1']).toEqual(['repo-002', 'repo-001']);
    expect(configFor(DEPLOY_CONFIG, 'repo-001').secrets).toEqual(['JWT_SECRET', { key: 'SECRET_KEY', format: 'hex64' }]);
    expect(configFor(DEPLOY_CONFIG, 'repo-999')).toEqual({ id: 'repo-999', findings: [], notes: [] });
    expect(providedKeys(configFor(DEPLOY_CONFIG, 'repo-001'))).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    expect(appUrlKeys(configFor(DEPLOY_CONFIG, 'repo-001'))).toEqual(['APP_URL']);
    expect(generateSecret('hex64')).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret('hex32')).toMatch(/^[0-9a-f]{32}$/);
    expect(generateSecret('password')).toMatch(/^Sb-[A-Za-z0-9_-]+-1$/);
    expect(generateSecret('base64url')).not.toBe(generateSecret('base64url'));
  });

  it('reads a fromEnv secret from the environment and refuses it when unset', () => {
    const spec = parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    secrets: [{ key: S3_KEY, fromEnv: RUN_S3_KEY }]\n').repositories[0]!.secrets![0]!;
    expect(secretValue(spec, () => 'generated', { RUN_S3_KEY: 'from-env' })).toBe('from-env');
    expect(() => secretValue(spec, () => 'generated', {})).toThrow('S3_KEY reads RUN_S3_KEY, which is not set');
    expect(secretValue({ key: 'K', format: 'hex32' }, (format) => format, {})).toBe('hex32');
  });

  it('refuses duplicates, a key both configured and generated, an unknown field, and a repeated wave member', () => {
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n  - id: repo-001\n')).toThrow('duplicate repository config repo-001');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    config: [{ key: A, value: x }]\n    secrets: [A]\n')).toThrow('both configures and generates A');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    config: [{ key: A, value: x }, { key: A, value: y }]\n')).toThrow('configures A twice');
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    port: 3000\n')).toThrow();
    expect(() => parseDeployConfig('version: 1\nwaves:\n  w: [repo-001, repo-001]\n')).toThrow('wave w lists a repository twice');
  });

  it('refuses overlapping b2/b3 lists with the overlapping ids', () => {
    expect(() => parseDeployConfig('version: 1\nb2Repos: [repo-001]\nb3Repos: [repo-001]\n')).toThrow('b2Repos and b3Repos overlap: repo-001');
    expect(() => parseDeployConfig('version: 1\nb2Repos: [repo-001, repo-002]\nb3Repos: [repo-003, repo-001]\n')).toThrow('repo-001');
    expect(() => parseDeployConfig('version: 1\nb2Repos: [repo-001]\nb3Repos: [repo-002]\n')).not.toThrow();
  });

  it('never accepts a secret value', () => {
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    secrets: [{ key: A, value: x }]\n')).toThrow();
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    secrets: [{ key: A, format: plain }]\n')).toThrow();
  });

  it('parses the committed deploy-config and names only repositories that have a recipe in its waves and class lists', () => {
    const config = loadDeployConfig(DEPLOY_CONFIG_PATH);
    const ids = new Set(loadTargets(RECIPES_DIR).map((target) => target.id));
    for (const members of Object.values(config.waves)) for (const id of members) expect(ids, `wave member ${id} has no recipe`).toContain(id);
    const registry = new Set([...readFileSync(join(STAGE_B_DIR, 'findings.md'), 'utf8').matchAll(/^\| (DEPLOY-\d{3}) \|/gm)].map((m) => m[1]!));
    for (const entry of config.repositories) for (const id of entry.findings) expect(registry, `${entry.id} references unregistered ${id}`).toContain(id);
    // b2/b3 lists are disjoint and every id has a recipe.
    const b2Set = new Set(config.b2Repos);
    const b3Set = new Set(config.b3Repos);
    for (const id of config.b2Repos) expect(ids, `b2Repos ${id} has no recipe`).toContain(id);
    for (const id of config.b3Repos) expect(ids, `b3Repos ${id} has no recipe`).toContain(id);
    expect(config.b2Repos.length).toBeGreaterThan(0);
    expect(config.b3Repos.length).toBeGreaterThan(0);
    expect([...b2Set].filter((id) => b3Set.has(id))).toEqual([]);
  });
});

describe('assertRealAwsRepos (real-AWS virtual-fixture guard)', () => {
  const virtualTargets: StageBTarget[] = [
    { id: 'repo-900', repository: 'deployz-demo/async-app', commit: SHA },
    { id: 'repo-901', repository: 'acme/api', commit: SHA },
  ];

  function makeConfig(repositories: { id: string; fork?: string }[]): Parameters<typeof assertRealAwsRepos>[0] {
    return {
      version: 1,
      waves: {},
      b2Repos: [],
      b3Repos: [],
      repositories: repositories.map((repo) => ({ id: repo.id, fork: repo.fork, findings: [], notes: [] })),
    };
  }

  it('refuses deployz-demo/* virtual fixtures even when the fork is unset', () => {
    expect(() => assertRealAwsRepos(makeConfig([{ id: 'repo-900' }]), virtualTargets)).toThrow(
      /resolves to virtual fixture "deployz-demo\/async-app"/,
    );
  });

  it('refuses deployz-demo/* virtual fixtures even when the fork is set to a deployz-demo/* path', () => {
    expect(() => assertRealAwsRepos(makeConfig([{ id: 'repo-900', fork: 'deployz-demo/async-app' }]), virtualTargets)).toThrow(
      /virtual fixture/,
    );
  });

  it('lets a real GitHub identity through when the fork points at it', () => {
    expect(() => assertRealAwsRepos(makeConfig([{ id: 'repo-901', fork: 'instashop-dev/deployz-phase5-canary' }]), virtualTargets)).not.toThrow();
  });

  it('lets a real GitHub identity through when neither fork nor the target is virtual', () => {
    expect(() => assertRealAwsRepos(makeConfig([{ id: 'repo-901' }]), virtualTargets)).not.toThrow();
  });

  it('refuses an invalid owner/name shape (no slashes, whitespace, etc.)', () => {
    expect(() => assertRealAwsRepos(makeConfig([{ id: 'repo-901', fork: 'no slash here' }]), virtualTargets)).toThrow(
      /invalid repository/,
    );
  });
});

describe('result model', () => {
  it('starts every stage NOT_ATTEMPTED and validates against the schema', () => {
    const result = emptyResult(identityFor(TARGETS[0]!, SHA, 'gate', null));
    expect(() => stageBResultSchema.parse(result)).not.toThrow();
  });

  it('reads a result written with the removed label fields and drops them', () => {
    const legacy = { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'gate', null)), set: 'improvement', cohort: 'realistic', customerRealism: 'high', difficulty: 2, stageAExpected: 'READY', expectedDeployable: true };
    legacy.gate = { ...legacy.gate, outcome: 'correct-accept' } as typeof legacy.gate;
    const parsed = stageBResultSchema.parse(legacy);
    for (const field of ['set', 'cohort', 'customerRealism', 'difficulty', 'stageAExpected', 'expectedDeployable']) expect(parsed).not.toHaveProperty(field);
    expect(parsed.gate).not.toHaveProperty('outcome');
  });

  it('accepts only the documented vocabularies', () => {
    // repository-deployment/README.md was merged into compatibility.md
    // (docs/testing consolidation) — the vocabulary block lives there now.
    const docs = readFileSync(join(STAGE_B_DIR, '..', 'compatibility.md'), 'utf8');
    for (const stage of FAILURE_STAGES) expect(docs).toContain(stage);
    for (const cause of ROOT_CAUSES) expect(docs).toContain(cause);
    expect(CLASSIFICATIONS).toContain('PASS');
    const result = emptyResult(identityFor(TARGETS[0]!, SHA, 'gate', null));
    expect(() => stageBResultSchema.parse({ ...result, classification: 'SOMETHING_ELSE' })).toThrow();
    expect(() => stageBResultSchema.parse({ ...result, rootCause: 'USER_ERROR' })).toThrow();
    expect(() => stageBResultSchema.parse({ ...result, findingIds: ['COMP-001'] })).toThrow();
  });

  it('protects a deployment result and keeps history only with --force', () => {
    const runs = join(tmp, 'runs-protect');
    const gate = emptyResult(identityFor(TARGETS[0]!, SHA, 'gate', null));
    writeResult(runs, gate);
    writeResult(runs, gate); // a gate result always replaces a gate result
    const deploy = { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')), classification: 'PASS' as const, failureStage: null, rootCause: null };
    writeResult(runs, deploy);
    expect(() => writeResult(runs, deploy)).toThrow('rerun with --force');
    const { replaced } = writeResult(runs, { ...deploy, deployzCommit: OTHER_SHA }, { force: true });
    expect(replaced).toMatch(/history[\\/]repo-001\.aaaaaaa\.1\.json$/);
    expect(readResult(runs, 'repo-001')?.deployzCommit).toBe(OTHER_SHA);
  });

  it('summarizes the funnel and the true-deployment-success metric', () => {
    const pass: StageBResult = {
      ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')),
      gate: { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')).gate, status: 'PASS', verdict: 'NEEDS_CONFIGURATION', configuredVerdict: 'READY', missingKeys: ['APP_KEY'] },
      build: { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')).build, status: 'PASS' },
      deployment: { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')).deployment, status: 'PASS' },
      runtime: { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')).runtime, ecs: 'HEALTHY', alb: 'HEALTHY', https: 'PASS' },
      dependencies: { postgres: 'PASS', redis: 'NOT_REQUIRED', storage: 'NOT_REQUIRED', migration: 'NOT_REQUIRED', detail: null },
      cleanup: { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1')).cleanup, status: 'PASS' },
      classification: 'PASS',
      failureStage: null,
      rootCause: null,
      rootCauseEvidence: null,
    };
    const rejected: StageBResult = {
      ...emptyResult(identityFor(TARGETS[1]!, SHA, 'gate', null)),
      gate: { ...emptyResult(identityFor(TARGETS[1]!, SHA, 'gate', null)).gate, status: 'FAIL', verdict: 'NOT_COMPATIBLE' },
      classification: 'GATE_ERROR',
      failureStage: 'GATE_ERROR',
      rootCause: null,
      findingIds: ['DEPLOY-001'],
    };
    expect(isTrueDeploymentSuccess(pass)).toBe(true);
    expect(isTrueDeploymentSuccess({ ...pass, dependencies: { ...pass.dependencies, postgres: 'FAIL' } })).toBe(false);
    const summary = buildStageBSummary([pass, rejected], SHA);
    expect(summary.gate).toMatchObject({ attempted: 2, ready: 0, needsConfiguration: 1, notCompatible: 1 });
    expect(summary.trueDeploymentSuccess).toBe(1);
    expect(summary.trueDeploymentSuccessRate).toBe(50);
    expect(summary.cleanup.successRate).toBe(100);
    expect(summary.byFinding['DEPLOY-001']).toEqual(['repo-002']);
    const rendered = renderStageBSummary([pass, rejected], summary);
    expect(rendered).toContain('**True deployment success / repositories** | **1 / 2 (50%)**');
    expect(rendered).toContain('| repo-002 | acme/worker@bbbbbbb | NOT_COMPATIBLE |');
  });
});

describe('selection and CLI', () => {
  it('selects by id, wave order and finding', () => {
    expect(selectForRun(TARGETS, DEPLOY_CONFIG, { ids: ['repo-002'], wave: undefined, finding: undefined }).map((e) => e.id)).toEqual(['repo-002']);
    expect(() => selectForRun(TARGETS, DEPLOY_CONFIG, { ids: ['repo-042'], wave: undefined, finding: undefined })).toThrow('unknown repository id repo-042');
    expect(selectForRun(TARGETS, DEPLOY_CONFIG, { ids: [], wave: 'wave-1', finding: undefined }).map((e) => e.id)).toEqual(['repo-002', 'repo-001']);
    expect(() => selectForRun(TARGETS, DEPLOY_CONFIG, { ids: [], wave: 'wave-9', finding: undefined })).toThrow('unknown wave wave-9');
    const existing = [{ ...emptyResult(identityFor(TARGETS[1]!, SHA, 'gate', null)), findingIds: ['DEPLOY-001'] }];
    expect(selectForRun(TARGETS, DEPLOY_CONFIG, { ids: [], wave: undefined, finding: 'DEPLOY-001' }, existing).map((e) => e.id)).toEqual(['repo-002']);
  });

  it('takes its repositories from the git recipes of the run-and-check test', () => {
    const targets = loadTargets(RECIPES_DIR);
    const recipe = readFileSync(join(RECIPES_DIR, 'repo-001.yaml'), 'utf8');
    expect(targets.find((target) => target.id === 'repo-001')).toEqual({
      id: 'repo-001',
      repository: /repository: (.+)/.exec(recipe)![1],
      commit: /commit: ([0-9a-f]{40})/.exec(recipe)![1],
    });
    for (const target of targets) expect(target.id).toMatch(/^repo-\d{3}$/);
    expect(selectTargets(targets, ['repo-001']).map((target) => target.id)).toEqual(['repo-001']);
    expect(() => selectTargets(targets, ['new-1'])).toThrow('unknown repository id new-1');
  });

  it('parses the modes and refuses contradictions', () => {
    const gate = parseRunArgs(['--gate', '--repo', 'repo-001', '--repo', 'repo-002']);
    expect(gate.gate).toBe(true);
    expect(gate.ids).toEqual(['repo-001', 'repo-002']);
    expect(gate.offline).toBe(true);
    expect(parseRunArgs(['--real-aws', '--wave', 'wave-1', '--concurrency', '2']).concurrency).toBe(2);
    expect(() => parseRunArgs(['--real-aws', '--concurrency', '3'])).toThrow('--concurrency must be 1 or 2');
    expect(() => parseRunArgs(['--gate', '--real-aws'])).toThrow('exclusive');
    expect(() => parseRunArgs(['--repo', 'repo-001'])).toThrow('choose a mode');
    expect(parseRunArgs(['--resume']).resume).toBe(true);
  });

  it('accepts a supported --region, rejects an unsupported one, and defaults --max-active/--require-smoke/--exercise-update', () => {
    const withRegion = parseRunArgs(['--real-aws', '--repo', 'repo-001', '--region', 'eu-north-1']);
    expect(withRegion.region).toBe('eu-north-1');
    expect(() => parseRunArgs(['--real-aws', '--region', 'mars-central-1'])).toThrow('--region must be one of');
    const defaults = parseRunArgs(['--real-aws', '--repo', 'repo-001']);
    expect(defaults.region).toBeUndefined();
    expect(defaults.maxActive).toBe(2);
    expect(defaults.requireSmoke).toBe(false);
    expect(defaults.exerciseUpdate).toBe(false);
    expect(parseRunArgs(['--real-aws', '--max-active', '3']).maxActive).toBe(3);
    expect(() => parseRunArgs(['--real-aws', '--max-active', '0'])).toThrow('--max-active must be a positive integer');
    expect(parseRunArgs(['--real-aws', '--require-smoke', '--exercise-update']).requireSmoke).toBe(true);
    expect(parseRunArgs(['--real-aws', '--require-smoke', '--exercise-update']).exerciseUpdate).toBe(true);
  });

  it('defaults controlPlaneRegion to us-east-1 and lets DEPLOYZ_CONTROL_PLANE_REGION override it, independent of the install region', () => {
    expect(loadConfig({}).controlPlaneRegion).toBe('us-east-1');
    expect(loadConfig({ AWS_REGION: 'eu-north-1' }).controlPlaneRegion).toBe('us-east-1');
    expect(loadConfig({ DEPLOYZ_CONTROL_PLANE_REGION: 'us-west-2' }).controlPlaneRegion).toBe('us-west-2');
  });

  it('needs the environment opt-in for anything that touches AWS, and nothing for the gate or a dry run', () => {
    const base = parseRunArgs(['--gate']);
    expect(() => requireRealAws(base, {})).not.toThrow();
    expect(() => requireRealAws(parseRunArgs(['--dry-run']), {})).not.toThrow();
    expect(() => requireRealAws(parseRunArgs(['--real-aws']), {})).toThrow('Real AWS E2E is disabled.');
    expect(() => requireRealAws(parseRunArgs(['--cleanup']), {})).toThrow('DEPLOYZ_E2E_ALLOW_REAL_AWS=1');
    expect(() => requireRealAws(parseRunArgs(['--audit']), { DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' })).not.toThrow();
  });

  it('plans the funnel, or the gate only under --gate, and skips protected results', () => {
    const plan = buildPlan(TARGETS, DEPLOY_CONFIG, [], { gate: false, force: false });
    expect(plan.map((l) => [l.id, l.action])).toEqual([
      ['repo-001', 'full-funnel'],
      ['repo-002', 'full-funnel'],
    ]);
    expect(buildPlan(TARGETS, DEPLOY_CONFIG, [], { gate: true, force: false }).map((l) => l.action)).toEqual(['gate-only', 'gate-only']);
    expect(plan[0]?.repositoryUsed).toBe('instashop-dev/api');
    expect(plan[0]?.configuredKeys).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    const done = { ...emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'r')), classification: 'PASS' as const };
    expect(buildPlan(TARGETS, DEPLOY_CONFIG, [done], { gate: false, force: false })[0]?.action).toBe('skip-has-result');
    expect(buildPlan(TARGETS, DEPLOY_CONFIG, [done], { gate: false, force: true })[0]?.action).toBe('full-funnel');
    expect(renderPlan(plan, { concurrency: 1 })).toContain('full funnel: 2, gate only: 0, skipped: 0');
    expect(renderPlan(plan, { concurrency: 1 })).toContain('B1 runtime-reuse');
    // Neither repo is in b2Repos/b3Repos — deploymentClassFor's default (capability-cohort), not the withdrawn B1 label.
    expect(plan[0]?.deploymentClass).toBe('capability-cohort');
    expect(plan[1]?.deploymentClass).toBe('capability-cohort');
  });

  it('points Deployz at the fork the installation can read', () => {
    expect(repositoryUsedFor(TARGETS[0]!, { id: 'repo-001', findings: [], notes: [] })).toEqual({ repositoryUsed: 'instashop-dev/api', repositoryForm: 'fork' });
    expect(repositoryUsedFor(TARGETS[0]!, { id: 'repo-001', fork: 'instashop-dev/acme-api', findings: [], notes: [] }).repositoryUsed).toBe('instashop-dev/acme-api');
  });
});

describe('region routing', () => {
  it('splits the install region from the control-plane region', () => {
    const config = loadConfig({ AWS_REGION: 'eu-north-1', DEPLOYZ_CONTROL_PLANE_REGION: 'us-east-1' });
    expect(regionsFor(config)).toEqual({ region: 'eu-north-1', controlPlaneRegion: 'us-east-1' });
  });

  it('routes an ECR lookup through the control-plane region, not the install region', async () => {
    const calls: [string, string, string][] = [];
    const fake = async (region: string, repository: string, tag: string) => {
      calls.push([region, repository, tag]);
      return 'sha256:x';
    };
    const digest = await ecrDigestLookup(fake, 'us-east-1')('app-1-v1');
    expect(digest).toBe('sha256:x');
    expect(calls).toEqual([['us-east-1', 'deployz-images', 'app-1-v1']]);
  });

  it('rebuilds a ledger-scoped config from the region the ledger recorded, not the process config', () => {
    const process_ = loadConfig({ AWS_REGION: 'eu-north-1', DEPLOYZ_CONTROL_PLANE_REGION: 'us-east-1' });
    const config = regionalConfig(process_, { region: 'ap-southeast-1', stageB: { controlPlaneRegion: 'us-east-1' } });
    expect(config.region).toBe('ap-southeast-1');
    expect(config.controlPlaneRegion).toBe('us-east-1');
    // No controlPlaneRegion recorded on an older ledger: falls back to the process's.
    const fallback = regionalConfig(process_, { region: 'ap-southeast-1', stageB: {} });
    expect(fallback.controlPlaneRegion).toBe('us-east-1');
  });
});

describe('the global real-AWS concurrency guard (--max-active)', () => {
  it('refuses at the limit, allows below it, and finished ledgers do not count', () => {
    expect(activeRunsBlock([{ runId: 'a' }, { runId: 'b' }], 2)).toContain('2 active real-AWS runs (a, b)');
    expect(activeRunsBlock([{ runId: 'a' }], 2)).toBeNull();
    expect(activeRunsBlock([], 2)).toBeNull();
  });
});

describe('deployment class assignment', () => {
  const deploymentConfig = () => parseDeployConfig(`
version: 1
b2Repos: [repo-002]
b3Repos: [repo-003]
repositories:
  - id: repo-001
    findings: []
  - id: repo-002
    findings: []
  - id: repo-003
    findings: []
  - id: repo-004
    deploymentClass: fresh-full
    findings: []
`);

  it('defaults to capability-cohort for repos not in b2/b3 lists (runtime-reuse/B1 is withdrawn)', () => {
    const config = deploymentConfig();
    expect(deploymentClassFor(config, 'repo-001')).toBe('capability-cohort');
    expect(deploymentClassFor(config, 'repo-999')).toBe('capability-cohort');
  });

  it('assigns capability-cohort for repos in b2Repos', () => {
    const config = deploymentConfig();
    expect(deploymentClassFor(config, 'repo-002')).toBe('capability-cohort');
  });

  it('assigns fresh-full for repos in b3Repos', () => {
    const config = deploymentConfig();
    expect(deploymentClassFor(config, 'repo-003')).toBe('fresh-full');
  });

  it('per-repo deploymentClass override takes precedence over b2/b3 lists', () => {
    const config = deploymentConfig();
    expect(deploymentClassFor(config, 'repo-004')).toBe('fresh-full');
  });

  it('plan printer shows class breakdown with counts', () => {
    const config = deploymentConfig();
    const plan = buildPlan(TARGETS, config, [], { gate: false, force: false });
    const rendered = renderPlan(plan, { concurrency: 1 });
    expect(rendered).toContain('B1 runtime-reuse');
    expect(rendered).toContain('B2 capability cohorts');
    expect(rendered).toContain('B3 full-fresh');
    // repo-001 is not in b2/b3 → the deploymentClassFor default, capability-cohort
    expect(plan.find((l) => l.id === 'repo-001')?.deploymentClass).toBe('capability-cohort');
    // repo-002 is in b2Repos → capability-cohort
    expect(plan.find((l) => l.id === 'repo-002')?.deploymentClass).toBe('capability-cohort');
  });

  it('result model schema accepts the three deployment classes', () => {
    const result = emptyResult(identityFor(TARGETS[0]!, SHA, 'deploy', 'run-1', 'runtime-reuse'));
    expect(result.deploymentClass).toBe('runtime-reuse');
    expect(() => stageBResultSchema.parse({ ...result, deploymentClass: 'runtime-reuse' })).not.toThrow();
    expect(() => stageBResultSchema.parse({ ...result, deploymentClass: 'capability-cohort' })).not.toThrow();
    expect(() => stageBResultSchema.parse({ ...result, deploymentClass: 'fresh-full' })).not.toThrow();
    expect(() => stageBResultSchema.parse({ ...result, deploymentClass: 'other' })).toThrow();
  });
});

describe('gate', () => {
  it('maps vendor overrides onto the manifest override vocabulary', () => {
    expect(overridesToManifest({ containerPort: 8080, healthPath: '/up', dockerfilePath: 'docker/Dockerfile', redisRequired: false })).toEqual({
      port: 8080,
      healthPath: '/up',
      dockerfilePath: 'docker/Dockerfile',
      redisRequired: false,
    });
    expect(overridesToManifest(undefined)).toEqual({});
  });

  it('reads the keys the gate blocks on out of its finding', () => {
    expect(missingKeys({ state: 'NEEDS_CONFIGURATION', findings: [{ id: 'required-env-vars-missing', category: 'configuration', severity: 'error', message: "This app requires environment variables that have no value yet: SECRET_KEY, APP_URL. Set them in the application's Configuration screen before deploying." }] })).toEqual(['APP_URL', 'SECRET_KEY']);
    expect(missingKeys({ state: 'READY', findings: [] })).toEqual([]);
  });

  it('records the manifest facts a deployment acts on', () => {
    const facts = manifestFacts({
      schemaVersion: 1,
      application: { root: '.', runtime: 'node', framework: null, dockerfilePath: 'docker/Dockerfile' },
      build: { command: null, context: '.' },
      web: { command: 'node server.js', port: 8080 },
      health: { path: '/healthz', mode: 'explicit' },
      database: { postgres: true, envBindings: [{ name: 'DB_HOST', kind: 'host' }, { name: 'DATABASE_URL', kind: 'url' }] },
      redis: { required: false, envBindings: [] },
      storage: { required: true, envBindings: [{ name: 'S3_BUCKET', kind: 'bucket' }] },
      migration: { command: null, mode: 'startup' },
      worker: { command: null },
      environment: { variables: [{ key: 'SECRET_KEY', required: true, secret: true, source: [], classification: 'deployz_generated' }, { key: 'X', required: false, secret: false, source: [] }] },
      externalServices: [],
      unsupported: [],
    });
    expect(facts).toEqual({
      dockerfilePath: 'docker/Dockerfile',
      buildContext: '.',
      appRoot: '.',
      port: 8080,
      healthPath: '/healthz',
      healthMode: 'explicit',
      migrationCommand: null,
      migrationMode: 'startup',
      postgres: true,
      redis: false,
      storage: true,
      databaseBindings: ['DATABASE_URL', 'DB_HOST'],
      redisBindings: [],
      storageBindings: ['S3_BUCKET'],
      generatedKeys: ['SECRET_KEY'],
    });
  });

  it('follows the health-path precedence', () => {
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [], verify: { healthPath: '/api/health' } }, '/health', 'explicit', undefined)).toEqual({ path: '/api/health', source: 'stage-b' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, '/health', 'explicit', '/status')).toEqual({ path: '/health', source: 'manifest' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, '/health', 'vendor_required', '/status')).toEqual({ path: '/status', source: 'repository-evidence' });
    expect(resolveHealthPath({ id: 'repo-001', findings: [], notes: [] }, null, null, undefined)).toEqual({ path: '/', source: 'fallback' });
  });
});

describe('task containers (DEPLOY-014 shape)', () => {
  it('reads the task definition env from the essential container, not the init container ECS lists first', () => {
    type Def = { name: string; essential?: boolean; environment: { name: string }[] };
    const init: Def = { name: 'RdsCaBundle', essential: false, environment: [] };
    const app: Def = { name: 'App', essential: true, environment: [{ name: 'DATABASE_URL' }] };
    expect(applicationContainerDefinition([init, app])).toBe(app);
    const unmarked: Def = { name: 'App', environment: [] };
    expect(applicationContainerDefinition([unmarked, init])).toBe(unmarked);
    expect(applicationContainerDefinition([])).toBeNull();
  });

  it("reads a stopped task's exit from the container that failed, not the init container that exited 0", () => {
    expect(stoppedExit([{ exitCode: 0, reason: null }, { exitCode: 1, reason: 'boom' }])).toEqual({ exitCode: 1, reason: 'boom' });
    expect(stoppedExit([{ exitCode: 0, reason: null }, { exitCode: 0, reason: null }])).toEqual({ exitCode: 0, reason: null });
    expect(stoppedExit([{ exitCode: null, reason: 'CannotPullContainerError' }])).toEqual({ exitCode: null, reason: 'CannotPullContainerError' });
    expect(stoppedExit([])).toEqual({ exitCode: null, reason: null });
  });
});

describe('arnKind', () => {
  it('classifies the EC2/RDS/ECS/logs/ACM/secret ARN kinds the leak audit now confirms', () => {
    expect(arnKind('arn:aws:ec2:eu-north-1:1:subnet/subnet-003c9d119cc40c747')).toBe('subnet');
    expect(arnKind('arn:aws:ec2:eu-north-1:1:security-group/sg-003c9d119cc40c747')).toBe('security-group');
    expect(arnKind('arn:aws:ec2:eu-north-1:1:vpc/vpc-003c9d119cc40c747')).toBe('vpc');
    expect(arnKind('arn:aws:ec2:eu-north-1:1:network-interface/eni-003c9d119cc40c747')).toBe('network-interface');
    expect(arnKind('arn:aws:ec2:eu-north-1:1:internet-gateway/igw-003c9d119cc40c747')).toBe('internet-gateway');
    expect(arnKind('arn:aws:ec2:eu-north-1:1:route-table/rtb-003c9d119cc40c747')).toBe('route-table');
    expect(arnKind('arn:aws:ec2:us-east-1:1:natgateway/nat-1')).toBe('nat-gateway');
    expect(arnKind('arn:aws:rds:eu-north-1:1:subgrp:deployz-subnets')).toBe('rds-subnet-group');
    expect(arnKind('arn:aws:ecs:eu-north-1:1:cluster/deployz-x')).toBe('ecs-cluster');
    expect(arnKind('arn:aws:ecs:eu-north-1:1:task-definition/deployz-x:3')).toBe('ecs-task-definition');
    expect(arnKind('arn:aws:ecs:eu-north-1:1:service/deployz-x/app')).toBe('ecs-service');
    expect(arnKind('arn:aws:logs:eu-north-1:1:log-group:/deployz/deployz-x:*')).toBe('log-group');
    expect(arnKind('arn:aws:acm:eu-north-1:1:certificate/abcd-1234')).toBe('acm-certificate');
    expect(arnKind('arn:aws:secretsmanager:eu-north-1:1:secret:deployz/x-AbCdEf')).toBe('secret');
    expect(arnKind('arn:aws:s3:::some-bucket')).toBeNull();
    expect(arnKind('arn:aws:rds:eu-north-1:1:db:deployz-x')).toBeNull();
  });
});

describe('resourceStillExists (leak-audit confirmation)', () => {
  // Real AWS, 2026-09-17 23:27Z, eu-north-1, run stage-b-repo-008-…: a fully
  // successful Disconnect/Purge left this subnet audited as a leak while EC2
  // already answered InvalidSubnetID.NotFound — the tagging index lags.
  const purgedSubnet = 'arn:aws:ec2:eu-north-1:151955775369:subnet/subnet-003c9d119cc40c747';
  const notFound = (message: string) =>
    async () => {
      throw { stderr: `An error occurred (${message}) when calling the operation: gone` };
    };
  const instant = async () => {};

  it('confirms a leaked subnet is gone once EC2 answers InvalidSubnetID.NotFound', async () => {
    expect(await resourceStillExists('eu-north-1', purgedSubnet, notFound('InvalidSubnetID.NotFound'))).toBe(false);
  });

  it('confirms a subnet EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ Subnets: [{ SubnetId: 'subnet-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:subnet/subnet-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms a security group is gone once EC2 answers InvalidGroup.NotFound', async () => {
    const exists = await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:security-group/sg-0123456789abcdef0', notFound('InvalidGroup.NotFound'));
    expect(exists).toBe(false);
  });

  it('assumes an unrecognized ARN kind still exists, without calling the AWS CLI', async () => {
    let calls = 0;
    const exec = async () => {
      calls++;
      return { stdout: '{}' };
    };
    expect(await resourceStillExists('eu-north-1', 'arn:aws:s3:::some-bucket', exec)).toBe(true);
    expect(calls).toBe(0);
  });

  it('assumes present, not gone, when the CLI call only throttles — a transient failure must never hide a real leak', async () => {
    const exists = await resourceStillExists('eu-north-1', purgedSubnet, notFound('ThrottlingException'), instant);
    expect(exists).toBe(true);
  });

  it('keeps the NAT gateway rule unchanged: gone once EC2 reports NatGatewayNotFound', async () => {
    const exists = await resourceStillExists('us-east-1', 'arn:aws:ec2:us-east-1:1:natgateway/nat-1', notFound('NatGatewayNotFound'));
    expect(exists).toBe(false);
  });

  it('keeps the NAT gateway rule unchanged: present when EC2 still reports a live state', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ NatGateways: [{ State: 'available' }] }) });
    expect(await resourceStillExists('us-east-1', 'arn:aws:ec2:us-east-1:1:natgateway/nat-1', exec)).toBe(true);
  });

  it('confirms a VPC is gone once EC2 answers InvalidVpcID.NotFound', async () => {
    expect(
      await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:vpc/vpc-0123456789abcdef0', notFound('InvalidVpcID.NotFound')),
    ).toBe(false);
  });

  it('confirms a VPC EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ Vpcs: [{ VpcId: 'vpc-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:vpc/vpc-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms a network interface is gone once EC2 answers InvalidNetworkInterfaceID.NotFound', async () => {
    expect(
      await resourceStillExists(
        'eu-north-1',
        'arn:aws:ec2:eu-north-1:1:network-interface/eni-0123456789abcdef0',
        notFound('InvalidNetworkInterfaceID.NotFound'),
      ),
    ).toBe(false);
  });

  it('confirms a network interface EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ NetworkInterfaces: [{ NetworkInterfaceId: 'eni-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:network-interface/eni-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms an internet gateway is gone once EC2 answers InvalidInternetGatewayID.NotFound', async () => {
    expect(
      await resourceStillExists(
        'eu-north-1',
        'arn:aws:ec2:eu-north-1:1:internet-gateway/igw-0123456789abcdef0',
        notFound('InvalidInternetGatewayID.NotFound'),
      ),
    ).toBe(false);
  });

  it('confirms an internet gateway EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ InternetGateways: [{ InternetGatewayId: 'igw-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:internet-gateway/igw-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms a route table is gone once EC2 answers InvalidRouteTableID.NotFound', async () => {
    expect(
      await resourceStillExists(
        'eu-north-1',
        'arn:aws:ec2:eu-north-1:1:route-table/rtb-0123456789abcdef0',
        notFound('InvalidRouteTableID.NotFound'),
      ),
    ).toBe(false);
  });

  it('confirms a route table EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ RouteTables: [{ RouteTableId: 'rtb-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:route-table/rtb-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms a security group EC2 still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ SecurityGroups: [{ GroupId: 'sg-0123456789abcdef0' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ec2:eu-north-1:1:security-group/sg-0123456789abcdef0', exec)).toBe(true);
  });

  it('confirms an RDS subnet group RDS still describes is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ DBSubnetGroups: [{ DBSubnetGroupName: 'deployz-subnets' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:rds:eu-north-1:1:subgrp:deployz-subnets', exec)).toBe(true);
  });

  it('confirms an RDS subnet group is gone once RDS answers DBSubnetGroupNotFoundFault', async () => {
    expect(
      await resourceStillExists('eu-north-1', 'arn:aws:rds:eu-north-1:1:subgrp:deployz-subnets', notFound('DBSubnetGroupNotFoundFault')),
    ).toBe(false);
  });

  it('confirms an ECS cluster ECS still describes as ACTIVE is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ clusters: [{ status: 'ACTIVE' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:cluster/deployz-x', exec)).toBe(true);
  });

  it('confirms an ECS cluster is gone when ECS lists it in failures and returns no cluster, without throwing', async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ clusters: [], failures: [{ arn: 'arn:aws:ecs:eu-north-1:1:cluster/deployz-x', reason: 'MISSING' }] }),
    });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:cluster/deployz-x', exec)).toBe(false);
  });

  it('confirms an ECS cluster is gone once its status is INACTIVE', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ clusters: [{ status: 'INACTIVE' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:cluster/deployz-x', exec)).toBe(false);
  });

  it('confirms an ECS service ECS still describes as ACTIVE is present', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ services: [{ status: 'ACTIVE' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:service/deployz-x/app', exec)).toBe(true);
  });

  it('confirms an ECS service is gone when ECS lists it in failures and returns no service, without throwing', async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ services: [], failures: [{ arn: 'arn:aws:ecs:eu-north-1:1:service/deployz-x/app', reason: 'MISSING' }] }),
    });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:service/deployz-x/app', exec)).toBe(false);
  });

  it('confirms an ECS service is gone once its status is INACTIVE', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ services: [{ status: 'INACTIVE' }] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:service/deployz-x/app', exec)).toBe(false);
  });

  it('confirms an ECS task definition is gone once its status is INACTIVE', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ taskDefinition: { status: 'INACTIVE' } }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:ecs:eu-north-1:1:task-definition/deployz-x:3', exec)).toBe(false);
  });

  it('confirms a log group is present, matching the exact name and not a longer sibling that shares the prefix', async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ logGroups: [{ logGroupName: '/deployz/deployz-x-extra' }, { logGroupName: '/deployz/deployz-x' }] }),
    });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:logs:eu-north-1:1:log-group:/deployz/deployz-x:*', exec)).toBe(true);
  });

  it('confirms a log group is gone once CloudWatch Logs lists nothing under its prefix', async () => {
    const exec = async () => ({ stdout: JSON.stringify({ logGroups: [] }) });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:logs:eu-north-1:1:log-group:/deployz/deployz-x:*', exec)).toBe(false);
  });

  it('confirms an ACM certificate is present, passing the full ARN to ACM', async () => {
    const certArn = 'arn:aws:acm:eu-north-1:1:certificate/abcd-1234';
    let seenArgs: string[] = [];
    const exec = async (_command: string, args: string[]) => {
      seenArgs = args;
      return { stdout: JSON.stringify({ Certificate: { CertificateArn: certArn } }) };
    };
    expect(await resourceStillExists('eu-north-1', certArn, exec)).toBe(true);
    expect(seenArgs).toContain(certArn);
  });

  it('confirms an ACM certificate is gone once ACM answers ResourceNotFoundException', async () => {
    expect(
      await resourceStillExists('eu-north-1', 'arn:aws:acm:eu-north-1:1:certificate/abcd-1234', notFound('ResourceNotFoundException')),
    ).toBe(false);
  });

  it('confirms a Secrets Manager secret is present', async () => {
    const exec = async () => ({
      stdout: JSON.stringify({ ARN: 'arn:aws:secretsmanager:eu-north-1:1:secret:deployz/x-AbCdEf', Name: 'deployz/x' }),
    });
    expect(await resourceStillExists('eu-north-1', 'arn:aws:secretsmanager:eu-north-1:1:secret:deployz/x-AbCdEf', exec)).toBe(true);
  });

  it('confirms a Secrets Manager secret is gone once Secrets Manager answers ResourceNotFoundException', async () => {
    expect(
      await resourceStillExists(
        'eu-north-1',
        'arn:aws:secretsmanager:eu-north-1:1:secret:deployz/x-AbCdEf',
        notFound('ResourceNotFoundException'),
      ),
    ).toBe(false);
  });
});

describe('classification', () => {
  const base = { message: 'x' } as const;

  it('reports a gate rejection and a configuration refusal', () => {
    expect(classifyFailure({ ...base, point: 'gate', gateVerdict: 'NOT_COMPATIBLE' })).toMatchObject({ failureStage: 'GATE_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'gate', gateVerdict: 'NOT_COMPATIBLE' }).rootCauseEvidence).toContain('rejected the repository');
    expect(classifyFailure({ ...base, point: 'configuration' }).failureStage).toBe('CONFIG_ERROR');
  });

  it('splits build failures into source fetch, image and build', () => {
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'Failed to fetch repo tarball for x (ref: y): HTTP 404' }).failureStage).toBe('SOURCE_FETCH_ERROR');
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'POST_BUILD: docker push denied: requested access' })).toMatchObject({ failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'build', releaseFailure: 'BUILD: COPY failed: file not found in build context' }).failureStage).toBe('BUILD_ERROR');
    expect(classifyFailure({ ...base, point: 'build', timedOut: true }).failureStage).toBe('TIMEOUT');
  });

  // Two repositories in the 2-repository pilot failed this way, 40 minutes
  // apart, and both rebuilt cleanly the next morning. Left to the generic
  // branch the corpus keeps a verdict about an application that is fine.
  it('blames the registry, not the repository, for a metered base-image pull', () => {
    expect(
      classifyFailure({
        ...base,
        point: 'build',
        releaseFailure:
          'CodeBuild reported FAILED — BUILD: COMMAND_EXECUTION_ERROR: Error while executing command: if [ "$(cat /tmp/deployz-build-outcome)" = rate_limited ]; then echo "Docker Hub rate limit (HTTP 429) blocked the base image download" >&2; exit 1; fi',
      }),
    ).toMatchObject({ failureStage: 'BUILD_ERROR', rootCause: 'AWS_TRANSIENT_FAILURE' });
  });

  it('reads container evidence before the CloudFormation status', () => {
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: 'Essential container exited' }], logTail: ['Error: DATABASE_URL is not set'] }).failureStage).toBe('ENV_BINDING_ERROR');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: null }], logTail: ['connect ECONNREFUSED 10.0.1.5:5432'] }).failureStage).toBe('DATABASE_ERROR');
    expect(classifyFailure({ ...base, point: 'install', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: null }], logTail: ['Redis connection to cache:6379 failed'] }).failureStage).toBe('REDIS_ERROR');
    // DEPLOY-007: a migration one-off that cannot verify the RDS chain is a database error, not a migration error.
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'MIGRATION_FAILED', stoppedTasks: [{ exitCode: 1, reason: null, stoppedReason: 'Essential container in task exited' }], logTail: ['Error: self-signed certificate in certificate chain', '    at TLSSocket.onConnectSecure (node:internal/tls/wrap:1787:34)'] })).toMatchObject({ failureStage: 'DATABASE_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'install', stoppedTasks: [{ exitCode: 137, reason: 'OutOfMemoryError', stoppedReason: null }], logTail: ['starting'] })).toMatchObject({ failureStage: 'CONTAINER_START_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'IMAGE_PULL_FAILED' })).toMatchObject({ failureStage: 'IMAGE_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'auto-deploy', failureCode: 'MIGRATION_FAILED', logTail: ['prisma migrate deploy failed'] }).failureStage).toBe('MIGRATION_ERROR');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'QUOTA_EXCEEDED' })).toMatchObject({ failureStage: 'INFRA_ERROR', rootCause: 'TEST_HARNESS_FAILURE' });
  });

  it('tells a wrong health path from a wrong port and from an application error', () => {
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'ECS_DEPLOYMENT_FAILED', stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed ELB health checks' }], targetHealth: ['unhealthy'], healthStatuses: [404], healthPathSource: 'manifest', manifestHealthPath: '/health', probedHealthPath: '/health' })).toMatchObject({ failureStage: 'HEALTH_PATH_ERROR', rootCause: 'ANALYSIS_BUG' });
    // A running container killed on the task definition's own health command, before any ALB target: the in-container probe (DEPLOY-006).
    expect(classifyFailure({ ...base, point: 'install', failureCode: null, stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed container health checks' }], targetHealth: [] })).toMatchObject({ failureStage: 'HEALTH_PATH_ERROR', rootCause: 'DEPLOYZ_BUG' });
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'ECS_DEPLOYMENT_FAILED', stoppedTasks: [{ exitCode: null, reason: null, stoppedReason: 'health checks' }], logTail: ['Listening on 0.0.0.0:8080'] }).failureStage).toBe('PORT_ERROR');
    expect(classifyFailure({ ...base, point: 'runtime', targetHealth: ['unhealthy'], healthStatuses: [503] }).failureStage).toBe('APPLICATION_ERROR');
    expect(classifyFailure({ ...base, point: 'runtime', appStatuses: [500, 500, 500] }).failureStage).toBe('APPLICATION_ERROR');
    expect(classifyFailure({ ...base, point: 'https', httpsStatus: 'ERROR' }).failureStage).toBe('TLS_ERROR');
  });

  it('separates timeouts, leaks and harness faults', () => {
    expect(classifyFailure({ ...base, point: 'install', timedOut: true, stackStatus: 'CREATE_IN_PROGRESS' }).failureStage).toBe('TIMEOUT');
    expect(classifyFailure({ ...base, point: 'install', failureCode: 'STACK_CREATE_FAILED', stackReasons: ['AWS::RDS::DBInstance CREATE_FAILED'] })).toMatchObject({ failureStage: 'INFRA_ERROR', rootCause: null });
    expect(classifyFailure({ ...base, point: 'cleanup', message: '2 resource(s) left after teardown' }).failureStage).toBe('CLEANUP_LEAK');
    expect(classifyFailure({ ...base, point: 'cleanup', message: 'destroy ended in FAILED' }).failureStage).toBe('DESTROY_ERROR');
    expect(classifyFailure({ ...base, point: 'harness' })).toMatchObject({ failureStage: 'TEST_HARNESS_ERROR', rootCause: 'TEST_HARNESS_FAILURE' });
  });

  it('never records a credential', () => {
    expect(sanitize('postgresql://app:s3cret@db:5432/app password=hunter2 Bearer abc.def')).toBe('postgresql://app:***@db:5432/app password=*** Bearer ***');
  });
});

// ── The funnel with fakes ────────────────────────────────────────────────────

interface Script {
  analysisStatus?: string;
  preflight?: { state: string; ready: boolean; blockers: { id: string; message: string }[]; warnings: { id: string }[] };
  releaseStatus?: 'READY' | 'FAILED';
  releaseFailure?: string | null;
  createDeploymentError?: { status: number; code: string; message: string };
  bootstrapStatus?: string;
  installState?: string;
  failureCode?: string | null;
  stackStatus?: string;
  /** Application stack statuses in poll order (the last one repeats). */
  stackStatuses?: string[];
  /** Stopped tasks and logs disappear once the stack has rolled back. */
  evidenceGoneAfterRollback?: boolean;
  pointerAdvances?: boolean;
  httpsStatus?: string;
  probeStatus?: number | null;
  /** Statuses the default-HTTPS hostname answers in probe order (then `probeStatus`). */
  httpsProbeStatuses?: (number | null)[];
  targets?: string[];
  stoppedTasks?: { exitCode: number | null; reason: string | null; stoppedReason?: string }[];
  logTail?: string[];
  application?: Record<string, unknown>;
  presence?: { rds: string | null; cache: string | null; bucket: string | null };
  taskEnv?: { environment: string[]; secrets: string[] };
  /** Releases the application already carries (what --reuse-application looks for). */
  existingReleases?: { id: string; version: string; status: string; failureReason: string | null }[];
  /** Retries reuse the application and any release it already built. */
  reuseApplication?: boolean;
  infrastructure?: {
    snapshotState: 'fresh' | 'stale' | 'none';
    components: { kind: string; status: string; lifecycle: string }[];
    expectations: { components: { kind: string; expected: boolean; present: boolean }[]; missing: string[]; unexpected: string[] } | null;
  };
  plan?: { components: { kind: string; name: string; action: string; lifecycle: string }[] };
  stackResources?: { logicalId: string; type: string; status: string; physicalId: string | null }[];
  /** The status POST /deploy answers for the --exercise-update redeploy. */
  updateDeployStatus?: number;
  /** Body probeBody() answers in probe order, then the default `{"status":"ok"}` 200. */
  smokeProbes?: { status: number | null; body: string; error?: string }[];
  /** --exercise-update: build and deploy a second release after the smoke contract passes. */
  exerciseUpdate?: boolean;
  /** Overrides DEFAULT_TIMEOUTS — a short `inventoryMs` keeps a "never settles" test fast. */
  timeouts?: Partial<typeof DEFAULT_TIMEOUTS>;
  /** Defaults to a fixed value; override to prove a value is captured once, not regenerated per PUT. */
  generateSecret?: (format: string) => string;
  /** Makes the customer-scope secrets PUT (after enrollment) throw a ControlPlaneError. */
  secretDeliveryError?: { status: number; code: string; message: string };
}

function fakes(script: Script): { deps: DeployDeps; calls: string[]; puts: Record<string, unknown>[] } {
  const calls: string[] = [];
  const puts: Record<string, unknown>[] = [];
  const releaseId = 'rel-1';
  /** Releases createRelease has minted during this attempt. */
  const built: { id: string; version: string; status: string; failureReason: string | null }[] = [];
  let deployment: DeploymentDetail & { defaultHttps?: unknown } = {
    id: 'dep-1',
    state: 'WAITING_FOR_RELAY',
    applicationId: 'app-1',
    customerId: 'cust-1',
    installLinkId: 'link-1',
    installationId: null,
    bootstrapStackName: 'deployz-bootstrap-x-12345678',
    currentReleaseId: null,
    previousReleaseId: null,
    version: null,
    relayStatus: 'UNKNOWN',
    healthStatus: 'UNKNOWN',
    cleanupState: null,
    runningImageDigest: null,
    appUrl: null,
    jobs: [],
    deploymentStatus: { stage: 'INSTALLING', currentActivity: '', url: null, health: { status: 'UNKNOWN' }, failure: null, job: null },
  };
  let reads = 0;
  const api: ControlPlaneLike = {
    async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; headers: Headers }> {
      calls.push(`${method} ${path}`);
      if (method === 'PUT') {
        puts.push(body as Record<string, unknown>);
        const entries = ((body as Record<string, unknown> | undefined)?.['entries'] as { isSecret?: boolean }[] | undefined) ?? [];
        if (script.secretDeliveryError && (body as Record<string, unknown>)['customerId'] !== undefined && entries.some((e) => e.isSecret)) {
          const { ControlPlaneError } = await import('../version-canary/control-plane.js');
          throw new ControlPlaneError(script.secretDeliveryError.status, script.secretDeliveryError.code, script.secretDeliveryError.message, null);
        }
      }
      if (path.endsWith('/preflight')) {
        return { status: 200, body: (script.preflight ?? { state: 'READY', ready: true, blockers: [], warnings: [] }) as T, headers: new Headers() };
      }
      return { status: 200, body: {} as T, headers: new Headers() };
    },
    async bindGithubInstallation() {
      calls.push('bind');
      return 'ok';
    },
    async createApplication() {
      calls.push('createApplication');
      return { id: 'app-1' };
    },
    async patchApplication(_id, patch) {
      calls.push(`patch ${Object.keys(patch).join(',')}`);
    },
    async triggerAnalysis() {
      calls.push('analyse');
    },
    async getReadiness() {
      return { state: 'READY', analysisStatus: script.analysisStatus ?? 'COMPLETE', findings: [] };
    },
    async getApplication() {
      return { healthPath: '/healthz', databaseRequired: true, redisRequired: false, storageRequired: false, detectedMetadata: { healthMode: 'explicit', dockerfilePath: 'Dockerfile' }, ...(script.application ?? {}) };
    },
    async createRelease(_id, input) {
      calls.push(`createRelease ${input.gitSha} ${input.version}`);
      // The control plane keeps release versions unique per application.
      if ([...(script.existingReleases ?? []), ...built].some((r) => r.version === input.version)) {
        const { ControlPlaneError } = await import('../version-canary/control-plane.js');
        throw new ControlPlaneError(409, 'RELEASE_VERSION_TAKEN', `Version ${input.version} already exists for this application.`, null);
      }
      built.push({ id: releaseId, version: input.version, status: script.releaseStatus ?? 'READY', failureReason: script.releaseFailure ?? null });
      return { id: releaseId, version: input.version };
    },
    async listReleases() {
      if (script.existingReleases) return [...script.existingReleases, ...built];
      return [{ id: releaseId, version: 'v', status: script.releaseStatus ?? 'READY', failureReason: script.releaseFailure ?? null }];
    },
    async createCustomer() {
      calls.push('createCustomer');
      return { id: 'cust-1' };
    },
    async createDeployment() {
      calls.push('createDeployment');
      if (script.createDeploymentError) {
        const { ControlPlaneError } = await import('../version-canary/control-plane.js');
        throw new ControlPlaneError(script.createDeploymentError.status, script.createDeploymentError.code, script.createDeploymentError.message, null);
      }
      return { id: 'dep-1', installLinkId: 'link-1', installLinkToken: 'link-token-1' };
    },
    async getDeployment() {
      reads += 1;
      // The deployment "progresses" with every read: enrolled → installed → pointer → https.
      const installState = script.installState ?? 'HEALTHY';
      deployment = {
        ...deployment,
        installationId: reads >= 1 ? 'inst-1' : null,
        state: reads >= 2 ? installState : 'INSTALLING',
        jobs: reads >= 2 ? [{ id: 'job-i', type: 'INSTALL', state: installState === 'FAILED' ? 'FAILED' : 'SUCCEEDED', idempotencyKey: 'k', payload: null, failureCode: script.failureCode ?? null, result: null, createdAt: 't', finishedAt: 't' }] : [],
        deploymentStatus: { ...deployment.deploymentStatus, failure: script.failureCode ? { code: script.failureCode, component: null, reference: 'r', message: 'failed', awsStatus: null } : null },
        currentReleaseId: reads >= 3 && (script.pointerAdvances ?? true) ? releaseId : null,
        runningImageDigest: reads >= 3 && (script.pointerAdvances ?? true) ? 'sha256:deadbeef' : null,
        appUrl: reads >= 4 ? 'https://d-dep-1.deployz.dev' : null,
        defaultHttps: reads >= 4 ? { status: script.httpsStatus ?? 'ACTIVE', hostname: 'd-dep-1.deployz.dev', lastError: null } : { status: 'PENDING', hostname: 'd-dep-1.deployz.dev' },
      };
      return deployment;
    },
    async getInstallInfo() {
      return {
        quickCreateUrl:
          'https://console.aws.amazon.com/cloudformation/home?region=us-east-1#/stacks/create/review?templateURL=https%3A%2F%2Fb%2Fbootstrap-template-v1.json&stackName=deployz-bootstrap-x-12345678&param_ControlPlaneUrl=https%3A%2F%2Fapi&param_EnrollmentCode=code',
        bootstrapStackName: 'deployz-bootstrap-x-12345678',
        deploymentId: 'dep-1',
        alreadyInstalled: false,
      };
    },
    async markInstallLaunched() {
      calls.push('launched');
      return { state: 'WAITING_FOR_RELAY' };
    },
    async events() {
      return [];
    },
    async diagnostics() {
      return { code: script.failureCode ?? null };
    },
    async infrastructure() {
      calls.push('infrastructure');
      return (
        script.infrastructure ?? {
          snapshotState: 'fresh',
          components: [],
          expectations: {
            components: [
              { kind: 'application', expected: true, present: true },
              { kind: 'endpoint', expected: true, present: true },
              { kind: 'database', expected: true, present: true },
              { kind: 'cache', expected: false, present: false },
              { kind: 'storage', expected: true, present: true },
            ],
            missing: [],
            unexpected: [],
          },
        }
      );
    },
    async plan(_deploymentId, action) {
      calls.push(`plan ${action}`);
      return (
        script.plan ?? {
          components: [
            { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
            { kind: 'endpoint', name: 'Endpoint', action: 'CREATE', lifecycle: 'delete' },
            { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
            { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
          ],
        }
      );
    },
    async deploy(_deploymentId, releaseId) {
      calls.push(`deploy ${releaseId}`);
      return { status: script.updateDeployStatus ?? 202, jobId: 'job-u', state: 'REQUESTED' };
    },
  };
  let stackReads = 0;
  let lastStackStatus = script.stackStatus ?? 'CREATE_COMPLETE';
  const evidenceGone = () => script.evidenceGoneAfterRollback === true && /^ROLLBACK_(COMPLETE|FAILED)$/.test(lastStackStatus);
  const aws: AwsLike = {
    async createBootstrapStack(input) {
      calls.push(`createStack ${input.stackName} ${Object.keys(input.parameters).sort().join(',')}`);
      return 'arn:stack';
    },
    async describeStack(name) {
      if (name.startsWith('deployz-bootstrap')) return { status: script.bootstrapStatus ?? 'CREATE_COMPLETE', statusReason: null, outputs: { InstallationId: 'inst-1' } };
      if (script.stackStatuses) lastStackStatus = script.stackStatuses[Math.min(stackReads++, script.stackStatuses.length - 1)]!;
      return { status: lastStackStatus, statusReason: null, outputs: {} };
    },
    async lambdaFunctionNames() {
      return ['relay-fn'];
    },
    async describeRunningService() {
      return { desiredCount: 1, runningCount: 1, runningDigests: ['sha256:deadbeef'], deployments: [{ status: 'PRIMARY', rolloutState: 'COMPLETED' }] };
    },
    async targetHealth() {
      return script.targets ?? ['healthy'];
    },
    async albDnsName() {
      return 'alb.example.com';
    },
    async ecrDigestForTag(tag) {
      // Recorded so a test can pin which tag the funnel looks up: the pipeline
      // pushes under <applicationId>-<version>, and a lookup of the bare
      // version finds nothing (DEPLOY-020).
      calls.push(`ecrDigestForTag ${tag}`);
      return 'sha256:deadbeef';
    },
    async listStackResources(name) {
      calls.push(`listStackResources ${name}`);
      return (
        script.stackResources ?? [
          { logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: 'svc' },
          { logicalId: 'Alb', type: 'AWS::ElasticLoadBalancingV2::LoadBalancer', status: 'CREATE_COMPLETE', physicalId: 'alb' },
          { logicalId: 'Db', type: 'AWS::RDS::DBInstance', status: 'CREATE_COMPLETE', physicalId: 'db' },
          { logicalId: 'Bucket', type: 'AWS::S3::Bucket', status: 'CREATE_COMPLETE', physicalId: 'bucket' },
        ]
      );
    },
    async describeStoppedTasks() {
      calls.push('stoppedTasks');
      if (evidenceGone()) return [];
      return (script.stoppedTasks ?? []).map((t, i) => ({ taskArn: `t${i}`, stoppedReason: t.stoppedReason ?? 'Essential container exited', stopCode: 'EssentialContainerExited', stoppedAt: null, containers: [{ name: 'App', exitCode: t.exitCode, reason: t.reason }] }));
    },
    async tailApplicationLogs() {
      calls.push('logs');
      if (evidenceGone()) return [];
      return script.logTail ?? [];
    },
    async describeDependencies() {
      return script.presence ?? { rds: 'db-1', cache: null, bucket: 'bucket-1' };
    },
    async describeTaskDefinitionEnv() {
      return { ...(script.taskEnv ?? { environment: ['PORT', 'DATABASE_HOST'], secrets: ['DATABASE_URL'] }), command: null, image: 'x@sha256:deadbeef' };
    },
  };
  const deps: DeployDeps = {
    api,
    aws,
    probe: async (url) => {
      if (script.httpsProbeStatuses?.length && url.startsWith('https://d-dep-1')) return { status: script.httpsProbeStatuses.shift() ?? null };
      return { status: script.probeStatus === undefined ? 200 : script.probeStatus };
    },
    probeBody: async () => {
      if (script.smokeProbes?.length) return script.smokeProbes.shift()!;
      return { status: 200, body: '{"status":"ok"}' };
    },
    sleep: async () => {},
    now: Date.now,
    region: 'us-east-1',
    githubInstallationId: '156387233',
    timeouts: { ...DEFAULT_TIMEOUTS, ...script.timeouts },
    keep: false,
    generateSecret: script.generateSecret ?? (() => 'never-stored-secret-value-9f2a'),
    pollIntervalMs: 1,
  };
  return { deps, calls, puts };
}

function attempt(
  entry: StageBTarget,
  script: Script,
  config = configFor(DEPLOY_CONFIG, entry.id),
  existingApplicationId?: string,
) {
  const evidenceDir = join(tmp, 'evidence', `${entry.id}-${Math.random().toString(36).slice(2, 8)}`);
  const runId = stageBRunId(entry.id);
  const evidence = openLedger(evidenceDir, loadConfig({}), { repoId: entry.id, repository: entry.repository, commit: entry.commit, deployzCommit: SHA, cleanupNeeded: false }, runId);
  const result = emptyResult(identityFor(entry, SHA, 'deploy', runId));
  const { deps, calls, puts } = fakes(script);
  if (script.reuseApplication) deps.reuseApplication = true;
  if (script.exerciseUpdate) deps.exerciseUpdate = true;
  return {
    run: () =>
      runRepositoryAttempt(deps, {
        target: entry,
        config,
        repositoryUsed: 'instashop-dev/api',
        repositoryForm: 'fork',
        evidence,
        result,
        ...(existingApplicationId ? { existingApplicationId } : {}),
      }),
    calls,
    puts,
    evidence,
    result,
    evidenceDir,
  };
}

describe('the funnel', () => {
  const deployable = TARGETS[0]!;

  it('passes end to end with the release serving, HTTPS active and dependencies bound', async () => {
    // A distinct value per call: proves the customer-scope secrets PUT reuses the
    // vendor-scope PUT's captured values instead of regenerating them.
    let secretCalls = 0;
    const { run, calls, puts, result, evidence } = attempt(deployable, { generateSecret: () => `generated-secret-${++secretCalls}` });
    const out = await run();
    expect(out.classification).toBe('PASS');
    // The vendor scope gets the placeholder (the gate needs the key); the customer scope gets the real address.
    const vendorPut = puts.find((p) => p['customerId'] === undefined)!;
    expect((vendorPut['entries'] as { key: string; value: string }[]).find((e) => e.key === 'APP_URL')?.value).toBe('https://pending.deployz.dev/app');
    const customerPut = puts.find((p) => p['customerId'] === 'cust-1')!;
    expect(customerPut['entries']).toEqual([{ key: 'APP_URL', value: `${defaultDeploymentUrl('dep-1')}/app`, isSecret: false }]);
    expect(out.build.imageDigest).toBe('sha256:deadbeef');
    expect(out.deployment.status).toBe('PASS');
    expect(out.runtime).toMatchObject({ ecs: 'HEALTHY', alb: 'HEALTHY', https: 'PASS', healthPath: '/healthz', healthPathSource: 'stage-b', releaseServing: true });
    expect(out.dependencies).toMatchObject({ postgres: 'PASS', redis: 'NOT_REQUIRED', storage: 'NOT_REQUIRED' });
    expect(out.configuration.keys).toEqual(['APP_URL', 'DB_CLIENT', 'JWT_SECRET', 'SECRET_KEY']);
    expect(out.configuration.generatedKeys).toEqual(['JWT_SECRET', 'SECRET_KEY']);
    expect(calls).toContain('patch containerPort,healthPath');
    expect(calls.some((c) => c.startsWith(`createRelease ${SHA}`))).toBe(true);
    expect(calls).toContain('createStack deployz-bootstrap-x-12345678 ControlPlaneUrl,EnrollmentCode');
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(true);
    expect(stageBRun(evidence).deploymentId).toBe('dep-1');
    // A vendor-scope secret value has no connected deployment to receive it (BUG-004 /
    // DEPLOY-027), so the same generated values are re-delivered at the customer scope
    // once the connector enrolls, and only after enrollment, before the install wait.
    expect(out.configuration.deliveredAfterEnrollment).toEqual(['JWT_SECRET', 'SECRET_KEY']);
    const customerScopePuts = puts.filter((p) => p['customerId'] === 'cust-1');
    expect(customerScopePuts).toHaveLength(2); // the APP_URL PUT, then the secrets PUT
    const secretsPut = customerScopePuts[1]!;
    const vendorSecretEntries = (vendorPut['entries'] as { key: string; value: string; isSecret: boolean }[]).filter((e) => e.isSecret);
    expect(vendorSecretEntries.map((e) => e.key)).toEqual(['JWT_SECRET', 'SECRET_KEY']);
    expect(vendorSecretEntries.map((e) => e.value)).toEqual(['generated-secret-1', 'generated-secret-2']);
    expect(secretsPut['entries']).toEqual(vendorSecretEntries); // same keys AND the same generated values — a regenerated value would use the next counter and fail this
    const stepNames = evidence.run.steps.map((s) => s.name);
    const enrollIdx = stepNames.indexOf('Bootstrap stack creates and the connector enrolls');
    const deliverIdx = stepNames.indexOf('Deliver vendor secrets to the connected customer');
    const installIdx = stepNames.indexOf('INSTALL provisions the application stack');
    expect(deliverIdx).toBeGreaterThan(enrollIdx);
    expect(deliverIdx).toBeLessThan(installIdx);
    expect(evidence.run.steps[deliverIdx]!.details).toEqual({ keys: ['JWT_SECRET', 'SECRET_KEY'] }); // keys only, never values
    for (const value of vendorSecretEntries.map((e) => e.value)) {
      expect(JSON.stringify(result)).not.toContain(value); // the secret value never reaches the result
      expect(JSON.stringify(evidence.run)).not.toContain(value); // nor the ledger
    }
    expect(() => stageBResultSchema.parse(out)).not.toThrow();
  });

  it('does not deliver a customer-scope secret PUT when the repository has no secrets configured (the app-URL PUT is unaffected)', async () => {
    const noSecrets = parseDeployConfig(`
version: 1
repositories:
  - id: repo-001
    overrides:
      containerPort: 3000
      healthPath: /healthz
    config:
      - { key: DB_CLIENT, value: pg }
      - { key: APP_URL, value: '\${DEPLOYZ_APP_URL}/app' }
    verify:
      appPath: /
      observationSeconds: 30
`);
    const { run, puts, evidence } = attempt(deployable, {}, configFor(noSecrets, 'repo-001'));
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.configuration.generatedKeys).toEqual([]);
    expect(out.configuration.deliveredAfterEnrollment).toEqual([]);
    const customerScopePuts = puts.filter((p) => p['customerId'] === 'cust-1');
    expect(customerScopePuts).toHaveLength(1); // only the APP_URL PUT
    expect(customerScopePuts[0]!['entries']).toEqual([{ key: 'APP_URL', value: `${defaultDeploymentUrl('dep-1')}/app`, isSecret: false }]);
    expect(evidence.run.steps.some((s) => s.name === 'Deliver vendor secrets to the connected customer')).toBe(false);
    expect(() => stageBResultSchema.parse(out)).not.toThrow();
  });

  it('stops at secrets-delivery, not configuration, when the customer-scope secrets PUT fails after enrollment', async () => {
    const { run, result, evidence } = attempt(deployable, {
      secretDeliveryError: { status: 500, code: 'INTERNAL_ERROR', message: 'the control plane could not accept the config update' },
    });
    const out = await run();
    expect(out.classification).toBe('ENV_BINDING_ERROR');
    expect(out.failureStage).toBe('ENV_BINDING_ERROR');
    expect(out.rootCauseEvidence).toContain('the customer-scope secret delivery failed');
    expect(out.rootCauseEvidence).toContain('the control plane could not accept the config update');
    // Configuration had already reached PASS (the vendor-scope PUT and preflight both
    // succeeded); the later delivery failure must still be visible on that section.
    expect(out.configuration.status).toBe('FAIL');
    expect(out.configuration.detail).toContain('the control plane could not accept the config update');
    expect(out.deployment.status).toBe('NOT_ATTEMPTED'); // the funnel never reached INSTALL
    expect(JSON.stringify(result)).not.toContain('never-stored-secret-value');
    expect(JSON.stringify(evidence.run)).not.toContain('never-stored-secret-value');
    expect(() => stageBResultSchema.parse(out)).not.toThrow();
  });

  it('records a gate rejection and a configuration refusal without building', async () => {
    const rejected = await attempt(deployable, { preflight: { state: 'NOT_COMPATIBLE', ready: false, blockers: [{ id: 'unsupported', message: 'x' }], warnings: [] } });
    const refused = await rejected.run();
    expect(refused.classification).toBe('GATE_ERROR');
    expect(refused.gate.status).toBe('FAIL');
    expect(rejected.calls).not.toContain('createDeployment');
    expect(rejected.calls.some((c) => c.startsWith('createRelease'))).toBe(false);
    const needs = await attempt(deployable, { preflight: { state: 'NEEDS_CONFIGURATION', ready: false, blockers: [{ id: 'required-env-vars-missing', message: 'APP_KEY' }], warnings: [] } });
    expect((await needs.run()).classification).toBe('CONFIG_ERROR');
    const gate422 = await attempt(deployable, { createDeploymentError: { status: 422, code: 'MANIFEST_NEEDS_CONFIGURATION', message: 'needs APP_KEY' } });
    const out = await gate422.run();
    expect(out.classification).toBe('CONFIG_ERROR');
    expect(gate422.calls.some((c) => c.startsWith('createStack'))).toBe(false);
  });

  it('stops before any infrastructure when the build fails', async () => {
    const { run, calls } = attempt(deployable, { releaseStatus: 'FAILED', releaseFailure: 'BUILD: COMMAND_EXECUTION_ERROR: docker build failed' });
    const out = await run();
    expect(out.classification).toBe('BUILD_ERROR');
    expect(out.build.status).toBe('FAIL');
    expect(out.deployment.status).toBe('NOT_ATTEMPTED');
    expect(calls).not.toContain('createDeployment');
  });

  it('settles the install on a rolled-back stack even while the product still reports INSTALLING', async () => {
    const { run } = attempt(deployable, { installState: 'INSTALLING', stackStatus: 'ROLLBACK_COMPLETE', targets: [], stoppedTasks: [{ exitCode: 0, reason: null, stoppedReason: 'Task failed container health checks' }] });
    const out = await run();
    expect(out.deployment.status).toBe('FAIL');
    expect(out.deployment.stackStatus).toBe('ROLLBACK_COMPLETE');
    expect(out.classification).toBe('HEALTH_PATH_ERROR');
    expect(out.rootCause).toBe('DEPLOYZ_BUG');
  });

  it('collects task and log evidence when the install fails and classifies from it', async () => {
    const { run, calls, result } = attempt(deployable, {
      installState: 'FAILED',
      failureCode: 'STACK_CREATE_FAILED',
      stackStatus: 'ROLLBACK_COMPLETE',
      stoppedTasks: [{ exitCode: 1, reason: null }],
      logTail: ['FATAL: password authentication failed for user "app"'],
    });
    const out = await run();
    expect(out.classification).toBe('DATABASE_ERROR');
    expect(out.deployment.status).toBe('FAIL');
    expect(out.deployment.failureCode).toBe('STACK_CREATE_FAILED');
    expect(calls).toContain('stoppedTasks');
    expect(calls).toContain('logs');
    expect((result.evidence['failure'] as { logTail: string[] }).logTail[0]).toContain('password authentication failed');
  });

  it('keeps the task and log evidence a poll saw before the rollback removed the cluster and the log group', async () => {
    const { run, result, evidence } = attempt(deployable, {
      installState: 'INSTALLING',
      stackStatuses: ['CREATE_IN_PROGRESS', 'CREATE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS', 'ROLLBACK_COMPLETE'],
      evidenceGoneAfterRollback: true,
      targets: [],
      stoppedTasks: [{ exitCode: 1, reason: null }],
      logTail: ['Error: connect ECONNREFUSED 10.0.1.5:5432'],
    });
    const out = await run();
    expect(out.deployment.status).toBe('FAIL');
    expect(out.deployment.stackStatus).toBe('ROLLBACK_COMPLETE');
    expect(out.classification).toBe('DATABASE_ERROR');
    const failure = result.evidence['failure'] as { stoppedTasks: { exitCode: number | null }[]; logTail: string[] };
    expect(failure.stoppedTasks[0]?.exitCode).toBe(1);
    expect(failure.logTail[0]).toContain('ECONNREFUSED');
    const install = evidence.run.steps.find((s) => s.name.startsWith('INSTALL'));
    expect(install?.details['stoppedTasksDuringInstall']).toBe(1);
    expect((install?.details['observedLogTail'] as string[])[0]).toContain('ECONNREFUSED');
  });

  it('waits for the HTTPS health path to answer after ACTIVE instead of failing the window on the edge lag', async () => {
    const { run, evidence } = attempt(deployable, { httpsProbeStatuses: [521, 521, 200] });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.runtime.observation?.httpsHealthStatuses.every((s) => s === 200)).toBe(true);
    const https = evidence.run.steps.find((s) => s.name.startsWith('Default HTTPS'));
    expect((https?.details['httpsHealth'] as { status: number }).status).toBe(200);
    expect(typeof https?.details['httpsReadyAfterMs']).toBe('number');
  });

  it('fails the runtime stage on a persistent 5xx and the HTTPS stage on a certificate error', async () => {
    const app = await attempt(deployable, { probeStatus: 503 });
    expect((await app.run()).classification).toBe('APPLICATION_ERROR');
    const tls = await attempt(deployable, { httpsStatus: 'ERROR' });
    const out = await tls.run();
    expect(out.classification).toBe('TLS_ERROR');
    expect(out.runtime.https).toBe('FAIL');
  });

  it('fails dependency verification when a required binding is absent', async () => {
    const { run } = attempt(deployable, { taskEnv: { environment: ['PORT'], secrets: [] } });
    const out = await run();
    expect(out.dependencies.postgres).toBe('FAIL');
    expect(out.classification).toBe('APPLICATION_ERROR');
  });

  it('records the resource manifest in the ledger and per-type counts in the result', async () => {
    const { run, evidence } = attempt(deployable, {});
    const out = await run();
    expect(out.deployment.resourcesByType).toEqual({
      'AWS::ECS::Service': 1,
      'AWS::ElasticLoadBalancingV2::LoadBalancer': 1,
      'AWS::RDS::DBInstance': 1,
      'AWS::S3::Bucket': 1,
    });
    expect(out.deployment.region).toBe('us-east-1');
    expect(stageBRun(evidence).stageB.resources?.applicationStack).toHaveLength(4);
    expect(stageBRun(evidence).stageB.resources?.bootstrapStack.length).toBeGreaterThan(0);
  });
});

describe('inventory gate (plan-versus-actual)', () => {
  const deployable = TARGETS[0]!;

  it('passes when the plan, the inventory expectations and the stack resources all agree', async () => {
    const { run } = attempt(deployable, {});
    const out = await run();
    expect(out.inventory).toMatchObject({ status: 'PASS', planCreateKinds: ['application', 'database', 'endpoint', 'storage'], missing: [], unexpected: [] });
  });

  it('dedupes a repeated catalog kind (web + separate worker are both `application`)', async () => {
    const { run } = attempt(deployable, {
      plan: {
        components: [
          { kind: 'application', name: 'Web', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'application', name: 'Worker', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'endpoint', name: 'Endpoint', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
          { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
        ],
      },
    });
    const out = await run();
    expect(out.inventory.status).toBe('PASS');
    expect(out.inventory.planCreateKinds).toEqual(['application', 'database', 'endpoint', 'storage']);
    expect(out.inventory.missing).toEqual([]);
    expect(out.inventory.unexpected).toEqual([]);
  });

  it('folds the plan `worker` role into the inventory `application` kind', async () => {
    const { run } = attempt(deployable, {
      plan: {
        components: [
          { kind: 'application', name: 'Web', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'worker', name: 'Scheduled task', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'endpoint', name: 'Endpoint', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'database', name: 'Database', action: 'CREATE', lifecycle: 'retain' },
          { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
        ],
      },
    });
    const out = await run();
    // `worker` is a plan presentation role, not an inventory catalog kind:
    // the inventory classifies every AWS::ECS::* resource as `application`.
    expect(out.inventory.planCreateKinds).toEqual(['application', 'database', 'endpoint', 'storage']);
    expect(out.inventory.status).toBe('PASS');
  });

  it('fails INFRA_ERROR when the infrastructure expectations never settle', async () => {
    const { run } = attempt(deployable, {
      infrastructure: {
        snapshotState: 'stale',
        components: [],
        expectations: { components: [{ kind: 'application', expected: true, present: false }], missing: ['application'], unexpected: [] },
      },
      timeouts: { inventoryMs: 5 },
    });
    const out = await run();
    expect(out.classification).toBe('INFRA_ERROR');
    expect(out.rootCause).toBe('DEPLOYZ_BUG');
    expect(out.inventory.status).toBe('FAIL');
  }, 10_000);

  it('fails when a plan CREATE kind has no matching resource in the stack', async () => {
    const { run } = attempt(deployable, {
      stackResources: [{ logicalId: 'Service', type: 'AWS::ECS::Service', status: 'CREATE_COMPLETE', physicalId: 'svc' }],
    });
    const out = await run();
    expect(out.classification).toBe('INFRA_ERROR');
    expect(out.inventory.missing).toEqual(expect.arrayContaining(['endpoint', 'database', 'storage']));
  });

  it('fails when a resource exists for a kind the plan did not create', async () => {
    const { run } = attempt(deployable, {
      plan: {
        components: [
          { kind: 'application', name: 'Application', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'endpoint', name: 'Endpoint', action: 'CREATE', lifecycle: 'delete' },
          { kind: 'storage', name: 'Storage', action: 'CREATE', lifecycle: 'retain' },
        ],
      },
      infrastructure: {
        snapshotState: 'fresh',
        components: [],
        expectations: {
          components: [
            { kind: 'application', expected: true, present: true },
            { kind: 'endpoint', expected: true, present: true },
            { kind: 'database', expected: false, present: false },
            { kind: 'cache', expected: false, present: false },
            { kind: 'storage', expected: true, present: true },
          ],
          missing: [],
          unexpected: [],
        },
      },
    });
    const out = await run();
    expect(out.classification).toBe('INFRA_ERROR');
    expect(out.inventory.unexpected).toContain('database');
  });
});

describe('smoke contracts', () => {
  const deployable = TARGETS[0]!;
  const withSmoke = (checks: string) =>
    configFor(
      parseDeployConfig(`version: 1\nrepositories:\n  - id: repo-001\n    smoke:\n${checks}\n`),
      'repo-001',
    );

  it('rejects a status-only contract at the config-schema level', () => {
    expect(() => parseDeployConfig('version: 1\nrepositories:\n  - id: repo-001\n    smoke:\n      - { path: /health, status: 200 }\n')).toThrow();
  });

  it('passes a status + bodyIncludes check', async () => {
    const config = withSmoke('      - { path: /health, status: 200, bodyIncludes: ok }\n');
    const { run } = attempt(deployable, { smokeProbes: [{ status: 200, body: '{"status":"ok"}' }] }, config);
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.runtime.smoke).toEqual([{ path: '/health', status: 200, ok: true, detail: 'ok', exercises: [] }]);
  });

  it('passes and fails on jsonPath/jsonEquals', async () => {
    const config = withSmoke('      - { path: /health, status: 200, jsonPath: data.ok, jsonEquals: true }\n');
    const ok = attempt(deployable, { smokeProbes: [{ status: 200, body: '{"data":{"ok":true}}' }] }, config);
    expect((await ok.run()).classification).toBe('PASS');
    const bad = attempt(deployable, { smokeProbes: [{ status: 200, body: '{"data":{"ok":false}}' }] }, config);
    const out = await bad.run();
    expect(out.classification).toBe('APPLICATION_ERROR');
    expect(out.runtime.smoke[0]?.ok).toBe(false);
  });

  it('retries a failing check and succeeds on the third try', async () => {
    const config = withSmoke('      - { path: /health, status: 200, bodyIncludes: ok, retries: 2, retryDelaySeconds: 1 }\n');
    const { run } = attempt(
      deployable,
      { smokeProbes: [{ status: 500, body: '' }, { status: 500, body: '' }, { status: 200, body: 'ok' }] },
      config,
    );
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.runtime.smoke[0]).toMatchObject({ ok: true, status: 200 });
  });

  it('feeds an exercised dependency FAIL on a failing check without touching the others', async () => {
    const config = withSmoke('      - { path: /health, status: 200, bodyIncludes: ok, exercises: [postgres], retries: 0 }\n');
    const { run } = attempt(deployable, { smokeProbes: [{ status: 503, body: '' }] }, config);
    const out = await run();
    expect(out.classification).toBe('APPLICATION_ERROR');
    expect(out.dependencies.postgres).toBe('FAIL');
  });

  it('--require-smoke refuses a repository with no contract before any create call', () => {
    expect(() => requireSmokeContract(configFor(DEPLOY_CONFIG, 'repo-001'), true)).toThrow('has no smoke contract');
    expect(() => requireSmokeContract(configFor(DEPLOY_CONFIG, 'repo-001'), false)).not.toThrow();
    const config = withSmoke('      - { path: /health, status: 200, bodyIncludes: ok }\n');
    expect(() => requireSmokeContract(config, true)).not.toThrow();
  });
});

describe('--exercise-update', () => {
  const deployable = TARGETS[0]!;

  it('happy path: builds, deploys and re-verifies a second release', async () => {
    const { run, calls } = attempt(deployable, { exerciseUpdate: true });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.update).toMatchObject({ status: 'PASS', imageDigest: 'sha256:deadbeef' });
    expect(out.update.version?.endsWith('-u2')).toBe(true);
    expect(calls.some((c) => c.startsWith('deploy '))).toBe(true);
  });

  it('classifies a failed deploy job as INFRA_ERROR', async () => {
    const { run } = attempt(deployable, { exerciseUpdate: true, updateDeployStatus: 500 });
    const out = await run();
    expect(out.classification).toBe('INFRA_ERROR');
    expect(out.update.status).toBe('FAIL');
  });
});

describe('reusing an application on a retry (--reuse-application)', () => {
  const deployable = TARGETS[0]!;
  const config = configFor(DEPLOY_CONFIG, deployable.id);

  it('names a release by repository, pinned commit and image inputs', () => {
    const version = reusableReleaseVersion(deployable, config);
    expect(version).toBe(`${deployable.id}-${deployable.commit.slice(0, 7)}-${version.split('-').pop()}`);
    // A different pinned commit is a different image.
    expect(reusableReleaseVersion({ ...deployable, commit: 'f'.repeat(40) }, config)).not.toBe(version);
  });

  it('changes the version when an image input changes, not when a runtime one does', () => {
    const version = reusableReleaseVersion(deployable, config);
    const rebuilt = { ...config, overrides: { ...config.overrides, dockerfilePath: 'other/Dockerfile' } };
    expect(reusableReleaseVersion(deployable, rebuilt)).not.toBe(version);
    // Port and health path shape the deployment, never the image.
    const sameImage = { ...config, overrides: { ...config.overrides, containerPort: 9999, healthPath: '/other' } };
    expect(reusableReleaseVersion(deployable, sameImage)).toBe(version);
  });

  it('builds when the application has no matching release, and records that it built', async () => {
    const { run, calls } = attempt(deployable, { reuseApplication: true });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(calls.some((c) => c.startsWith(`createRelease ${SHA}`))).toBe(true);
    expect(out.build.imageReused).toBe(false);
  });

  it('redeploys the release a previous attempt built instead of running CodeBuild', async () => {
    const version = reusableReleaseVersion(deployable, config);
    const { run, calls } = attempt(deployable, {
      reuseApplication: true,
      existingReleases: [{ id: 'rel-1', version, status: 'READY', failureReason: null }],
    });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(calls.some((c) => c.startsWith('createRelease'))).toBe(false);
    expect(out.build.imageReused).toBe(true);
    expect(out.build.version).toBe(version);
    expect(() => stageBResultSchema.parse(out)).not.toThrow();
  });

  it('a retry after a failed build takes the next version instead of the name that attempt owns', async () => {
    const version = reusableReleaseVersion(deployable, config);
    const { run, calls } = attempt(deployable, {
      reuseApplication: true,
      existingReleases: [{ id: 'rel-old', version, status: 'FAILED', failureReason: 'BUILD: docker build failed' }],
    });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.build.imageReused).toBe(false);
    expect(out.build.version).toBe(`${version}-r2`);
    expect(calls).toContain(`createRelease ${SHA} ${version}-r2`);
  });

  it('looks the built image up under the tag the pipeline pushes, not the bare version', async () => {
    const { run, calls } = attempt(deployable, { reuseApplication: true });
    const out = await run();
    expect(out.classification).toBe('PASS');
    const version = out.build.version!;
    expect(calls).toContain(`ecrDigestForTag app-1-${version}`);
    expect(calls).not.toContain(`ecrDigestForTag ${version}`);
    expect(out.build.imageDigest).toBe('sha256:deadbeef');
  });

  it('reuses the newest READY release in the family, not only the base name', async () => {
    const version = reusableReleaseVersion(deployable, config);
    const { run, calls } = attempt(deployable, {
      reuseApplication: true,
      existingReleases: [
        { id: 'rel-old', version, status: 'FAILED', failureReason: 'BUILD: docker build failed' },
        { id: 'rel-1', version: `${version}-r2`, status: 'READY', failureReason: null },
      ],
    });
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(out.build.imageReused).toBe(true);
    expect(out.build.version).toBe(`${version}-r2`);
    expect(calls.some((c) => c.startsWith('createRelease'))).toBe(false);
  });

  it('picks the highest attempt when several are READY', () => {
    const ready = (v: string) => ({ version: v, status: 'READY' });
    expect(reusableRelease('v', [ready('v'), ready('v-r3'), ready('v-r2')])?.version).toBe('v-r3');
    expect(reusableRelease('v', [{ version: 'v', status: 'FAILED' }])).toBeUndefined();
    expect(reusableRelease('v', [ready('v-rx'), ready('other')])).toBeUndefined();
  });

  it('keeps taking the next free version as failed attempts pile up', () => {
    const taken = [{ version: 'v' }, { version: 'v-r2' }, { version: 'v-r3' }];
    expect(nextReleaseVersion('v', taken)).toBe('v-r4');
    expect(nextReleaseVersion('v', [])).toBe('v');
    expect(nextReleaseVersion('v', [{ version: 'other' }])).toBe('v');
  });

  it('rebuilds rather than reusing a release that is not READY, or one of another version', async () => {
    const version = reusableReleaseVersion(deployable, config);
    const failed = attempt(deployable, {
      reuseApplication: true,
      existingReleases: [{ id: 'rel-old', version, status: 'FAILED', failureReason: 'BUILD: x' }],
    });
    await failed.run();
    expect(failed.calls.some((c) => c.startsWith(`createRelease ${SHA}`))).toBe(true);

    const other = attempt(deployable, {
      reuseApplication: true,
      existingReleases: [{ id: 'rel-old', version: 'someone-elses-version', status: 'READY', failureReason: null }],
    });
    await other.run();
    expect(other.calls.some((c) => c.startsWith(`createRelease ${SHA}`))).toBe(true);
  });

  it('never reuses without the flag, so a first attempt always builds', async () => {
    const version = reusableReleaseVersion(deployable, config);
    const { run, calls } = attempt(deployable, {
      existingReleases: [{ id: 'rel-1', version, status: 'READY', failureReason: null }],
    });
    const out = await run();
    expect(calls.some((c) => c.startsWith(`createRelease ${SHA}`))).toBe(true);
    expect(out.build.imageReused).toBe(false);
  });

  it('enters the application a previous attempt created instead of creating one', async () => {
    const { run, calls } = attempt(deployable, { reuseApplication: true }, config, 'app-from-attempt-1');
    const out = await run();
    expect(out.classification).toBe('PASS');
    expect(calls).not.toContain('createApplication');
    // The funnel still re-analyses and re-applies the vendor overrides.
    expect(calls).toContain('analyse');
    expect(calls).toContain('patch containerPort,healthPath');
  });
});

describe('cleanup', () => {
  const deployable = TARGETS[0]!;
  const idleApi = () => ({ getDeployment: async () => ({ state: 'HEALTHY', jobs: [{ id: 'j', type: 'INSTALL', state: 'SUCCEEDED' }] }) }) as never;

  it('always runs every stage, records what is left, and marks the ledger complete only on success', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const calls: string[] = [];
    const teardown = {
      async destroyThroughProduct() {
        calls.push('destroy');
      },
      async removeCanaryLeftovers() {
        calls.push('leftovers');
      },
      async leakAudit() {
        calls.push('audit');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(section.status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    expect(stageBRun(evidence).stageB.cleanupCompletedAt).toBeTruthy();
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(false);
  });

  it('waits for an in-flight job before Disconnect, and records when it never settles', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    let reads = 0;
    const api = { getDeployment: async () => ({ state: 'INSTALLING', jobs: [{ id: 'j', type: 'INSTALL', state: reads++ < 2 ? 'RUNNING' : 'FAILED' }] }) } as never;
    const calls: string[] = [];
    const teardown = { destroyThroughProduct: async () => { calls.push('destroy'); }, removeCanaryLeftovers: async () => { calls.push('leftovers'); }, leakAudit: async () => { calls.push('audit'); } };
    const section = await cleanupAttempt({ config: loadConfig({}), api, evidence, teardown, now: Date.now, idleTimeoutMs: 5_000, pollIntervalMs: 1 }, result);
    expect(section.status).toBe('PASS');
    expect(reads).toBeGreaterThanOrEqual(3);
    const stuck = { getDeployment: async () => ({ state: 'INSTALLING', jobs: [{ id: 'j', type: 'INSTALL', state: 'RUNNING' }] }) } as never;
    const { run: run2, evidence: evidence2, result: result2 } = attempt(deployable, {});
    await run2();
    const section2 = await cleanupAttempt({ config: loadConfig({}), api: stuck, evidence: evidence2, teardown, now: Date.now, idleTimeoutMs: 20, pollIntervalMs: 1 }, result2);
    expect(section2.status).toBe('FAIL');
    expect(section2.detail).toContain('idle wait');
    expect(stageBRun(evidence2).stageB.cleanupNeeded).toBe(true);
  });

  it('drops a listed resource that no longer exists (the tagging API lags deletions)', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const teardown = {
      destroyThroughProduct: async () => {},
      removeCanaryLeftovers: async () => {},
      leakAudit: async () => {
        evidence.run.steps.push({ index: 98, name: 'AWS leak audit', scenario: 'x', startedAt: 't', status: 'FAIL', details: { disposableLeft: ['arn:aws:ec2:us-east-1:1:natgateway/nat-1', 'arn:aws:rds:us-east-1:1:db:x'] } });
        throw new Error('2 resource(s) left after teardown');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now, resourceStillExists: async (arn) => !arn.includes('natgateway') }, result);
    expect(section.leaks).toEqual(['arn:aws:rds:us-east-1:1:db:x']);
    expect(section.status).toBe('FAIL');
    const { run: run2, evidence: evidence2, result: result2 } = attempt(deployable, {});
    await run2();
    const gone = { ...teardown, leakAudit: async () => { evidence2.run.steps.push({ index: 98, name: 'AWS leak audit', scenario: 'x', startedAt: 't', status: 'FAIL', details: { disposableLeft: ['arn:aws:ec2:us-east-1:1:natgateway/nat-1'] } }); throw new Error('1 resource(s) left'); } };
    const section2 = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: evidence2, teardown: gone, now: Date.now, resourceStillExists: async () => false }, result2);
    expect(section2.status).toBe('PASS');
    expect(section2.leaks).toEqual([]);
    expect(stageBRun(evidence2).stageB.cleanupNeeded).toBe(false);
  });

  it('keeps going after a failed destroy, skips the leftovers, reports the leak, and turns a PASS into CLEANUP_LEAK', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const calls: string[] = [];
    const teardown = {
      async destroyThroughProduct() {
        calls.push('destroy');
        throw new Error('destroy ended in FAILED');
      },
      async removeCanaryLeftovers() {
        calls.push('leftovers');
      },
      async leakAudit() {
        calls.push('audit');
        evidence.run.steps.push({ index: 99, name: 'AWS leak audit', scenario: 'x', startedAt: 't', status: 'FAIL', details: { disposableLeft: ['rds db-1'] } });
        throw new Error('1 resource(s) left after teardown');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(section.status).toBe('FAIL');
    expect(section.leaks).toEqual(['rds db-1']);
    // The connector is never removed while destroy/purge did not complete.
    expect(calls).toEqual(['destroy', 'audit']);
    expect(section.bootstrapStackFinal).toBe('SKIPPED: purge not complete');
    expect(stageBRun(evidence).stageB.cleanupNeeded).toBe(true);
    applyCleanupToClassification(result);
    expect(result.classification).toBe('CLEANUP_LEAK');
    expect(result.failureStage).toBe('CLEANUP_LEAK');
    // A later cleanup that completes restores the funnel's own verdict.
    result.cleanup = { ...result.cleanup, status: 'PASS', leaks: [], detail: null };
    applyCleanupToClassification(result);
    expect(result.classification).toBe('PASS');
    expect(result.failureStage).toBeNull();
  });

  it('still removes the connector after a failed destroy/purge when no installationId was ever recorded (DEPLOY-023)', async () => {
    // The bootstrap stack rolled back: the relay never enrolled, no
    // installation id was ever assigned, so there is nothing retained for
    // Purge to reach. destroyThroughProduct fails its dead wait on the
    // relay, but that must not strand this connector forever.
    const { run, evidence, result } = attempt(deployable, { bootstrapStatus: 'ROLLBACK_COMPLETE' });
    await run();
    expect(stageBRun(evidence).deploymentId).toBeTruthy();
    expect(stageBRun(evidence).installationId).toBeFalsy();
    const calls: string[] = [];
    const teardown = {
      async destroyThroughProduct() {
        calls.push('destroy');
        throw new Error('purge left cleanupState null: relay never enrolled');
      },
      async removeCanaryLeftovers() {
        calls.push('leftovers');
      },
      async leakAudit() {
        calls.push('audit');
      },
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    expect(section.bootstrapStackFinal).not.toBe('SKIPPED: purge not complete');
  });

  it('maps the retained-state verification steps to PASS/FAIL/SKIPPED', async () => {
    const { run, evidence, result } = attempt(deployable, {});
    await run();
    const teardown = {
      destroyThroughProduct: async () => {
        evidence.run.steps.push({ index: 50, name: 'Verify retained state between Disconnect and Purge', scenario: 'x', startedAt: 't', status: 'PASS', details: {} });
        evidence.run.steps.push({ index: 51, name: 'Verify the retained set is gone after Purge', scenario: 'x', startedAt: 't', status: 'FAIL', details: {} });
      },
      removeCanaryLeftovers: async () => {},
      leakAudit: async () => {},
    };
    const section = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence, teardown, now: Date.now }, result);
    expect(section.retainedState).toBe('PASS');
    expect(section.purgedState).toBe('FAIL');

    const { run: run2, evidence: evidence2, result: result2 } = attempt(deployable, {});
    await run2();
    const skipped = {
      destroyThroughProduct: async () => {
        evidence2.run.steps.push({ index: 50, name: 'Verify retained state between Disconnect and Purge', scenario: 'x', startedAt: 't', status: 'PASS', details: { skipped: 'no installation recorded' } });
      },
      removeCanaryLeftovers: async () => {},
      leakAudit: async () => {},
    };
    const section2 = await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: evidence2, teardown: skipped, now: Date.now }, result2);
    expect(section2.retainedState).toBe('SKIPPED');
    // Never ran at all — this teardown fake never pushed the step.
    expect(section2.purgedState).toBe('NOT_ATTEMPTED');
  });

  it('still removes a built image when the funnel stopped before the deployment existed', async () => {
    const { run, evidence, result } = attempt(deployable, { createDeploymentError: { status: 422, code: 'MANIFEST_NEEDS_CONFIGURATION', message: 'needs APP_KEY' } });
    await run();
    expect(stageBRun(evidence).releases['release']?.imageDigest).toBe('sha256:deadbeef');
    const calls: string[] = [];
    const section = await cleanupAttempt(
      {
        config: loadConfig({}),
        api: idleApi(),
        evidence,
        teardown: {
          destroyThroughProduct: async () => {
            calls.push('destroy');
          },
          removeCanaryLeftovers: async () => {
            calls.push('leftovers');
          },
          leakAudit: async () => {
            calls.push('audit');
          },
        },
        now: Date.now,
      },
      result,
    );
    expect(section.status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
  });

  it('cleans a release whose build the ledger never saw finish, and needs no cleanup when nothing was created', async () => {
    const built = attempt(deployable, { releaseStatus: 'FAILED', releaseFailure: 'x' });
    await built.run();
    const calls: string[] = [];
    const teardown = { destroyThroughProduct: async () => { calls.push('destroy'); }, removeCanaryLeftovers: async () => { calls.push('leftovers'); }, leakAudit: async () => { calls.push('audit'); } };
    expect((await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: built.evidence, teardown, now: Date.now }, built.result)).status).toBe('PASS');
    expect(calls).toEqual(['destroy', 'leftovers', 'audit']);
    const nothing = attempt(deployable, { preflight: { state: 'NOT_COMPATIBLE', ready: false, blockers: [{ id: 'unsupported', message: 'x' }], warnings: [] } });
    await nothing.run();
    expect((await cleanupAttempt({ config: loadConfig({}), api: idleApi(), evidence: nothing.evidence, teardown, now: Date.now }, nothing.result)).status).toBe('NOT_REQUIRED');
  });

  it('stops the wave after a failed cleanup', () => {
    const result = emptyResult(identityFor(deployable, SHA, 'deploy', 'r'));
    expect(shouldStopWave(result)).toBe(false);
    result.cleanup.status = 'FAIL';
    expect(shouldStopWave(result)).toBe(true);
  });

  it('lists only the ledgers whose cleanup did not complete, so a resume finishes them first', async () => {
    const dir = join(tmp, 'ledgers');
    const config = loadConfig({});
    const done = openLedger(dir, config, { repoId: 'repo-001', repository: 'a/b', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-001-done');
    stageBRun(done).stageB.cleanupCompletedAt = 'now';
    done.save();
    const pending = openLedger(dir, config, { repoId: 'repo-002', repository: 'a/c', commit: SHA, deployzCommit: SHA, cleanupNeeded: true }, 'stage-b-repo-002-pending');
    pending.save();
    const untouched = openLedger(dir, config, { repoId: 'repo-003', repository: 'a/d', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-003-untouched');
    untouched.finish('FAIL');
    // Interrupted before any result, but a release had been created: still ours to clean.
    const interrupted = openLedger(dir, config, { repoId: 'repo-004', repository: 'a/e', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-004-interrupted');
    interrupted.run.releases['release'] = { id: 'r', version: 'repo-004-x', gitSha: SHA };
    interrupted.save();
    const nothing = openLedger(dir, config, { repoId: 'repo-005', repository: 'a/f', commit: SHA, deployzCommit: SHA, cleanupNeeded: false }, 'stage-b-repo-005-nothing');
    nothing.save();
    expect(listUnfinishedLedgers(dir).map((l) => l.runId)).toEqual(['stage-b-repo-002-pending', 'stage-b-repo-003-untouched', 'stage-b-repo-004-interrupted']);
    expect(readdirSync(dir).length).toBe(5);
  });

  it('keeps the vendor session per series', () => {
    const dir = join(tmp, 'series');
    expect(readSeries(dir)).toEqual({});
    writeSeries(dir, { vendor: { email: 'v@example.com', password: 'p' } });
    expect(readSeries(dir).vendor?.email).toBe('v@example.com');
    expect(existsSync(join(dir, 'series.json'))).toBe(true);
  });
});

describe('findings registry', () => {
  it('uses stable DEPLOY-nnn ids and the documented resolutions', () => {
    const doc = readFileSync(join(STAGE_B_DIR, 'findings.md'), 'utf8');
    const ids = [...new Set([...doc.matchAll(/^\| (DEPLOY-\d{3}) \|/gm)].map((m) => m[1]!))].sort();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(doc).toMatch(new RegExp(`^## ${id} — `, 'm'));
  });
});
