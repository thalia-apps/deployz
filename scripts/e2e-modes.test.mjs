import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

// Guards for scripts/e2e.mjs (docs/testing/simulated-e2e.md D3). Runs the
// runner as a child process rather than importing it, so the process-exit /
// stdout-stream behaviour under test is exercised directly. No browser
// needed — this only spawns Node. Moved here from e2e/e2e-modes.spec.ts (a
// Playwright spec that never opened a browser) so it runs under
// `pnpm test:static`, not the Playwright suite.

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'e2e.mjs');
const REFUSAL = 'Real AWS E2E is disabled.';

function runCli(args, envOverrides = {}) {
  const env = { ...process.env, ...envOverrides };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8', env });
}

test('fresh mode refuses without the real-AWS opt-in', () => {
  const result = runCli(['--mode=fresh', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: undefined });
  assert.notEqual(result.status, 0);
  assert.ok((result.stdout + result.stderr).includes(REFUSAL));
});

test('fresh mode with the opt-in set reports the vitest command', () => {
  const result = runCli(['--mode=fresh', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' });
  assert.ok(!(result.stdout + result.stderr).includes(REFUSAL));
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.mode, 'fresh');
  assert.equal(parsed.command, 'pnpm');
  assert.ok(parsed.args.includes('test/fresh-e2e.live.test.ts'));
});

test('default (simulated) mode dry-run reports mode simulated', () => {
  const result = runCli(['--dry-run']);
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.mode, 'simulated');
});

test('simulated mode dry-run scrubs AWS credentials from the child env', () => {
  const result = runCli(['--dry-run'], { AWS_ACCESS_KEY_ID: 'dummy' });
  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.ok(parsed.scrubbedVars.includes('AWS_ACCESS_KEY_ID'));
});

test('scrubbing sets the variables to empty strings so a parent .env cannot fill them', async () => {
  const { scrubEnv } = await import('./e2e-env.mjs');
  const { env } = scrubEnv({ EMAIL_FROM: 'ops@example.com' });
  assert.equal(env.EMAIL_FROM, '');
  assert.equal(env.AWS_SES_SECRET_ACCESS_KEY, '');
});

test('an unknown mode exits non-zero', () => {
  const result = runCli(['--mode=bogus', '--dry-run']);
  assert.notEqual(result.status, 0);
});

test('the retired read-only canary mode is no longer a valid mode', () => {
  const result = runCli(['--mode=canary', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: '1' });
  assert.notEqual(result.status, 0);
  assert.ok((result.stdout + result.stderr).includes('Unknown mode "canary"'));
});

test('canary-versions mode refuses without the real-AWS opt-in, with --dry-run', () => {
  const result = runCli(['--mode=canary-versions', '--dry-run'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: undefined });
  assert.notEqual(result.status, 0);
  assert.ok((result.stdout + result.stderr).includes(REFUSAL));
});

test('canary-versions mode refuses without the real-AWS opt-in, without --dry-run (dry-run is not a way to peek at a real-AWS run)', () => {
  const result = runCli(['--mode=canary-versions', 'preflight'], { DEPLOYZ_E2E_ALLOW_REAL_AWS: undefined });
  assert.notEqual(result.status, 0);
  assert.ok((result.stdout + result.stderr).includes(REFUSAL));
});
