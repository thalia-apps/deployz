// Selector tests for scripts/test-affected.mjs — run with:
//   node --test scripts/test-affected.test.mjs   (or: pnpm test:selector)
// Node's built-in runner keeps this out of the root Vitest project list.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  VERIFIED_PATHS,
  collectChangedFiles,
  commandsFor,
  loadWorkspaceGraph,
  parseArgs,
  planFromFiles,
} from './test-affected.mjs';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const graph = loadWorkspaceGraph(REPO_ROOT);
const plan = (files, options = {}) => planFromFiles(files, { graph, ...options });
const rendered = (p) => commandsFor(p).map(c => `${c.cmd} ${c.args.join(' ')}`);

test('1. documentation-only change selects the minimal gate', () => {
  const p = plan(['README.md', 'docs/testing/strategy.md', 'AGENTS.md']);
  assert.equal(p.risk, 'minimal');
  assert.equal(p.playwright, 'none');
  assert.deepEqual(commandsFor(p), []);
});

test('2. web runtime change runs web units and the fixture-mode Playwright suite, not the scenario suite', () => {
  for (const f of ['apps/web/src/app/dashboard/customers/page.tsx', 'apps/web/src/components/ui/button.tsx', 'apps/web/src/lib/deployment-vocabulary.ts', 'apps/web/src/lib/api-client.ts']) {
    const p = plan([f]);
    assert.equal(p.risk, 'targeted', f);
    assert.deepEqual(p.unitProjects, ['@deployz/web'], f);
    assert.equal(p.playwright, 'fixture', f);
    const cmds = rendered(p);
    assert.ok(cmds.some(c => c.includes('--grep-invert @scenario|visual')), f);
    assert.ok(cmds.some(c => c.includes('e2e/scenario-ui.spec.ts e2e/scenario-release-unavailable.spec.ts')), f);
    assert.ok(!cmds.some(c => c.includes('--scenarios')), f);
  }
});

test('2b. web test-only, asset and brand changes stay unit-only', () => {
  for (const f of ['apps/web/test/home-state.test.ts', 'apps/web/public/logo.svg', 'apps/web/src/components/deployz-brand.tsx']) {
    const p = plan([f]);
    assert.equal(p.risk, 'targeted', f);
    assert.deepEqual(p.unitProjects, ['@deployz/web'], f);
    assert.equal(p.playwright, 'none', f);
  }
});

test('3. allowlisted API areas stay targeted, with every dependent project and the fixture suite', () => {
  for (const f of ['apps/api/src/billing-portal.ts', 'apps/api/src/admin/routes.ts', 'apps/api/src/organizations.ts', 'apps/api/src/ai-config.ts']) {
    const p = plan([f]);
    assert.equal(p.risk, 'targeted', f);
    assert.ok(p.unitProjects.includes('@deployz/api'), f);
    assert.ok(p.unitProjects.includes('@deployz/cdk'), `${f}: the worker Lambda imports the API`);
    assert.equal(p.playwright, 'fixture', f);
    assert.equal(p.typecheckScripts, true, `${f}: the harnesses import the API`);
  }
  const testOnly = plan(['apps/api/src/server.test.ts']);
  assert.equal(testOnly.risk, 'targeted');
  assert.equal(testOnly.playwright, 'none');
});

test('4. every other API source file is critical', () => {
  for (const f of ['apps/api/src/server.ts', 'apps/api/src/config.ts', 'apps/api/src/failure-classification.ts', 'apps/api/src/deployment-status.ts', 'apps/api/src/pending-secrets.ts', 'apps/api/src/github.ts']) {
    const p = plan([f]);
    assert.equal(p.risk, 'critical', f);
    assert.equal(p.playwright, 'full', f);
    assert.equal(p.unitProjects, 'ALL', f);
  }
});

test('5. shared packages fan out to every transitive dependent', () => {
  const analysis = plan(['packages/analysis/src/index.ts']);
  assert.equal(analysis.risk, 'targeted');
  for (const pkg of ['@deployz/analysis', '@deployz/api', '@deployz/cdk']) assert.ok(analysis.unitProjects.includes(pkg), pkg);
  assert.equal(analysis.playwright, 'fixture');

  const copyMap = plan(['packages/copy-map/src/index.ts']);
  for (const pkg of ['@deployz/copy-map', '@deployz/web', '@deployz/api', '@deployz/cdk']) assert.ok(copyMap.unitProjects.includes(pkg), pkg);
  assert.equal(copyMap.playwright, 'fixture');

  const dbClient = plan(['packages/db/src/client.ts']);
  assert.equal(dbClient.risk, 'targeted');
  for (const pkg of ['@deployz/db', '@deployz/api', '@deployz/analysis', '@deployz/cdk']) assert.ok(dbClient.unitProjects.includes(pkg), pkg);
  assert.equal(dbClient.typecheckScripts, true);
});

test('5b. the workspace graph has no dependent the manifests do not name', () => {
  for (const [name, list] of Object.entries(graph.deps)) {
    for (const dep of list) {
      assert.ok(dep in graph.dependents, `${name} depends on ${dep}, which is not a workspace package`);
    }
  }
  assert.ok(graph.dependents['@deployz/api'].has('@deployz/cdk'));
  assert.ok(graph.dependents['@deployz/contracts'].has('@deployz/web'));
});

test('6. contracts, relay, DB schema, migrations and CDK source are critical', () => {
  for (const f of ['packages/contracts/src/tags.ts', 'packages/contracts/src/plan.ts', 'packages/relay/src/config-update.ts', 'packages/relay/src/index.ts', 'packages/db/src/schema/deployments.ts', 'packages/db/src/schema/billing.ts', 'packages/db/drizzle/0040_next.sql', 'packages/cdk/src/deployz-stack.ts', 'packages/cdk/src/lambda/worker.ts', 'packages/cdk/artifacts/bootstrap-template-v1.json']) {
    assert.equal(plan([f]).risk, 'critical', f);
  }
  for (const f of ['packages/contracts/src/plan.test.ts', 'packages/relay/src/deploy.test.ts', 'packages/cdk/test/worker.test.ts', 'packages/db/src/constraints.test.ts', 'packages/cdk/scripts/audit-deployment.mjs', 'packages/cdk/scripts/bundle-smoke.mjs']) {
    assert.equal(plan([f]).risk, 'targeted', f);
  }
  for (const f of ['packages/cdk/scripts/synth-bootstrap.mjs', 'packages/cdk/scripts/publish-bootstrap.mjs']) {
    assert.equal(plan([f]).risk, 'critical', f);
  }
});

test('7. real-AWS escalations name the version canary, never the retired read-only canary', () => {
  const executor = plan(['packages/relay/src/deploy.ts']);
  assert.ok(executor.awsEscalation.some(c => c.endsWith('pnpm e2e:canary:versions core')));
  const relayOther = plan(['packages/relay/src/auth.ts']);
  assert.ok(relayOther.awsEscalation.some(c => c.includes('profile --profile stateless')));
  const bootstrap = plan(['packages/cdk/src/bootstrap/bootstrap-stack.ts']);
  assert.ok(bootstrap.awsEscalation.some(c => c.endsWith('pnpm e2e:fresh')));
  assert.ok(bootstrap.awsEscalation.some(c => c.includes('profile --profile stateless')));
  assert.equal(plan(['packages/cdk/src/deployz-stack.ts']).awsEscalation.length, 0);
  for (const p of [executor, relayOther, bootstrap]) {
    for (const c of p.awsEscalation) assert.ok(!/e2e:canary( |$)/.test(c), `retired command: ${c}`);
    for (const c of rendered(p)) assert.ok(!c.includes('DEPLOYZ_E2E_ALLOW_REAL_AWS') && !c.includes('canary:versions') && !c.includes('e2e:fresh'), `AWS command leaked into execution: ${c}`);
  }
});

test('8. the fixture application is not deployment-critical', () => {
  const p = plan(['packages/fixture/src/server.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.unitProjects, ['@deployz/fixture']);
  assert.equal(p.playwright, 'none');
  assert.ok(p.awsEscalation.some(c => c.includes('canary:fixture-repo')));
});

test('9. root configuration, workflows and the e2e tsconfig fall back to the full regression', () => {
  for (const f of ['pnpm-lock.yaml', 'package.json', 'turbo.json', 'vitest.config.ts', 'playwright.config.ts', 'pnpm-workspace.yaml', '.github/workflows/ci.yml', 'scripts/e2e.mjs', 'e2e/tsconfig.json']) {
    const p = plan([f]);
    assert.equal(p.risk, 'critical', f);
    assert.ok(p.reasons.some(r => r.includes('root configuration')), f);
  }
});

test('10. unknown executable paths select the full regression, never zero tests', () => {
  for (const f of ['tools/new-thing.ts', 'apps/mobile/src/index.ts', 'scripts/new-harness/index.ts', 'e2e/helpers.ts']) {
    const p = plan([f]);
    assert.equal(p.risk, 'critical', f);
    assert.ok(commandsFor(p).length > 0, f);
  }
});

test('11. failed change detection engages the fail-safe', () => {
  const p = plan(null);
  assert.equal(p.risk, 'critical');
  assert.equal(p.fallback, true);
  assert.ok(p.fallbackReasons.some(r => r.includes('change detection failed')));
});

test('12. an edited spec runs on its own; an edited scenario spec on top of the fixture suite', () => {
  const spec = plan(['e2e/customers.spec.ts']);
  assert.equal(spec.risk, 'targeted');
  assert.equal(spec.playwright, 'files');
  assert.deepEqual(spec.playwrightFiles, ['e2e/customers.spec.ts']);

  const mixed = plan(['e2e/scenario-lifecycle.spec.ts', 'e2e/customers.spec.ts', 'apps/web/src/lib/customers.ts']);
  assert.equal(mixed.playwright, 'fixture');
  assert.deepEqual(mixed.playwrightFiles, ['e2e/scenario-lifecycle.spec.ts']);
  assert.ok(rendered(mixed).some(c => c.includes('e2e/scenario-release-unavailable.spec.ts e2e/scenario-lifecycle.spec.ts')));

  assert.equal(plan(['e2e/visual.spec.ts']).playwright, 'none');
  assert.equal(plan(['e2e/simulation/simulated-account.ts']).risk, 'critical');

  // The default-HTTPS spec needs its fixture flag, on its own server.
  const https = commandsFor(plan(['e2e/scenario-default-https.spec.ts', 'e2e/home.spec.ts']));
  assert.ok(https.some(c => c.env?.DEPLOYZ_DEFAULT_HTTPS_FIXTURE === 'true' && c.args.includes('e2e/scenario-default-https.spec.ts')));
  assert.ok(https.some(c => c.args.includes('e2e/home.spec.ts') && !c.args.includes('e2e/scenario-default-https.spec.ts')));
});

test('12b. the Stage B configuration and registry are harness test data, not docs; DB enums are schema', () => {
  const stageB = plan(['docs/testing/repository-deployment/findings.md']);
  assert.equal(stageB.risk, 'targeted');
  assert.deepEqual(stageB.unitProjects, ['repository-deployment']);
  assert.equal(plan(['apps/api/src/fix-instructions.ts']).unitProjects, 'ALL');
  assert.equal(plan(['packages/db/src/enums.ts']).risk, 'critical');
});

test('13. harness changes run their own project and the harness typecheck', () => {
  const p = plan(['scripts/version-canary/steps.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.unitProjects, ['version-canary']);
  assert.equal(p.typecheckScripts, true);
  assert.deepEqual(plan(['scripts/run-and-check/src/analysis/session.ts']).unitProjects, ['repository-deployment', 'run-and-check']);
  const reset = plan(['scripts/customer-reset/safety.ts']);
  assert.equal(reset.risk, 'targeted');
  assert.equal(reset.typecheckScripts, true);
});

test('14. --full forces the full regression on any change', () => {
  const p = plan(['docs/testing/ci.md'], { full: true });
  assert.equal(p.risk, 'critical');
  assert.ok(p.reasons.some(r => r.includes('ci:full')));
  assert.equal(parseArgs(['--full']).full, true);
});

test('15. the full regression runs every layer including the bundling smoke and the e2e typecheck', () => {
  const cmds = rendered(plan(['apps/api/src/server.ts']));
  for (const expected of ['pnpm test:static', 'pnpm typecheck:e2e', 'pnpm vitest run', 'pnpm typecheck:scripts', 'pnpm synth:smoke', '--grep-invert @scenario|visual', '--scenarios', 'e2e/scenario-default-https.spec.ts']) {
    assert.ok(cmds.some(c => c.includes(expected)), expected);
  }
});

test('16. every non-minimal plan executes at least one test layer', () => {
  for (const files of [['apps/web/src/lib/utils.ts'], ['apps/api/src/email.ts'], ['packages/db/src/client.ts'], ['scripts/customer-reset/safety.ts'], ['e2e/home.spec.ts']]) {
    const p = plan(files);
    assert.notEqual(p.risk, 'minimal', files.join());
    assert.ok(commandsFor(p).some(c => /vitest|e2e\.mjs|typecheck/.test(`${c.cmd} ${c.args.join(' ')}`)), files.join());
  }
});

test('17. every path the rules name exists on disk', () => {
  for (const p of VERIFIED_PATHS) {
    assert.ok(existsSync(path.join(REPO_ROOT, p)), `rule names a missing path: ${p}`);
  }
});

test('18. Windows-style paths are normalised', () => {
  const p = plan(['apps\\web\\src\\lib\\utils.ts']);
  assert.equal(p.risk, 'targeted');
  assert.deepEqual(p.unitProjects, ['@deployz/web']);
});

test('19. --github-output is refused without GITHUB_OUTPUT and publishes the plan keys with it', () => {
  const script = path.join(REPO_ROOT, 'scripts', 'test-affected.mjs');
  const refused = spawnSync(process.execPath, [script, '--files=docs/x.md', '--github-output'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' }, cwd: REPO_ROOT,
  });
  assert.notEqual(refused.status, 0);
  assert.ok(refused.stderr.includes('GITHUB_OUTPUT'));

  const outFile = path.join(os.tmpdir(), `test-affected-${process.pid}.txt`);
  writeFileSync(outFile, '');
  const ok = spawnSync(process.execPath, [script, '--files=apps/web/src/lib/utils.ts', '--github-output', '--format=json'], {
    encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outFile }, cwd: REPO_ROOT,
  });
  assert.equal(ok.status, 0, ok.stderr);
  const out = readFileSync(outFile, 'utf8');
  for (const key of ['risk=targeted', 'unit_projects=@deployz/web', 'lint_packages=@deployz/web', 'playwright=fixture', 'typecheck_scripts=false']) {
    assert.ok(out.includes(key), `${key} missing from:\n${out}`);
  }
  appendFileSync(outFile, '');
});

test('20. change detection against a real base ref works from this checkout', () => {
  const r = collectChangedFiles(REPO_ROOT, 'HEAD');
  assert.ok(Array.isArray(r.files), r.error);
});
