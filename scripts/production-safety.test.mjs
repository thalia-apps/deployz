// Static production-safety guards (docs/testing/simulated-e2e.md, decisions
// D1/D2/D3) — run with:
//   node --test scripts/production-safety.test.mjs   (or: pnpm test:static)
// No server and no browser: filesystem reads only, so every non-docs PR
// runs them in seconds. The one runtime property — the API defines no
// scenario-control route — lives in apps/api/src/server.test.ts.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function listFiles(dir, extensions, skipDirs) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, extensions, skipDirs));
    else if (extensions.some((ext) => entry.name.endsWith(ext))) out.push(full);
  }
  return out;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

// D1: the simulator cannot construct a real AWS client because it never
// value-imports the AWS SDK. Type-only imports of the relay's client
// interfaces are the allowed pattern.
const AWS_SDK_IMPORT = /import\s+(type\s+)?[\s\S]*?from\s+['"](@aws-sdk\/[^'"]+)['"]/g;

test('no file under e2e/simulation/ has a value import from @aws-sdk/* (D1)', () => {
  const offenders = [];
  for (const file of listFiles(path.join(REPO_ROOT, 'e2e', 'simulation'), ['.ts', '.tsx'], new Set())) {
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(AWS_SDK_IMPORT)) {
      if (match[1] === undefined) {
        offenders.push(`${path.relative(REPO_ROOT, file)}:${lineOf(content, match.index ?? 0)} — value import of "${match[2]}"`);
      }
    }
  }
  assert.deepEqual(offenders, [], `AWS SDK value imports found:\n${offenders.join('\n')}`);
});

// The deploy workflow's job-level env: block becomes the deployed Lambda's
// ENTIRE environment (collectEnvVars in packages/cdk), so a fixture-mode
// variable present there would ship live.
const FIXTURE_ENV_VARS = [
  'GITHUB_FIXTURE_MODE',
  'AI_FIXTURE_MODE',
  'DOMAIN_FIXTURE_MODE',
  'BUILD_FIXTURE_MODE',
  'BILLING_FIXTURE_MODE',
  'DEPLOYZ_DEFAULT_HTTPS_FIXTURE',
  'DEPLOYZ_E2E_MODE',
  'DEPLOYZ_E2E_SCENARIO',
];

test('deploy-api.yml deployed-environment block sets none of the fixture-mode vars (D2/D3)', () => {
  const content = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'deploy-api.yml'), 'utf8').replace(/\r\n/g, '\n');
  const envStart = content.indexOf('\n    env:\n');
  const envEnd = content.indexOf('\n    steps:\n', envStart);
  assert.ok(envStart > -1, 'could not locate the job-level env: block in deploy-api.yml');
  assert.ok(envEnd > envStart, 'could not locate the steps: block after env: in deploy-api.yml');
  const envBlock = content.slice(envStart, envEnd);
  const present = FIXTURE_ENV_VARS.filter((name) => new RegExp(`\\b${name}\\b`).test(envBlock));
  assert.deepEqual(present, [], `fixture-mode vars leaked into the deploy env block: ${present.join(', ')}`);
});

// D2: the simulator is test-only — nothing under apps/ or packages/ reaches
// into e2e/ (an ES import or a require()).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage', 'cdk.out']);
const IMPORT_FROM_E2E = /from\s+['"][^'"]*\be2e\/simulation[^'"]*['"]/;
const REQUIRE_FROM_E2E = /require\(\s*['"][^'"]*\be2e\/[^'"]*['"]\s*\)/;

// A deploy workflow's gate redeploys only when a changed path is in its PATHS
// list, so every workspace package the deployed app bundles (transitively)
// must be listed — a compiler-only merge once passed CI and never deployed.
function workspaceDependencies(packageDir, seen = new Set()) {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, packageDir, 'package.json'), 'utf8'));
  const names = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, version]) => String(version).startsWith('workspace:'))
    .map(([name]) => name);
  for (const name of names) {
    const dir = `packages/${name.replace('@deployz/', '')}`;
    if (seen.has(dir)) continue;
    seen.add(dir);
    workspaceDependencies(dir, seen);
  }
  return seen;
}

for (const [app, workflow] of [['apps/api', 'deploy-api.yml'], ['apps/web', 'deploy-web.yml']]) {
  test(`${workflow} redeploys on a change to every workspace package ${app} bundles`, () => {
    const content = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', workflow), 'utf8');
    const paths = content.match(/^\s*PATHS:\s*(.+)$/m)?.[1].split(/\s+/) ?? [];
    for (const dir of workspaceDependencies(app)) {
      assert.ok(paths.includes(`${dir}/*`), `${workflow} PATHS is missing ${dir}/*`);
    }
  });
}

test('no file under apps/ or packages/ imports from e2e/ (D2: test-only boundary)', () => {
  const offenders = [];
  for (const root of ['apps', 'packages']) {
    for (const file of listFiles(path.join(REPO_ROOT, root), ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'], SKIP_DIRS)) {
      const content = readFileSync(file, 'utf8');
      if (IMPORT_FROM_E2E.test(content) || REQUIRE_FROM_E2E.test(content)) offenders.push(path.relative(REPO_ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `product code importing from e2e/:\n${offenders.join('\n')}`);
});

// Per-environment workflow structure. These guards parse the workflows, so a
// job added before `deploy` can no longer move the block they read. Each one
// names the files it covers: .github/workflows/aws-canary.yml holds real
// production values and ci.yml holds fake AWS credentials, so a
// repository-wide rule would fail on both. No production value is written
// here either — the Cloudflare zone id is matched by shape, because
// apps/api/src/env.test.ts allows that literal only under .github,
// .env.example and docs, and it does not skip this file.
const WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');
const DEPLOY_WORKFLOWS = ['deploy-api.yml', 'deploy-web.yml'];
const RELEASE_WORKFLOW = 'release.yml';
const PER_ENVIRONMENT_WORKFLOWS = [...DEPLOY_WORKFLOWS, RELEASE_WORKFLOW];
const SERVICE_OF = { 'deploy-api.yml': 'api', 'deploy-web.yml': 'web' };
const CALLING_JOBS = ['production-api', 'production-web', 'staging-api', 'staging-web'];
const ENVIRONMENT_INPUT = '${{ inputs.environment }}';
const CREDENTIALS_ACTION = 'aws-actions/configure-aws-credentials';
const STAGES = ['staging', 'production'];

function parseWorkflow(name) {
  const text = readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
  try {
    return parse(text);
  } catch (error) {
    assert.fail(`${name} is not valid YAML: ${error.message}`);
  }
}

// readdirSync does not promise alphabetical order, so the set is sorted
// before any comparison. Parsing happens here, at load, so an unparseable
// workflow fails the whole file instead of letting each guard below read an
// empty tree and pass.
const WORKFLOW_FILES = readdirSync(WORKFLOWS_DIR)
  .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
  .sort();
const WORKFLOWS = Object.fromEntries(WORKFLOW_FILES.map((name) => [name, parseWorkflow(name)]));

function jobsOf(file) {
  return WORKFLOWS[file].jobs ?? {};
}

function needsOf(job) {
  const needs = job?.needs ?? [];
  return Array.isArray(needs) ? needs : [needs];
}

function stepsOf(job) {
  return Array.isArray(job?.steps) ? job.steps : [];
}

function environmentOf(job) {
  const environment = job?.environment;
  if (environment !== null && typeof environment === 'object') return environment.name ?? '';
  return environment;
}

// The parser drops a YAML comment, but a `#` line inside a `run: |` body is
// part of the shell string and stays. A production literal may live in a
// comment, so whole comment lines go. The pattern is anchored at the line
// start: an unanchored one would also cut a trailing comment and could hide
// an offending value on the same line.
function withoutComments(text) {
  return text.replace(/^\s*#.*$/gm, '');
}

// Every key and every scalar value in a parsed workflow, with a readable key
// path for the failure message.
function* scalars(node, keyPath = '') {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* scalars(item, `${keyPath}[${index}]`);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = keyPath === '' ? key : `${keyPath}.${key}`;
      yield { path: next, text: key, kind: 'key' };
      yield* scalars(value, next);
    }
  } else {
    const value = typeof node === 'string' ? node : String(node);
    const text = keyPath.endsWith('.run') ? withoutComments(value) : value;
    yield { path: keyPath, text, kind: 'value' };
  }
}

// Every `env:` mapping at any depth: a job-level block and a step-level one
// both reach a deployed process.
function* envMaps(node, keyPath = '') {
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) yield* envMaps(item, `${keyPath}[${index}]`);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      const next = keyPath === '' ? key : `${keyPath}.${key}`;
      if (key === 'env' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
        yield { path: next, map: value };
      }
      yield* envMaps(value, next);
    }
  }
}

function isMapping(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('the deploy workflow file set is the one these guards cover', () => {
  const deployFiles = WORKFLOW_FILES.filter((name) => name.startsWith('deploy-'));
  assert.deepEqual(
    deployFiles,
    DEPLOY_WORKFLOWS,
    `.github/workflows/ holds ${deployFiles.join(', ')}, which is not the set these guards cover. A new deploy workflow needs its own PATHS dependency closure, its own concurrency group and its own service name, and DEPLOY_WORKFLOWS and SERVICE_OF in this file must name it, before the guards can pass.`,
  );
  assert.ok(
    isMapping(WORKFLOWS[RELEASE_WORKFLOW]?.jobs),
    `${RELEASE_WORKFLOW} parsed with no jobs: mapping, so the release guards below would read nothing.`,
  );
});

test('no env: block and no run: body in a deploy or release workflow sets a fixture-mode var (D2/D3)', () => {
  const offenders = [];
  for (const file of PER_ENVIRONMENT_WORKFLOWS) {
    const maps = [...envMaps(WORKFLOWS[file])];
    assert.ok(maps.length > 0, `${file}: no env: mapping was found, so this sweep proves nothing.`);
    for (const { path: keyPath, map } of maps) {
      for (const name of Object.keys(map)) {
        if (FIXTURE_ENV_VARS.includes(name)) offenders.push(`${file} ${keyPath}.${name}`);
      }
    }
  }
  for (const file of DEPLOY_WORKFLOWS) {
    const deploy = jobsOf(file).deploy;
    assert.ok(
      isMapping(deploy?.env) && Object.keys(deploy.env).length > 0,
      `${file} jobs.deploy.env must be a non-empty mapping: it is the deployed environment this sweep exists to protect.`,
    );
    // deploy-web.yml writes the container's runtime environment and the
    // client build args inside run: bodies, not in an env: map, so the sweep
    // above alone misses the web half.
    for (const step of stepsOf(deploy)) {
      const body = typeof step?.run === 'string' ? withoutComments(step.run) : '';
      for (const name of FIXTURE_ENV_VARS) {
        if (new RegExp(`\\b${name}\\b`).test(body)) {
          offenders.push(`${file} jobs.deploy step "${step.name}" run body names ${name}`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], `fixture-mode vars reach a deployed environment:\n${offenders.join('\n')}`);
});

// An environment-specific value in the workflow belongs to one stage, so the
// other stage deploys it too. Every such value comes from the GitHub
// Environment instead.
const PRODUCTION_LITERALS = ['deployz.dev', 'deployz-web'];
const PRODUCTION_HOSTNAME_PREFIX = 'd-';
const ZONE_ID_SHAPE = /\b[0-9a-fA-F]{32}\b/;

test('no deploy or release workflow carries an environment-specific value', () => {
  const offenders = [];
  for (const file of PER_ENVIRONMENT_WORKFLOWS) {
    for (const { path: keyPath, text, kind } of scalars(WORKFLOWS[file])) {
      for (const literal of PRODUCTION_LITERALS) {
        if (text.includes(literal)) offenders.push(`${file} ${keyPath} (${kind}) holds "${literal}"`);
      }
      if (kind === 'value' && text === PRODUCTION_HOSTNAME_PREFIX) {
        offenders.push(`${file} ${keyPath} is a bare hostname prefix`);
      }
      if (ZONE_ID_SHAPE.test(text)) {
        offenders.push(`${file} ${keyPath} (${kind}) holds a 32-character hex token, the shape of a Cloudflare zone id`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `environment-specific values belong on the GitHub Environment, not in the workflow:\n${offenders.join('\n')}\nReplace each one with a vars.* or secrets.* reference. A comment may still name it.`,
  );
});

test('each deploy workflow binds its deploy job to the environment it was given', () => {
  for (const file of DEPLOY_WORKFLOWS) {
    const jobs = jobsOf(file);
    assert.equal(
      environmentOf(jobs.deploy),
      ENVIRONMENT_INPUT,
      `${file} jobs.deploy.environment must be exactly "${ENVIRONMENT_INPUT}", or the job resolves repository values and the Environment's own variables arrive empty.`,
    );
    assert.equal(
      jobs.deploy?.env?.EXPECTED_ENVIRONMENT,
      ENVIRONMENT_INPUT,
      `${file} jobs.deploy.env.EXPECTED_ENVIRONMENT must be exactly "${ENVIRONMENT_INPUT}". It is the left side of the stage gate, so a value taken from the Environment itself makes that comparison always true and the gate dead.`,
    );
    assert.equal(
      jobs.deploy?.env?.DEPLOYZ_STAGE,
      '${{ vars.DEPLOYZ_STAGE }}',
      `${file} jobs.deploy.env.DEPLOYZ_STAGE must come from vars, so the stage gate compares the Environment's own stage against the requested one.`,
    );
    assert.equal(
      environmentOf(jobs.gate),
      undefined,
      `${file} jobs.gate must declare no environment: the tip-of-main check runs before the production approval only because the gate waits for none, and an Environment there would also hand the gate that stage's secrets.`,
    );
    const credentialJobs = Object.entries(jobs).filter(([, job]) =>
      stepsOf(job).some((step) => typeof step?.uses === 'string' && step.uses.startsWith(CREDENTIALS_ACTION)),
    );
    assert.ok(
      credentialJobs.length > 0,
      `${file}: no job uses ${CREDENTIALS_ACTION}, so this sweep proves nothing.`,
    );
    for (const [name, job] of credentialJobs) {
      assert.ok(
        environmentOf(job),
        `${file} jobs.${name} assumes an AWS role but declares no environment:, so it resolves no Environment variable and cannot wait for that stage's approval.`,
      );
    }
  }
});

test('each deploy job locks one deploy for each environment and cancels none', () => {
  const groups = [];
  for (const file of DEPLOY_WORKFLOWS) {
    const concurrency = jobsOf(file).deploy?.concurrency;
    assert.ok(
      String(concurrency?.group).includes('inputs.environment'),
      `${file} jobs.deploy.concurrency.group must carry inputs.environment, or a staging deploy waits for a production deploy.`,
    );
    assert.equal(
      concurrency['cancel-in-progress'],
      false,
      `${file} jobs.deploy.concurrency.cancel-in-progress must be false: GitHub cancels the running member of a group, which must never happen in the middle of a deploy.`,
    );
    groups.push(concurrency.group);
  }
  assert.equal(
    new Set(groups).size,
    groups.length,
    `the deploy workflows share a concurrency group (${groups.join(', ')}), so the two services queue behind each other.`,
  );
  for (const file of PER_ENVIRONMENT_WORKFLOWS) {
    assert.equal(
      WORKFLOWS[file].concurrency,
      undefined,
      `${file} must declare no workflow-level concurrency: a production job waiting for an approval would hold a lock that stops the next staging deploy, and workflow-level concurrency cannot read inputs.`,
    );
  }
});

test('each deploy workflow is callable and dispatchable, and a dispatch defaults to staging', () => {
  for (const file of DEPLOY_WORKFLOWS) {
    const triggers = WORKFLOWS[file].on ?? {};
    assert.ok(isMapping(triggers.workflow_call), `${file} must declare on.workflow_call: ${RELEASE_WORKFLOW} calls it.`);
    assert.ok(
      isMapping(triggers.workflow_dispatch),
      `${file} must declare on.workflow_dispatch: it is the per-service path for a rollback or a single staging deploy.`,
    );
    assert.equal(
      triggers.workflow_dispatch.inputs?.environment?.default,
      'staging',
      `${file} on.workflow_dispatch.inputs.environment.default must be "staging": an operator who forgets the flag must not reach production.`,
    );
  }
});

test('each deploy gate names its tag after the environment it deploys', () => {
  for (const file of DEPLOY_WORKFLOWS) {
    const service = SERVICE_OF[file];
    const decide = stepsOf(jobsOf(file).gate).find((step) => step?.id === 'decide');
    assert.ok(
      typeof decide?.run === 'string',
      `${file} jobs.gate has no step with id: decide, so the tag rule cannot be read.`,
    );
    // The pairing, not the two names on their own: a flipped comparison keeps
    // both strings and would let a staging run move production's tag.
    const pairing = new RegExp(
      `if \\[ "\\$ENVIRONMENT" = "production" \\]; then\\s+tag="deployed/${service}"\\s+else\\s+tag="deployed/\\$ENVIRONMENT/${service}"\\s+fi`,
    );
    assert.match(
      decide.run,
      pairing,
      `${file} jobs.gate step decide must keep the pairing: $ENVIRONMENT = "production" gives tag="deployed/${service}", and every other stage gives tag="deployed/$ENVIRONMENT/${service}".`,
    );
  }
});

// apps/api/src/env.test.ts:238, :437 and :457 still locate the deployed
// environment with indexOf('\n    env:\n'), which finds the FIRST job-level
// env: block in the file. A job declared before `deploy` with a job-level
// env: would make those three read the wrong block and pass without checking
// anything. A job declared after `deploy` cannot move a forward indexOf, so
// the rule stops where the precondition stops.
test('no job declared before the deploy job of a deploy workflow has a job-level env:', () => {
  for (const file of DEPLOY_WORKFLOWS) {
    const jobs = jobsOf(file);
    const names = Object.keys(jobs);
    const offenders = names.slice(0, names.indexOf('deploy')).filter((name) => jobs[name]?.env !== undefined);
    assert.deepEqual(
      offenders,
      [],
      `${file}: ${offenders.join(', ')} declares a job-level env: before the deploy job. Make the locators in apps/api/src/env.test.ts (lines 238, 437 and 457) structural first — they read the first job-level env: block in the file.`,
    );
  }
});

test('release.yml calls one deploy workflow for each service and stage', () => {
  const jobs = jobsOf(RELEASE_WORKFLOW);
  const callers = Object.entries(jobs).filter(([, job]) => job?.uses !== undefined);
  assert.deepEqual(
    callers.map(([name]) => name).sort(),
    CALLING_JOBS,
    `${RELEASE_WORKFLOW} calls ${callers.map(([name]) => name).join(', ')}, which is not the set these guards cover. A new calling job needs a human review, then a place in CALLING_JOBS.`,
  );
  const released = new Set();
  for (const [name, job] of callers) {
    const called = path.basename(String(job.uses));
    assert.ok(
      DEPLOY_WORKFLOWS.includes(called),
      `${RELEASE_WORKFLOW} jobs.${name}.uses must call one of ${DEPLOY_WORKFLOWS.join(' or ')}; it calls "${job.uses}".`,
    );
    const environment = job.with?.environment;
    assert.ok(
      STAGES.includes(environment),
      `${RELEASE_WORKFLOW} jobs.${name}.with.environment must be one of ${STAGES.join(' or ')}; it is "${environment}".`,
    );
    released.add(`${environment} ${called}`);
    if (environment !== 'production') continue;
    assert.ok(
      needsOf(job).includes('staging-verify'),
      `${RELEASE_WORKFLOW} jobs.${name}.needs must include staging-verify.`,
    );
    const condition = String(job.if ?? '');
    assert.ok(
      condition.includes("needs.staging-verify.result == 'success'"),
      `${RELEASE_WORKFLOW} jobs.${name}.if must require needs.staging-verify.result == 'success'. needs: alone does not hold production back from a FAILED staging verification, because the condition also carries !cancelled().`,
    );
    assert.ok(
      condition.includes('!cancelled()'),
      `${RELEASE_WORKFLOW} jobs.${name}.if must carry !cancelled(), which is what lets it evaluate when staging-verify was skipped on a production-only dispatch.`,
    );
    assert.ok(
      !condition.includes('always()'),
      `${RELEASE_WORKFLOW} jobs.${name}.if must not use always(): it would release production on a cancelled run.`,
    );
  }
  for (const environment of STAGES) {
    for (const file of DEPLOY_WORKFLOWS) {
      assert.ok(
        released.has(`${environment} ${file}`),
        `${RELEASE_WORKFLOW} releases no ${environment} ${SERVICE_OF[file]}: no job calls ${file} with environment: ${environment}.`,
      );
    }
  }
  const verify = jobs['staging-verify'];
  assert.equal(
    environmentOf(verify),
    'staging',
    `${RELEASE_WORKFLOW} jobs.staging-verify.environment must be "staging". Another Environment resolves that stage's API_URL, APP_HOST and MARKETING_HOST, so the poll would report staging while it reads another stage.`,
  );
  for (const name of ['staging-api', 'staging-web']) {
    assert.ok(
      needsOf(verify).includes(name),
      `${RELEASE_WORKFLOW} jobs.staging-verify.needs must include ${name}, or the poll races that deploy and proves the previous staging deployment.`,
    );
  }
});

function assertIdTokenWrite(file, name, job) {
  const permissions = job?.permissions;
  assert.ok(
    isMapping(permissions),
    `${file} jobs.${name}.permissions must be a mapping that names id-token: write; "${permissions}" is a shorthand, and write-all also grants far more than a deploy needs.`,
  );
  assert.equal(
    permissions['id-token'],
    'write',
    `${file} jobs.${name}.permissions must include id-token: write, or the job cannot ask GitHub for the OIDC token it assumes the AWS deploy role with.`,
  );
}

test('every deploying job may request an OIDC token', () => {
  for (const file of DEPLOY_WORKFLOWS) assertIdTokenWrite(file, 'deploy', jobsOf(file).deploy);
  for (const name of CALLING_JOBS) {
    assertIdTokenWrite(RELEASE_WORKFLOW, name, jobsOf(RELEASE_WORKFLOW)[name]);
  }
});

// The deploy holds no long-lived AWS key: it assumes a role with OIDC. The
// sweep covers these three files only, because aws-canary.yml carries the
// canary's own credentials and ci.yml carries the simulator's fake ones.
const ACCESS_KEY_NAMES = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'];

test('no deploy or release workflow names a long-lived AWS access key', () => {
  const offenders = [];
  for (const file of PER_ENVIRONMENT_WORKFLOWS) {
    let visited = 0;
    for (const { path: keyPath, text, kind } of scalars(WORKFLOWS[file])) {
      visited += 1;
      for (const name of ACCESS_KEY_NAMES) {
        if (text.includes(name)) offenders.push(`${file} ${keyPath} (${kind}) names ${name}`);
      }
    }
    assert.ok(visited > 0, `${file}: the walk visited no scalar, so this sweep proves nothing.`);
  }
  assert.deepEqual(
    offenders,
    [],
    `the deploy assumes a role with OIDC and must hold no access key:\n${offenders.join('\n')}`,
  );
});

test('only release.yml inherits the repository secrets', () => {
  const inheriting = [];
  for (const file of WORKFLOW_FILES) {
    for (const [name, job] of Object.entries(jobsOf(file))) {
      if (job?.secrets === 'inherit') inheriting.push(`${file} jobs.${name}`);
    }
  }
  const outside = inheriting.filter((entry) => !entry.startsWith(`${RELEASE_WORKFLOW} `));
  assert.deepEqual(
    outside,
    [],
    `secrets: inherit belongs only to a calling job in ${RELEASE_WORKFLOW}, which may declare no Environment of its own:\n${outside.join('\n')}`,
  );
  for (const name of CALLING_JOBS) {
    assert.equal(
      jobsOf(RELEASE_WORKFLOW)[name]?.secrets,
      'inherit',
      `${RELEASE_WORKFLOW} jobs.${name} must pass secrets: inherit. An explicit mapping in a job that cannot declare an Environment resolves every value at the repository level and passes production's secrets into the staging deploy.`,
    );
  }
});

// deploy-web.yml states that nothing in CI compares the two workflows against
// each other. This does: the dashboard reads the session-cookie name the API
// writes, so both must take the prefix from the same Environment variable.
test('both deploy workflows take COOKIE_PREFIX from the same Environment variable', () => {
  const reference = '${{ vars.COOKIE_PREFIX }}';
  for (const file of DEPLOY_WORKFLOWS) {
    assert.equal(
      jobsOf(file).deploy?.env?.COOKIE_PREFIX,
      reference,
      `${file} jobs.deploy.env.COOKIE_PREFIX must be exactly "${reference}", or the dashboard reads a cookie name the API does not write.`,
    );
  }
});
