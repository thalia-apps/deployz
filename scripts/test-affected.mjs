#!/usr/bin/env node
// Risk-based affected-test selector (docs/testing/ci.md). Maps the changed
// files of a pull request to one risk level and the test layers CI runs:
//
//   minimal   documentation only — nothing executes
//   targeted  the affected Vitest projects (with every workspace dependent),
//             typechecks, and either the explicitly touched Playwright specs
//             or the whole fixture-mode Playwright suite
//   critical  the full regression: every Vitest project, every non-visual
//             Playwright spec, every simulated scenario, the default-HTTPS
//             scenarios and the CDK bundling smoke
//
// Deployment-shaping code (apps/api, packages/relay, packages/contracts,
// packages/cdk, the DB schema and migrations, the simulation harness) is
// critical by default; a short allowlist names the API areas that are not.
// Workspace dependents are derived from the package manifests, never listed
// by hand. Fail-safe: an unknown path, a root configuration change or a
// failed change detection selects the full regression — never zero tests.
// Real AWS never runs from here: the AWS commands are printed as escalations.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// ── Rules ────────────────────────────────────────────────────────────────────

// Root files whose change falls back to the full regression.
const ROOT_CONFIG = [
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^turbo\.json$/,
  /^vitest\.config\.ts$/,
  /^playwright\.config\.ts$/,
  /^tsconfig\.base\.json$/,
  /^eslint\.config\.mjs$/,
  /^\.github\/workflows\//,
  /^scripts\/e2e\.mjs$/,
  /^scripts\/e2e-env\.mjs$/,
  /^scripts\/test-affected\.mjs$/,
  /^scripts\/test-affected\.test\.mjs$/,
  /^scripts\/production-safety\.test\.mjs$/,
  /^scripts\/e2e-modes\.test\.mjs$/,
  /^e2e\/tsconfig\.json$/,
  /^\.env/,
];

// Documentation and non-executable text → minimal gate.
const DOC_FILE = [
  /^docs\//,
  /\.md$/i,
  /\.txt$/,
  /\.png$/,
  /^LICENSE$/,
  /^\.gitignore$/,
  /^\.gitattributes$/,
  /^\.editorconfig$/,
];

// apps/web paths that no Playwright spec renders: unit tests only.
const WEB_NO_E2E = [
  /^apps\/web\/test\//,
  /^apps\/web\/public\//,
  /^apps\/web\/src\/components\/deployz-brand\.tsx$/,
  /^apps\/web\/src\/app\/(icon|apple-icon|favicon)\./,
];

// apps/api/src areas that do not shape a customer deployment. A change here
// runs the API project (with its dependents) and the fixture-mode Playwright
// suite instead of the full regression. Everything else under apps/api/src
// is critical. Each entry is verified to exist by the selector self-test.
const API_NON_CRITICAL = [
  /^apps\/api\/src\/admin\//,
  /^apps\/api\/src\/billing-[a-z-]+\.ts$/,
  /^apps\/api\/src\/paddle\.ts$/,
  /^apps\/api\/src\/email\.ts$/,
  /^apps\/api\/src\/organizations\.ts$/,
  /^apps\/api\/src\/ai-[a-z-]+\.ts$/,
  /^apps\/api\/src\/jev-shadow\.ts$/,
  /^apps\/api\/src\/sentry\.ts$/,
  /^apps\/api\/src\/customer-activity\.ts$/,
];

// packages/cdk paths whose change also needs a real-AWS run before the
// template is republished (the two "every install failed" outages).
const CDK_CUSTOMER_SIDE = [
  /^packages\/cdk\/src\/bootstrap\//,
  /^packages\/cdk\/src\/application\//,
  /^packages\/cdk\/src\/quick-create\//,
  /^packages\/cdk\/src\/lambda\/relay-handler\.ts$/,
  /^packages\/cdk\/bin\//,
  /^packages\/cdk\/artifacts\//,
];

// Relay executors that talk to the customer's AWS account.
const RELAY_AWS_INTERFACE = new Set([
  'verify.ts', 'install.ts', 'stack-events.ts', 'ecs-health.ts', 'ecs-observe.ts',
  'deploy.ts', 'destroy.ts', 'purge.ts', 'domain.ts', 'config-update.ts', 'recover.ts',
]);

// scripts/<dir> Vitest projects (root vitest.config.ts) — the project name is
// the directory name.
const SCRIPT_PROJECTS = ['version-canary', 'repository-deployment', 'run-and-check'];

const CANARY_STATELESS = 'pnpm e2e:canary:versions profile --profile stateless';
const CANARY_CORE = 'pnpm e2e:canary:versions core';
// Sizing code (docs/infrastructure-profiles.md): one non-default size plus the
// vendor → link → customer journey.
const SIZING_CODE = /^(packages\/contracts\/src\/(profile|pricing)\.ts|apps\/api\/src\/deployment-size\.ts)$/;
const CANARY_SIZE = 'pnpm e2e:canary:versions profile --profile stateless --size medium';
const CANARY_JOURNEY = 'pnpm e2e:canary:versions journey --size small';
const FRESH = 'pnpm e2e:fresh';

// Verified by the selector self-test: every listed path must exist.
export const VERIFIED_PATHS = [
  'apps/web/src/components/deployz-brand.tsx',
  'apps/api/src/admin',
  'apps/api/src/paddle.ts',
  'apps/api/src/email.ts',
  'apps/api/src/organizations.ts',
  'apps/api/src/jev-shadow.ts',
  'apps/api/src/sentry.ts',
  'apps/api/src/customer-activity.ts',
  'apps/api/src/deployment-size.ts',
  'packages/contracts/src/profile.ts',
  'packages/contracts/src/pricing.ts',
  'packages/cdk/src/bootstrap',
  'packages/cdk/src/quick-create',
  'packages/cdk/src/lambda/relay-handler.ts',
  'packages/cdk/bin',
  'packages/cdk/artifacts',
  ...[...RELAY_AWS_INTERFACE].map(f => `packages/relay/src/${f}`),
  ...SCRIPT_PROJECTS.map(d => `scripts/${d}/vitest.config.ts`),
];

// ── Workspace graph ──────────────────────────────────────────────────────────

function toForwardSlash(p) { return p.replace(/\\/g, '/'); }

// Reads apps/* and packages/* manifests: directory → package name, and the
// transitive reverse dependency closure over @deployz/* packages. Also which
// packages the root devDependencies (the scripts/ harnesses) import.
export function loadWorkspaceGraph(cwd = process.cwd()) {
  const dirToName = {};
  const deps = {};
  for (const group of ['apps', 'packages']) {
    const groupDir = join(cwd, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const manifest = join(groupDir, entry, 'package.json');
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      dirToName[`${group}/${entry}`] = pkg.name;
      deps[pkg.name] = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter(d => d.startsWith('@deployz/'));
    }
  }
  const dependents = {};
  for (const name of Object.keys(deps)) dependents[name] = new Set();
  for (const [name, list] of Object.entries(deps)) {
    for (const dep of list) dependents[dep]?.add(name);
  }
  const rootManifest = join(cwd, 'package.json');
  const rootDeps = existsSync(rootManifest)
    ? Object.keys(JSON.parse(readFileSync(rootManifest, 'utf8')).devDependencies ?? {}).filter(d => d.startsWith('@deployz/'))
    : [];
  return { dirToName, deps, dependents, rootDeps: new Set(rootDeps) };
}

function transitiveDependents(graph, name) {
  const out = new Set();
  const stack = [name];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const d of graph.dependents[current] ?? []) {
      if (!out.has(d)) {
        out.add(d);
        stack.push(d);
      }
    }
  }
  return out;
}

// ── Change collection ────────────────────────────────────────────────────────

function git(args, opts = {}) {
  const r = spawnSync('git', args, { cwd: opts.cwd ?? process.cwd(), encoding: 'utf8', ...opts });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || `exit ${r.status}`}`);
  return r.stdout.trim().split('\n').filter(Boolean);
}

// Returns { files } on success or { error } — callers turn error into the
// full-regression fallback instead of silently diffing against the wrong base.
export function collectChangedFiles(cwd, baseRef) {
  try {
    const ref = baseRef ?? 'origin/main';
    const base = git(['merge-base', 'HEAD', ref], { cwd })[0];
    if (!base) return { error: `no merge-base with ${ref}` };
    const committed = git(['diff', '--name-only', `${base}...HEAD`], { cwd });
    const unstaged = git(['diff', '--name-only'], { cwd });
    const staged = git(['diff', '--name-only', '--cached'], { cwd });
    const all = [...new Set([...committed, ...unstaged, ...staged])].filter(Boolean);
    return { files: all.map(toForwardSlash) };
  } catch (e) {
    return { error: e.message };
  }
}

// ── Classification ───────────────────────────────────────────────────────────

function classify(f, layers, graph) {
  const base = f.split('/').pop();
  const isTest = /\.test\.[tjm]sx?$/.test(base);
  const critical = (reason) => layers.criticalReasons.push(`${reason}: ${f}`);
  const pkgDir = /^((?:apps|packages)\/[^/]+)\//.exec(f)?.[1];
  const pkgName = pkgDir ? graph.dirToName[pkgDir] : undefined;

  if (ROOT_CONFIG.some(p => p.test(f))) {
    critical('root configuration changed (full regression)');
    return;
  }

  if (pkgDir && !pkgName) {
    critical('unknown workspace package (full regression)');
    return;
  }

  if (pkgName) {
    layers.changedPackages.add(pkgName);
    layers.unitProjects.add(pkgName);
    for (const d of transitiveDependents(graph, pkgName)) layers.unitProjects.add(d);
    if (graph.rootDeps.has(pkgName) || [...transitiveDependents(graph, pkgName)].some(d => graph.rootDeps.has(d))) {
      layers.typecheckScripts = true;
    }
  }

  switch (pkgDir) {
    case 'apps/web': {
      if (!WEB_NO_E2E.some(p => p.test(f))) layers.fixtureSuite = true;
      return;
    }
    case 'apps/api': {
      if (isTest) return;
      if (!f.startsWith('apps/api/src/')) return;
      if (SIZING_CODE.test(f)) layers.awsEscalation.add(CANARY_SIZE).add(CANARY_JOURNEY);
      if (API_NON_CRITICAL.some(p => p.test(f))) {
        layers.fixtureSuite = true;
        return;
      }
      critical('API deployment-shaping code changed');
      return;
    }
    case 'packages/relay': {
      if (isTest) return;
      if (RELAY_AWS_INTERFACE.has(base)) {
        layers.awsEscalation.add(CANARY_CORE);
      } else {
        layers.awsEscalation.add(CANARY_STATELESS);
      }
      critical('relay code (runs in the customer account) changed');
      return;
    }
    case 'packages/contracts': {
      if (isTest) return;
      if (SIZING_CODE.test(f)) layers.awsEscalation.add(CANARY_SIZE).add(CANARY_JOURNEY);
      critical('shared deployment contract changed');
      return;
    }
    case 'packages/db': {
      if (isTest) return;
      if (f.startsWith('packages/db/drizzle/') || f.startsWith('packages/db/src/schema/') || f === 'packages/db/src/enums.ts') {
        critical('database schema or migration changed');
      }
      return;
    }
    case 'packages/cdk': {
      if (isTest || f.startsWith('packages/cdk/test/')) return;
      // The synth and publish scripts write the committed templates and the
      // regional relay assets; only the read-only audit and the bundling
      // smoke are exempt.
      if (/^packages\/cdk\/scripts\/(audit-deployment|bundle-smoke)\.mjs$/.test(f)) return;
      if (CDK_CUSTOMER_SIDE.some(p => p.test(f))) {
        layers.awsEscalation.add(CANARY_STATELESS);
        if (/^packages\/cdk\/(src\/bootstrap\/|bin\/bootstrap|artifacts\/bootstrap)/.test(f)) layers.awsEscalation.add(FRESH);
      }
      critical('infrastructure code changed (deploys or publishes on merge)');
      return;
    }
    case 'packages/analysis':
    case 'packages/copy-map': {
      if (!isTest) layers.fixtureSuite = true;
      return;
    }
    case 'packages/fixture': {
      if (!isTest) layers.awsEscalation.add(`pnpm canary:fixture-repo && ${CANARY_STATELESS}`);
      return;
    }
    default:
      break;
  }

  const script = /^scripts\/([^/]+)\//.exec(f)?.[1];
  if (script) {
    layers.typecheckScripts = true;
    if (SCRIPT_PROJECTS.includes(script)) {
      layers.unitProjects.add(script);
      // Stage B imports the analysis session and the recipe contract of run-and-check.
      if (script === 'run-and-check') layers.unitProjects.add('repository-deployment');
      return;
    }
    if (script === 'customer-reset') return;
    critical('unknown scripts directory (full regression)');
    return;
  }

  if (f.startsWith('e2e/')) {
    if (f.startsWith('e2e/simulation/') || f === 'e2e/seed-ready-manifest.ts') {
      critical('simulation harness changed (backs every scenario)');
      return;
    }
    if (/^e2e\/[^/]+\.spec\.ts$/.test(f)) {
      if (f !== 'e2e/visual.spec.ts') layers.specFiles.add(f);
      return;
    }
    if (/^e2e\/visual\.spec\.ts-snapshots\//.test(f)) return;
    critical('unknown e2e path (full regression)');
    return;
  }

  critical('unknown executable path (full regression)');
}

// ── Plan assembly ────────────────────────────────────────────────────────────

// files === null means change detection failed → full regression.
export function planFromFiles(files, options = {}) {
  const graph = options.graph ?? loadWorkspaceGraph(options.cwd);
  const layers = {
    changedPackages: new Set(),
    unitProjects: new Set(),
    specFiles: new Set(),
    fixtureSuite: false,
    typecheckScripts: false,
    awsEscalation: new Set(),
    criticalReasons: [],
    fallbackReasons: [],
  };

  if (options.full) layers.criticalReasons.push('full regression requested (ci:full)');

  if (files === null) {
    layers.fallbackReasons.push('change detection failed');
    return finalize(layers, 0);
  }

  const list = files.map(toForwardSlash);
  let docOnly = true;
  for (const f of list) {
    // The Stage B configuration and finding registry under docs/testing are
    // read by the harness tests, so they are test data, not documentation.
    if (/^docs\/testing\/repository-deployment\//.test(f)) {
      docOnly = false;
      layers.unitProjects.add('repository-deployment');
      layers.typecheckScripts = true;
      continue;
    }
    if (DOC_FILE.some(p => p.test(f))) continue;
    docOnly = false;
    classify(f, layers, graph);
  }
  if (docOnly && !options.full) {
    layers.minimalReason = list.length === 0 ? 'no changed files detected' : 'documentation-only change';
  }
  return finalize(layers, list.length);
}

function finalize(layers, fileCount) {
  const critical = layers.criticalReasons.length > 0 || layers.fallbackReasons.length > 0;
  let risk;
  let playwright;
  if (critical) {
    risk = 'critical';
    playwright = 'full';
  } else if (layers.minimalReason) {
    risk = 'minimal';
    playwright = 'none';
  } else {
    risk = 'targeted';
    playwright = layers.fixtureSuite ? 'fixture' : layers.specFiles.size > 0 ? 'files' : 'none';
  }

  const reasons = [...layers.criticalReasons];
  if (layers.minimalReason) reasons.push(layers.minimalReason);
  if (risk === 'targeted' && playwright === 'fixture') reasons.push('runtime UI/API change: the fixture-mode Playwright suite runs');

  // The fixture suite already contains every non-scenario spec; only the
  // scenario specs touched directly still need naming.
  const playwrightFiles = playwright === 'files'
    ? [...layers.specFiles].sort()
    : playwright === 'fixture'
      ? [...layers.specFiles].filter(f => /^e2e\/scenario-/.test(f)).sort()
      : [];

  return {
    ok: true,
    risk,
    fallback: layers.fallbackReasons.length > 0,
    fallbackReasons: [...layers.fallbackReasons],
    reasons,
    changedFileCount: fileCount,
    lintPackages: risk === 'critical' ? 'ALL' : [...layers.changedPackages].sort(),
    typecheckScripts: risk === 'critical' || layers.typecheckScripts,
    unitProjects: risk === 'critical' ? 'ALL' : [...layers.unitProjects].sort(),
    playwright,
    playwrightFiles,
    awsEscalation: [...layers.awsEscalation].sort().map(c => `DEPLOYZ_E2E_ALLOW_REAL_AWS=1 ${c}`),
  };
}

// ── Commands (mirrored by CI; --run executes only these) ─────────────────────

// Every non-visual, non-scenario spec, plus the two scenario specs that drive
// the browser (the other scenario specs exercise the API only).
const FIXTURE_SUITE_ARGS = ['--grep-invert', '@scenario|visual'];
export const BROWSER_SCENARIO_SPECS = ['e2e/scenario-ui.spec.ts', 'e2e/scenario-release-unavailable.spec.ts'];
const DEFAULT_HTTPS_SPEC = 'e2e/scenario-default-https.spec.ts';

export function commandsFor(plan) {
  const cmds = [];
  if (plan.risk === 'minimal') return cmds;

  cmds.push({ label: 'static production-safety guards', cmd: 'pnpm', args: ['test:static'] });
  cmds.push({ label: 'typecheck e2e', cmd: 'pnpm', args: ['typecheck:e2e'] });
  if (plan.unitProjects === 'ALL') {
    cmds.push({ label: 'full unit suite', cmd: 'pnpm', args: ['vitest', 'run'] });
  } else if (plan.unitProjects.length > 0) {
    cmds.push({ label: `unit ${plan.unitProjects.join(' ')}`, cmd: 'pnpm', args: ['vitest', 'run', ...plan.unitProjects.flatMap(p => ['--project', p])] });
  }
  if (plan.typecheckScripts) {
    cmds.push({ label: 'typecheck AWS harnesses', cmd: 'pnpm', args: ['typecheck:scripts'] });
  }
  if (plan.playwright === 'full') {
    cmds.push({ label: 'CDK bundling smoke', cmd: 'pnpm', args: ['synth:smoke'] });
    cmds.push({ label: 'fixture-mode Playwright suite', cmd: 'node', args: ['scripts/e2e.mjs', ...FIXTURE_SUITE_ARGS] });
    cmds.push({ label: 'full simulated scenario suite', cmd: 'node', args: ['scripts/e2e.mjs', '--scenarios'] });
    cmds.push({ label: 'default-HTTPS scenarios', cmd: 'node', args: ['scripts/e2e.mjs', DEFAULT_HTTPS_SPEC], env: { DEPLOYZ_DEFAULT_HTTPS_FIXTURE: 'true' } });
  } else if (plan.playwright === 'fixture') {
    cmds.push({ label: 'fixture-mode Playwright suite', cmd: 'node', args: ['scripts/e2e.mjs', ...FIXTURE_SUITE_ARGS] });
    cmds.push({ label: 'browser scenario specs', cmd: 'node', args: ['scripts/e2e.mjs', ...BROWSER_SCENARIO_SPECS, ...plan.playwrightFiles.filter(f => !BROWSER_SCENARIO_SPECS.includes(f))] });
  } else if (plan.playwright === 'files') {
    // The default-HTTPS spec skips every test unless its fixture flag is on,
    // and the other specs are written against HTTP-only installs, so it
    // always runs on its own server.
    const rest = plan.playwrightFiles.filter(f => f !== DEFAULT_HTTPS_SPEC);
    if (rest.length > 0) cmds.push({ label: 'Playwright specs', cmd: 'node', args: ['scripts/e2e.mjs', ...rest] });
    if (plan.playwrightFiles.includes(DEFAULT_HTTPS_SPEC)) cmds.push({ label: 'default-HTTPS scenarios', cmd: 'node', args: ['scripts/e2e.mjs', DEFAULT_HTTPS_SPEC], env: { DEPLOYZ_DEFAULT_HTTPS_FIXTURE: 'true' } });
  }
  return cmds;
}

// ── Render ───────────────────────────────────────────────────────────────────

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function printChanged(files) {
  console.log(`${BOLD}Changed areas:${RESET}`);
  if (files.length === 0) {
    console.log('  (no changes detected)');
    return;
  }
  if (files.length <= 20) {
    for (const f of files) console.log(`  ${f}`);
  } else {
    const groups = {};
    for (const f of files) {
      const dir = f.includes('/') ? f.split('/').slice(0, -1).join('/') : '(root)';
      (groups[dir] ??= []).push(f.split('/').pop());
    }
    for (const [dir, items] of Object.entries(groups)) {
      console.log(`  ${dir}/ (${items.length} file${items.length > 1 ? 's' : ''})`);
      for (const item of items.slice(0, 5)) console.log(`    ${item}`);
      if (items.length > 5) console.log(`    ... and ${items.length - 5} more`);
    }
  }
  console.log();
}

function printPlan(plan) {
  console.log(`${BOLD}Risk level:${RESET} ${plan.risk}`);
  if (plan.fallbackReasons.length > 0) {
    console.log(`${YELLOW}Fail-safe engaged:${RESET}`);
    for (const r of plan.fallbackReasons) console.log(`  ${r}`);
  }
  for (const r of plan.reasons) console.log(`  reason: ${r}`);
  console.log(`\n${BOLD}Required:${RESET}`);
  if (plan.risk === 'minimal') {
    console.log(`  ${YELLOW}(minimal gate — no executable layers for documentation-only changes)${RESET}`);
  } else {
    console.log(`  ${GREEN}✓${RESET} build workspace packages (turbo cache): pnpm build`);
    console.log(`  ${GREEN}✓${RESET} lint: ${plan.lintPackages === 'ALL' ? 'pnpm lint' : plan.lintPackages.length > 0 ? `pnpm turbo run lint --filter=${plan.lintPackages.join(' --filter=')}` : '(no workspace package changed)'}`);
  }
  for (const c of commandsFor(plan)) {
    console.log(`  ${GREEN}✓${RESET} ${c.label}: ${c.cmd} ${(c.args ?? []).join(' ')}${c.env ? ` (env ${Object.entries(c.env).map(([k, v]) => `${k}=${v}`).join(' ')})` : ''}`);
  }
  console.log(`\n${BOLD}Not required:${RESET}`);
  if (plan.playwright !== 'full') console.log(`  ${RED}✗${RESET} full simulated scenario suite`);
  console.log(`  ${RED}✗${RESET} real AWS (escalation only, never run by --run or CI)`);
  if (plan.awsEscalation.length > 0) {
    console.log(`\n${BOLD}AWS escalation (manual only):${RESET}`);
    for (const c of plan.awsEscalation) console.log(`  ${YELLOW}${c}${RESET}`);
  }
}

function printEscalation(plan) {
  console.log(`${BOLD}AWS Escalation Assessment${RESET}\n`);
  if (plan.awsEscalation.length === 0) {
    console.log('  No AWS layer requirements detected for the current changes.\n');
    console.log('  Real AWS is an escalation, not the debugging loop. Run targeted');
    console.log('  vitest and simulated E2E scenarios first.');
    return;
  }
  const triggering = plan.reasons.filter(r => /relay code|infrastructure code/.test(r));
  console.log('  Required AWS layers:');
  for (const r of triggering.length > 0 ? triggering : plan.reasons) console.log(`    • ${r}`);
  console.log();
  for (const c of plan.awsEscalation) console.log(`  ${c}`);
  console.log();
  console.log(`${BOLD}⚠  Reminder:${RESET} real AWS is an escalation, not the debugging loop.`);
  console.log('   Run targeted vitest and simulated E2E scenarios first. Copy these');
  console.log('   commands manually — --run will not execute them.');
  console.log(`   Set ${YELLOW}DEPLOYZ_E2E_ALLOW_REAL_AWS=1${RESET} in your shell before running.`);
}

// ── CLI ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const out = { run: false, filesOverride: null, base: null, format: 'text', escalation: false, githubOutput: false, full: false, invalid: [] };
  for (const arg of argv) {
    if (arg === '--run') out.run = true;
    else if (arg.startsWith('--files=')) out.filesOverride = arg.slice('--files='.length).split(/[, ]+/).map(s => s.trim()).filter(Boolean);
    else if (arg.startsWith('--base=')) out.base = arg.slice('--base='.length);
    else if (arg === '--format=json' || arg === '--json') out.format = 'json';
    else if (arg === '--format=text') out.format = 'text';
    else if (arg === '--escalation') out.escalation = true;
    else if (arg === '--github-output') out.githubOutput = true;
    else if (arg === '--full') out.full = true;
    else out.invalid.push(arg);
  }
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.invalid.length > 0) {
    console.error(`Unknown argument(s): ${opts.invalid.join(' ')}\nUsage: test-affected.mjs [--base=<ref>] [--files=<csv>] [--full] [--format=json] [--run] [--escalation]`);
    process.exit(1);
  }

  let files;
  let detectionError = null;
  if (opts.filesOverride) {
    files = opts.filesOverride;
  } else {
    const r = collectChangedFiles(process.cwd(), opts.base);
    if (r.error) detectionError = r.error;
    else files = r.files;
  }

  const plan = planFromFiles(detectionError ? null : files, { full: opts.full });
  if (detectionError) console.error(`Warning: change detection failed (${detectionError}); selected the full regression.`);

  if (opts.githubOutput) {
    const outPath = process.env.GITHUB_OUTPUT;
    if (!outPath) {
      console.error('--github-output requires the GITHUB_OUTPUT step-output path (GitHub Actions).');
      process.exit(1);
    }
    if (!plan.ok || (plan.fallback && plan.risk !== 'critical')) {
      console.error(`Refusing to publish an invalid plan: ok=${plan.ok} fallback=${plan.fallback} risk=${plan.risk}`);
      process.exit(1);
    }
    const set = (k, v) => appendFileSync(outPath, `${k}=${v}\n`);
    set('risk', plan.risk);
    set('unit_projects', plan.unitProjects === 'ALL' ? 'ALL' : plan.unitProjects.join(' '));
    set('lint_packages', plan.lintPackages === 'ALL' ? 'ALL' : plan.lintPackages.join(' '));
    set('playwright', plan.playwright);
    set('playwright_files', plan.playwrightFiles.join(' '));
    set('typecheck_scripts', String(plan.typecheckScripts));
    set('aws_escalation', plan.awsEscalation.join(' && '));
  }

  if (opts.format === 'json') {
    console.log(JSON.stringify(plan));
  } else {
    printChanged(files ?? []);
    printPlan(plan);
  }
  if (opts.escalation) {
    if (opts.format === 'json') console.log(JSON.stringify({ awsEscalation: plan.awsEscalation, reasons: plan.reasons }));
    else printEscalation(plan);
    process.exit(0);
  }
  if (detectionError) process.exit(0); // fallback plan emitted; CI gates on its validity

  if (opts.run) {
    console.log(`\n${BOLD}Executing simulated layers...${RESET}\n`);
    const commands = commandsFor(plan);
    if (plan.risk !== 'minimal') commands.unshift({ label: 'build', cmd: 'pnpm', args: ['build'] });
    if (commands.length === 0) {
      console.log('  No simulated layers to execute.');
      process.exit(0);
    }
    for (const c of commands) {
      const dir = c.cwd ? relative(process.cwd(), c.cwd) : '.';
      console.log(`  ${YELLOW}>${RESET} ${c.cmd} ${c.args.join(' ')}  (in ${dir})`);
      const result = spawnSync(c.cmd, c.args, {
        cwd: c.cwd ? `${process.cwd()}/${c.cwd}` : process.cwd(),
        stdio: 'inherit',
        shell: true,
        env: { ...process.env, ...c.env },
      });
      if (result.status !== 0) {
        console.error(`\n  Command failed with exit code ${result.status}, aborting.`);
        process.exit(result.status ?? 1);
      }
    }
    if (plan.awsEscalation.length > 0) {
      console.log(`\n  ${YELLOW}Skipped AWS commands (must be run manually):${RESET}`);
      for (const c of plan.awsEscalation) console.log(`    ${c}`);
      console.log(`  ${BOLD}Real AWS is an escalation, not the debugging loop.${RESET}`);
    }
    console.log(`\n  ${GREEN}All simulated layers passed.${RESET}`);
  }
}

const isCli = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isCli) main();
