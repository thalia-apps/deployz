import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 1 Cloudflare runtime config. env.ts reads process.env once at import
// time and (via find-env-file.ts) dotenv-loads the nearest ancestor .env of
// process.cwd() — so assertions must not depend on a developer's own .env.
// Same isolation strategy as env-fixture-modes.test.ts: point process.cwd()
// at an empty temp dir before a fresh import, and delete the vars under test
// so a machine-wide export cannot leak into the default-value assertion.
const CLOUDFLARE_VARS = [
  'CLOUDFLARE_ZONE_ID',
  'CLOUDFLARE_ZONE_NAME',
  'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
  'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
];

// Polar billing config. Same isolation strategy as above.
const POLAR_VARS = ['POLAR_TOKEN', 'POLAR_WEBHOOK_SECRET', 'POLAR_PRODUCT_ID', 'POLAR_ENVIRONMENT'];

describe('Cloudflare runtime config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-cloudflare-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    for (const key of CLOUDFLARE_VARS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of CLOUDFLARE_VARS) delete process.env[key];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes the zone id, zone name and API token when set', async () => {
    process.env.CLOUDFLARE_ZONE_ID = 'test-zone';
    process.env.CLOUDFLARE_ZONE_NAME = 'example.test';
    process.env.CLOUDFLARE_ZONE_EDIT_API_TOKEN = 'test-token';

    const { env } = await import('./env.js');
    expect(env.cloudflareZoneId).toBe('test-zone');
    expect(env.cloudflareZoneName).toBe('example.test');
    expect(env.cloudflareZoneApiToken).toBe('test-token');
  });

  it('defaults the hostname prefix to d- when unset', async () => {
    const { env } = await import('./env.js');
    expect(env.defaultHostnamePrefix).toBe('d-');
  });

  it('honours an explicitly set hostname prefix', async () => {
    process.env.DEPLOYZ_DEFAULT_HOSTNAME_PREFIX = 'app-';

    const { env } = await import('./env.js');
    expect(env.defaultHostnamePrefix).toBe('app-');
  });

  // Server-only config: the Cloudflare zone id/token must never reach the
  // browser bundle. Anything under apps/web (src + root config files) that
  // names CLOUDFLARE — including a NEXT_PUBLIC_* inlining of it — is a leak.
  it('keeps Cloudflare out of apps/web entirely', () => {
    const webRoot = fileURLToPath(new URL('../../web', import.meta.url));
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['node_modules', '.next', '.turbo'].includes(entry.name)) continue;
          walk(full);
        } else if (
          entry.isFile() &&
          readFileSync(full, 'utf8').includes('CLOUDFLARE')
        ) {
          offenders.push(full);
        }
      }
    };
    walk(webRoot);
    expect(offenders).toEqual([]);
  });
});

// Polar billing config. Billing is optional at boot: an absent POLAR_TOKEN
// only warns (every billing surface then reports BILLING_DISABLED). Once
// POLAR_TOKEN is set, the other values are validated strictly — a
// half-configured provider must fail at startup, not silently no-op.
describe('Polar billing config', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-polar-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    for (const key of POLAR_VARS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of POLAR_VARS) delete process.env[key];
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('does not throw when POLAR_TOKEN is unset, and every field reads undefined', async () => {
    const { env } = await import('./env.js');
    expect(env.polarToken).toBeUndefined();
    expect(env.polarWebhookSecret).toBeUndefined();
    expect(env.polarProductId).toBeUndefined();
    expect(env.polarEnvironment).toBe('sandbox');
  });

  it('exposes every field and defaults the environment to sandbox when set', async () => {
    process.env.POLAR_TOKEN = 'polar_oat_replace_me';
    process.env.POLAR_WEBHOOK_SECRET = 'polar_whs_replace_me';
    process.env.POLAR_PRODUCT_ID = 'product_replace_me';

    const { env } = await import('./env.js');
    expect(env.polarToken).toBe('polar_oat_replace_me');
    expect(env.polarWebhookSecret).toBe('polar_whs_replace_me');
    expect(env.polarProductId).toBe('product_replace_me');
    expect(env.polarEnvironment).toBe('sandbox');
  });

  it('honours an explicit POLAR_ENVIRONMENT=production', async () => {
    process.env.POLAR_TOKEN = 'polar_oat_replace_me';
    process.env.POLAR_WEBHOOK_SECRET = 'polar_whs_replace_me';
    process.env.POLAR_PRODUCT_ID = 'product_replace_me';
    process.env.POLAR_ENVIRONMENT = 'production';

    const { env } = await import('./env.js');
    expect(env.polarEnvironment).toBe('production');
  });

  it('throws naming the missing key when POLAR_TOKEN is set without POLAR_WEBHOOK_SECRET', async () => {
    process.env.POLAR_TOKEN = 'polar_oat_replace_me';
    process.env.POLAR_PRODUCT_ID = 'product_replace_me';

    await expect(import('./env.js')).rejects.toThrow('POLAR_WEBHOOK_SECRET');
  });

  it('throws naming the missing key when POLAR_TOKEN is set without POLAR_PRODUCT_ID', async () => {
    process.env.POLAR_TOKEN = 'polar_oat_replace_me';
    process.env.POLAR_WEBHOOK_SECRET = 'polar_whs_replace_me';

    await expect(import('./env.js')).rejects.toThrow('POLAR_PRODUCT_ID');
  });

  it('throws when POLAR_ENVIRONMENT is neither sandbox nor production', async () => {
    process.env.POLAR_TOKEN = 'polar_oat_replace_me';
    process.env.POLAR_WEBHOOK_SECRET = 'polar_whs_replace_me';
    process.env.POLAR_PRODUCT_ID = 'product_replace_me';
    process.env.POLAR_ENVIRONMENT = 'staging';

    await expect(import('./env.js')).rejects.toThrow('POLAR_ENVIRONMENT');
  });
});

// Pure text scans of .github/workflows/deploy-api.yml: no network, no
// provider call, and no secret value is ever read or printed.
describe('Polar deploy configuration', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'deploy-api.yml'), 'utf8').replace(/\r\n/g, '\n');

  it('binds POLAR_TOKEN from secrets and POLAR_ENVIRONMENT from vars, defaulting to the stage', () => {
    const envStart = workflow.indexOf('\n    env:\n');
    const envBlock = workflow.slice(envStart, workflow.indexOf('\n    steps:\n', envStart));
    expect(envBlock).toContain('POLAR_TOKEN: ${{ secrets.POLAR_TOKEN }}');
    expect(envBlock).toContain(
      "POLAR_ENVIRONMENT: ${{ vars.POLAR_ENVIRONMENT || (inputs.environment == 'production' && 'production' || 'sandbox') }}",
    );
    expect(workflow).not.toContain('PADDLE_');
  });

  it('keeps POLAR_TOKEN out of the unconditional completeness gate', () => {
    const loops = [...workflow.matchAll(/for key in ([\s\S]*?); do/g)];
    const unconditional = loops.find((match) => match[1]!.includes('CDK_DEFAULT_ACCOUNT'));
    expect(unconditional).toBeDefined();
    expect(unconditional![1]!).not.toContain('POLAR');
  });

  it('prepares Polar only when POLAR_TOKEN is set, before the stack deploys, against the API webhook URL', () => {
    const stepStart = workflow.indexOf('- name: Prepare Polar billing');
    expect(stepStart).toBeGreaterThan(-1);
    expect(stepStart).toBeLessThan(workflow.indexOf('- name: Deploy the control-plane stack'));
    const step = workflow.slice(stepStart, workflow.indexOf('\n      - name:', stepStart + 1));
    expect(step).toContain('if [ -z "${POLAR_TOKEN:-}" ]');
    expect(step).toContain('exit 0');
    expect(step).toContain(
      'POLAR_WEBHOOK_URL="https://${API_DOMAIN_NAME}/api/billing/webhook" node scripts/billing/polar-setup.mjs',
    );
  });
});

// Phase 13 security guards — static scans over the workspace, mirroring the
// apps/web leak guard above. No network, no providers: pure filesystem reads.
describe('Phase 13 — zone id, token and probe provenance guards', () => {
  // apps/api/src is this file's directory; the workspace root is three levels up.
  const apiSrcRoot = fileURLToPath(new URL('.', import.meta.url));
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const ZONE_ID_HEX = 'bf69c0d8524ef2c5cfbc6e5d33fb7cae';

  const SKIP_DIRS = new Set(['node_modules', '.git', '.turbo', 'dist', '.next', '.slim', '.cache']);

  function filesUnder(dir: string, out: string[]): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        filesUnder(full, out);
      } else if (entry.isFile()) {
        out.push(full);
      }
    }
  }

  it('the production zone id hex never appears in any app/package/e2e source tree', () => {
    const offenders: string[] = [];
    for (const pattern of ['apps/*/src', 'apps/*/test', 'packages/*/src', 'packages/*/test', 'e2e']) {
      const segments = pattern.split('/');
      // Match 'apps/<name>/src' style globs by scanning each top dir's children.
      const top = join(repoRoot, segments[0]!);
      if (!(segments[0] === 'apps' || segments[0] === 'packages')) {
        // e2e — scan directly.
        const dir = join(repoRoot, pattern);
        if (existsSync(dir)) {
          const files: string[] = [];
          filesUnder(dir, files);
          for (const file of files) {
            // The guard's own fixture constants (this file) are not leaks.
            if (file.endsWith('.test.ts')) continue;
            if (readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) offenders.push(relative(repoRoot, file));
          }
        }
        continue;
      }
      for (const child of readdirSync(top, { withFileTypes: true })) {
        if (!child.isDirectory()) continue;
        const dir = join(top, child.name, segments[2]!);
        if (!existsSync(dir)) continue;
        const files: string[] = [];
        filesUnder(dir, files);
        for (const file of files) {
          if (file.endsWith('.test.ts')) continue;
          if (readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) offenders.push(relative(repoRoot, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the zone id appears only in repo-level configuration (.github, root .env.example, the local .env)', () => {
    const offenders: string[] = [];
    const files: string[] = [];
    filesUnder(repoRoot, files);
    for (const file of files) {
      const rel = relative(repoRoot, file);
      if (file.endsWith('.test.ts')) continue; // guard fixtures are not leaks
      if (!readFileSync(file, 'utf8').includes(ZONE_ID_HEX)) continue;
      // docs/ legitimately quotes the production config (the plan's report
      // requirement); the guard's target is app/package/e2e source and tests.
      // The root `.env` is the developer's own git-ignored copy of `.env.example`.
      const allowed =
        rel.startsWith('.github') || rel === '.env.example' || rel === '.env' || rel.startsWith('docs');
      if (!allowed) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the Cloudflare token value/variable are referenced only at the env + server assembly site', () => {
    const files: string[] = [];
    filesUnder(apiSrcRoot, files);
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue; // tests necessarily drive the env var
      const rel = relative(apiSrcRoot, file);
      const allowed = rel === 'env.ts' || rel === 'server.ts';
      const text = readFileSync(file, 'utf8');
      if (text.includes('cloudflareZoneApiToken') || text.includes('CLOUDFLARE_ZONE_EDIT_API_TOKEN')) {
        if (!allowed) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('probeHttps is only ever fed hostnames from machine state, never request bodies', () => {
    const offenders: string[] = [];
    const files: string[] = [];
    filesUnder(apiSrcRoot, files);
    for (const file of files) {
      if (file.endsWith('.test.ts')) continue;
      const rel = relative(apiSrcRoot, file);
      const text = readFileSync(file, 'utf8');
      if (!text.includes('.probeHttps(')) continue;
      if (rel === 'domains.ts') {
        // The custom-domain machine probes its own stored hostname.
        if (!text.includes('probeHttps(domain.hostname)')) offenders.push(rel);
        continue;
      }
      if (rel === 'default-https.ts') {
        // The default-HTTPS machine probes its own stored state hostname.
        if (!text.includes('probeHttps(working.hostname)')) offenders.push(rel);
        continue;
      }
      if (rel === 'server.ts') {
        // server.ts only forwards the seam for assembly (fixture/legacy/cloudflare
        // modes); a request-body or query value must never be probed.
        const bad = text.split('\n').some((line) => {
          if (!line.includes('.probeHttps(')) return false;
          return /request\.body|body\.|params\.|query\.|\.hostname\s*\)/.test(line);
        });
        if (bad) offenders.push(rel);
        continue;
      }
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});

// Phase 15 — static verification of the Cloudflare deploy configuration.
// Pure text scans of .github/workflows/deploy-api.yml: no network, no
// provider call, and no secret value is ever read or printed (the token is
// asserted only as the `${{ secrets.… }}` expression the workflow itself
// carries). Every environment-specific value is a variable on the GitHub
// Environment of the deploy job, so the workflow holds a key name, never a
// stage's own value.
describe('Phase 15 — Cloudflare deploy configuration', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const workflowPath = join(repoRoot, '.github', 'workflows', 'deploy-api.yml');
  // Normalise line endings — the file is checked out CRLF on Windows.
  const workflow = readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
  const ZONE_ID_HEX = 'bf69c0d8524ef2c5cfbc6e5d33fb7cae';
  const CLOUDFLARE_KEYS = [
    'CLOUDFLARE_ZONE_ID',
    'CLOUDFLARE_ZONE_NAME',
    'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX',
    'CLOUDFLARE_ZONE_EDIT_API_TOKEN',
  ];

  it('the Lambda env block binds all four Cloudflare keys to the GitHub Environment', () => {
    const envStart = workflow.indexOf('\n    env:\n');
    const envEnd = workflow.indexOf('\n    steps:\n', envStart);
    expect(envStart, 'could not locate the job-level env: block').toBeGreaterThan(-1);
    expect(envEnd, 'could not locate the steps: block after env:').toBeGreaterThan(envStart);
    const envBlock = workflow.slice(envStart, envEnd);

    expect(envBlock).toContain('CLOUDFLARE_ZONE_ID: ${{ vars.CLOUDFLARE_ZONE_ID }}');
    expect(envBlock).toContain('CLOUDFLARE_ZONE_NAME: ${{ vars.CLOUDFLARE_ZONE_NAME }}');
    expect(envBlock).toContain(
      'DEPLOYZ_DEFAULT_HOSTNAME_PREFIX: ${{ vars.DEPLOYZ_DEFAULT_HOSTNAME_PREFIX }}',
    );
    expect(envBlock).toContain('CLOUDFLARE_ZONE_EDIT_API_TOKEN: ${{ secrets.CLOUDFLARE_ZONE_EDIT_API_TOKEN }}');
  });

  // A literal here is what the Environment work removes: the same file
  // deploys every stage now, so a production host or zone id left in the
  // block would reach a staging deploy. Read with the comments removed: a
  // comment holds no value, and a comment that names the host which goes
  // offline is worth keeping.
  it('the deployed-env block carries no environment-specific literal', () => {
    const envStart = workflow.indexOf('\n    env:\n');
    const envEnd = workflow.indexOf('\n    steps:\n', envStart);
    expect(envStart, 'could not locate the job-level env: block').toBeGreaterThan(-1);
    expect(envEnd, 'could not locate the steps: block after env:').toBeGreaterThan(envStart);
    const envValues = workflow.slice(envStart, envEnd).replace(/^\s*#.*$/gm, '');

    for (const literal of [ZONE_ID_HEX, 'api.deployz.dev', 'app.deployz.dev', '.deployz.dev', 'deployz.dev']) {
      expect(envValues, `the env block must not carry the literal ${literal}`).not.toContain(literal);
    }
    expect(envValues).not.toMatch(/DEPLOYZ_DEFAULT_HOSTNAME_PREFIX:\s*d-/);
  });

  it('the deploy completeness-gate loop lists all four Cloudflare keys (a missing binding fails the deploy)', () => {
    // The gate is a `for key in …; do` loop; find the occurrence that carries
    // the Cloudflare keys.
    const loops = [...workflow.matchAll(/for key in ([\s\S]*?); do/g)];
    const completeness = loops.find((match) => match[1]!.includes('CLOUDFLARE_ZONE_EDIT_API_TOKEN'));
    expect(completeness, 'could not locate the completeness-gate key loop').toBeDefined();
    const loopBody = completeness![1]!;
    for (const key of CLOUDFLARE_KEYS) {
      expect(loopBody, `completeness gate must list ${key}`).toContain(key);
    }
  });
});

// The relay that drives every install ships INSIDE the bootstrap template's
// Lambda assets, and each region serves its own copy from
// `deployz-templates-<region>`. Nothing republished those: the regional
// buckets were published once by hand and then left, so every region except
// us-east-1 ran relay code older than the deployed control plane and silently
// missed relay fixes. Tying the published set to DEPLOYABLE_AWS_REGIONS — the
// list the API is willing to hand out install links for — is what keeps
// "advertised as deployable" and "artifacts match the deployed relay" from
// drifting apart again.
describe('the deploy republishes bootstrap artifacts to every deployable region', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const workflow = readFileSync(
    join(repoRoot, '.github', 'workflows', 'deploy-api.yml'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  it('runs publish:bootstrap as a deploy step, not only in a comment', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    expect(steps).toMatch(/run:[\s\S]*?publish:bootstrap/);
  });

  // The publisher needs s3:GetBucketLocation, s3:PutObject, s3:GetObject and
  // cloudformation:ValidateTemplate across every regional bucket, and the
  // deploy role grants them (.github/aws/github-oidc.yaml). Ungated, the step
  // failed every deploy after the stack had already gone out. The switch is
  // what lets the permissions land first and the invariant be turned on
  // deliberately.
  it('runs only when BOOTSTRAP_REPUBLISH is switched on', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    const start = steps.indexOf('- name: Republish the bootstrap template');
    expect(start, 'could not locate the republish step').toBeGreaterThan(-1);
    const step = steps.slice(start, steps.indexOf('\n      - name:', start + 1));

    expect(step).toMatch(/if:[^\n]*vars\.BOOTSTRAP_REPUBLISH/);
  });

  // Publishing artifacts must never decide whether the API that just went out
  // gets checked: the first ungated run failed here and skipped that step
  // entirely, which is how a broken deploy could pass unnoticed.
  it('runs after the deployed API has been verified', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    const verify = steps.indexOf('- name: Verify the deployed API answers');
    const republish = steps.indexOf('- name: Republish the bootstrap template');

    expect(verify, 'could not locate the API verification step').toBeGreaterThan(-1);
    expect(republish).toBeGreaterThan(verify);
  });

  // resolveBucket (publish-bootstrap.mjs) otherwise falls back to
  // cloudformation:ListExports, which the deploy user is not allowed to call —
  // the first run of this step died on exactly that, after the stack had
  // already deployed. Handing it the bucket keeps the publish off that API.
  it('sets TEMPLATE_BUCKET, so the publish never calls cloudformation:ListExports', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    const start = steps.indexOf('- name: Republish the bootstrap template');
    expect(start, 'could not locate the republish step').toBeGreaterThan(-1);
    const step = steps.slice(start, steps.indexOf('\n      - name:', start + 1));

    expect(step).toContain('TEMPLATE_BUCKET');
    // Derived from the URL the API already hands out, not a second copy of the
    // bucket name that can drift away from it.
    expect(step).toContain('BOOTSTRAP_TEMPLATE_URL');
  });

  // The API must only learn a build id whose versioned template gets
  // published in the same run, or the connector update link would be dead.
  it('computes the connector build id only when the republish is on, before the stack deploys', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    const start = steps.indexOf('- name: Compute the connector build id');
    expect(start, 'could not locate the build id step').toBeGreaterThan(-1);
    const step = steps.slice(start, steps.indexOf('\n      - name:', start + 1));

    expect(step).toMatch(/if:[^\n]*vars\.BOOTSTRAP_REPUBLISH == 'on'/);
    expect(step).toContain('BOOTSTRAP_BUILD_ID');
    expect(step).toContain('GITHUB_ENV');
    expect(start).toBeLessThan(steps.indexOf('- name: Deploy the control-plane stack'));
  });

  it('publishes exactly the regions DEPLOYABLE_AWS_REGIONS advertises', () => {
    const steps = workflow.slice(workflow.indexOf('\n    steps:\n'));
    expect(steps).toContain('BOOTSTRAP_PUBLISH_REGIONS');
    // The published set is derived from the advertised set rather than
    // hardcoded — a region added to the variable must not need a second edit
    // here to actually get current artifacts.
    expect(steps).toMatch(/BOOTSTRAP_PUBLISH_REGIONS[^\n]*DEPLOYABLE_AWS_REGIONS/);
  });
});

describe('SES credentials', () => {
  let tempDir: string;
  const SES_VARS = ['AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY'];

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-ses-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    for (const key of SES_VARS) delete process.env[key];
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of SES_VARS) delete process.env[key];
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Production had a trailing newline in the access key id, which made every
  // SES request fail with ERR_INVALID_CHAR in the authorization header.
  it('trims surrounding whitespace from both keys', async () => {
    process.env.AWS_SES_ACCESS_KEY_ID = 'AKIATESTKEY\n';
    process.env.AWS_SES_SECRET_ACCESS_KEY = ' secret-value ';

    const { env } = await import('./env.js');
    expect(env.sesAccessKeyId).toBe('AKIATESTKEY');
    expect(env.sesSecretAccessKey).toBe('secret-value');
  });

  it('treats an empty or blank key as unset', async () => {
    process.env.AWS_SES_ACCESS_KEY_ID = '\n';

    const { env } = await import('./env.js');
    expect(env.sesAccessKeyId).toBeUndefined();
    expect(env.sesSecretAccessKey).toBeUndefined();
  });
});

describe('Lambda startup guards', () => {
  let tempDir: string;
  const KEYS = ['AWS_LAMBDA_FUNCTION_NAME', 'BETTER_AUTH_SECRET', 'GITHUB_FIXTURE_MODE', 'EMAIL_VERIFICATION_FIXTURE_MODE'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deployz-env-lambda-'));
    vi.spyOn(process, 'cwd').mockReturnValue(tempDir);
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refuses to start on Lambda without BETTER_AUTH_SECRET', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'deployz-api';
    await expect(import('./env.js')).rejects.toThrow('BETTER_AUTH_SECRET');
  });

  it('refuses to start on Lambda with a fixture mode on', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'deployz-api';
    process.env.BETTER_AUTH_SECRET = 'a-real-secret';
    process.env.EMAIL_VERIFICATION_FIXTURE_MODE = 'true';
    await expect(import('./env.js')).rejects.toThrow('EMAIL_VERIFICATION_FIXTURE_MODE');
  });

  it('starts on Lambda with the secret and no fixture mode, and starts off Lambda without a secret', async () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = 'deployz-api';
    process.env.BETTER_AUTH_SECRET = 'a-real-secret';
    await expect(import('./env.js')).resolves.toBeDefined();
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    delete process.env.BETTER_AUTH_SECRET;
    vi.resetModules();
    await expect(import('./env.js')).resolves.toBeDefined();
  });
});
