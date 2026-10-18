import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fullRunSchema, type AnalysisResultFile } from '../contract.js';
import { productionEnvironment } from './environment.js';
import { fakeDocker, unsafeRunProblems, type FakeDockerOptions } from './fake-docker.js';
import { runFull } from './full.js';
import { createRunner } from './runner.js';
import { fakeServices, manifest, recipe } from './test-support.js';

const labelArgs = (id: string) => ['--label', 'deployz.runcheck=1', '--label', `deployz.runcheck.repo=${id}`];

function analysis(options: Parameters<typeof manifest>[0] = {}, mode?: 'pre_deploy' | 'startup'): AnalysisResultFile {
  const base = manifest({ database: 'postgres', redis: true, storage: true, ...options });
  return {
    id: 'repo-001',
    commit: 'abc',
    analyser: 'rules@test',
    status: 'analysed',
    failure: null,
    manifest: mode === undefined ? base : { ...base, migration: { ...base.migration, mode } },
    gate: null,
    vendorQuestions: 0,
  };
}

let logDir: string;
beforeEach(async () => {
  logDir = await mkdtemp(join(tmpdir(), 'runcheck-full-'));
});
afterEach(async () => {
  await rm(logDir, { recursive: true, force: true });
});

async function run(file: AnalysisResultFile, dockerOptions: FakeDockerOptions = {}, smoke = false) {
  const fake = fakeDocker(dockerOptions);
  const services = fakeServices();
  const result = await runFull({
    analysis: file,
    image: 'deployz-runcheck/repo-001:abc',
    arch: 'amd64-emulated',
    recipe: recipe(smoke ? { smoke: { method: 'POST', path: '/api/items', body: '{}', contentType: 'application/json' } } : {}),
    runner: createRunner({ docker: fake.docker, labelArgs, probeImage: 'probe:1', pollIntervalMs: 1 }),
    services,
    env: productionEnvironment,
    logDir,
    workerWindowMs: 20,
  });
  return { result, fake, services };
}

const runs = (calls: string[][]) => calls.filter((call) => call[0] === 'run' && call.includes('-d'));
const FULL = { workerCommand: 'node worker.js', migrationCommand: 'npm run migrate' };

describe('runFull', () => {
  it('runs migration, web and workers with the analysed settings and a valid result', async () => {
    const { result, fake } = await run(analysis(FULL, 'pre_deploy'), {}, true);
    expect(fullRunSchema.parse(result)).toEqual(result);
    expect(result.migration).toEqual({ command: 'npm run migrate', exitCode: 0 });
    expect(result).toMatchObject({ webHealthy: true, healthPathStatus: 200, smokeStatus: 200, infrastructureFailures: [] });
    expect(result.workers).toEqual([{ command: 'node worker.js', stayedRunning: false, exitCode: null, restarts: 2, queueActivity: null }]);
    expect(result.environmentNames).toEqual(expect.arrayContaining(['DATABASE_URL', 'PORT', 'APP_API_KEY', 'AWS_SECRET_ACCESS_KEY']));
    expect(runs(fake.calls).map((call) => call[call.indexOf('--name') + 1])).toEqual([
      'repo-001-migration',
      'repo-001-web',
      'repo-001-worker-worker',
    ]);
  });

  it('starts every container on the internal network with limits and labels, and removes them at the end', async () => {
    const { fake } = await run(analysis(FULL, 'pre_deploy'));
    const started = runs(fake.calls);
    expect(started).toHaveLength(3);
    for (const call of fake.calls.filter((entry) => entry[0] === 'run')) {
      expect(unsafeRunProblems(call, 'net-repo-001')).toEqual([]);
    }
    for (const call of started) expect(call).toEqual(expect.arrayContaining(['--cpus', '1', '--memory', '512m', '--pids-limit', '512']));
    const removed = fake.calls.filter((call) => call[0] === 'rm').map((call) => call[2]);
    expect(removed).toEqual(expect.arrayContaining(['repo-001-migration', 'repo-001-web', 'repo-001-worker-worker']));
  });

  it('never puts a secret value in the evidence or the log files', async () => {
    const { result, fake, services } = await run(analysis(FULL, 'pre_deploy'));
    const web = fake.environments.get('repo-001-web')!;
    const secrets = [web.get('DATABASE_URL')!, web.get('APP_API_KEY')!, services.postgres.password, services.minio.secretKey];
    const stored = [JSON.stringify(result)];
    for (const file of await readdir(logDir)) stored.push(await readFile(join(logDir, file), 'utf8'));
    expect(stored.join('\n')).toContain('[redacted]');
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(8);
      for (const text of stored) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(result)).not.toContain(web.get('APP_SIGNING_SECRET')!);
  });

  it('does not start the web container after a failed migration', async () => {
    const { result, fake } = await run(analysis(FULL, 'pre_deploy'), { waitExitCode: 1 });
    expect(result.migration).toEqual({ command: 'npm run migrate', exitCode: 1 });
    expect(result.webHealthy).toBe(false);
    expect(runs(fake.calls)).toHaveLength(1);
  });

  it('runs no migration when the application migrates at startup', async () => {
    const { result, fake } = await run(analysis(FULL, 'startup'));
    expect(result.migration).toBeNull();
    expect(runs(fake.calls).map((call) => call[call.indexOf('--name') + 1])).not.toContain('repo-001-migration');
  });

  it('reports a web container that exits as not healthy', async () => {
    const { result } = await run(analysis({ migrationCommand: 'npm run migrate' }, 'pre_deploy'), { exitAfterInspects: 0 });
    expect(result).toMatchObject({ webHealthy: false, healthPathStatus: null, smokeStatus: null });
  });

  it('records a docker failure as an infrastructure failure and still removes the containers', async () => {
    const fake = fakeDocker();
    const failing = async (args: readonly string[]) =>
      args[0] === 'run' && args.includes('repo-001-web')
        ? { exitCode: 125, stdout: '', stderr: 'daemon error', timedOut: false }
        : fake.docker(args);
    const result = await runFull({
      analysis: analysis({}, 'startup'),
      image: 'img',
      arch: 'amd64-emulated',
      recipe: recipe(),
      runner: createRunner({ docker: failing, labelArgs, probeImage: 'probe:1', pollIntervalMs: 1 }),
      services: fakeServices(),
      env: productionEnvironment,
      logDir,
    });
    expect(result.infrastructureFailures).toEqual([expect.stringContaining('daemon error')]);
    expect(result.webHealthy).toBe(false);
  });

  it('needs a manifest', async () => {
    await expect(run({ ...analysis(), manifest: null })).rejects.toThrow('has no manifest');
  });
});
