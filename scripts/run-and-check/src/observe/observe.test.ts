import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { observationSchema } from '../contract.js';
import { collectCandidates } from './candidates.js';
import { observe } from './observe.js';
import { buildObservationManifest } from './observation-manifest.js';
import { runOnce } from './run-once.js';
import { finalPath, partialPath, recipeHash, writeObservation } from './store.js';
import { SECRET, makeAnalysis, makeFake, makeRecipe, type FakeOptions } from './test-support.js';

async function setup(options: FakeOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'observe-'));
  const fake = makeFake(options);
  const recipe = makeRecipe();
  const analyses = [makeAnalysis()];
  const run = (force = false) =>
    observe(recipe, fake.deps, {
      force,
      observationsDir: join(dir, 'observations'),
      runsDir: join(dir, 'runs'),
      analyses,
      harnessVersion: '1',
    });
  return { dir, fake, recipe, analyses, run };
}

describe('observe', () => {
  it('runs the candidate migration before a second web start when the start alone is not healthy', async () => {
    const { run } = await setup({ needsMigration: true });
    const result = await run();
    const first = result.runs[0]!;
    expect(first.webHealthy.value).toBe(true);
    expect(first.startupMigration.value?.tablesCreatedByStart).toBe(false);
    expect(first.webHealthy.evidence.some((item) => item.source === 'migration#1')).toBe(true);
  });

  it('assembles every fact of two runs from the application behaviour', async () => {
    const { dir, fake, run } = await setup();
    const result = await run();

    expect(result.complete).toBe(true);
    expect(result.unstable).toEqual([]);
    expect(result.runs).toHaveLength(2);
    expect(fake.calls.builds).toBe(2);
    const [first] = result.runs;
    if (first === undefined) throw new Error('no run');

    expect(first.build).toMatchObject({ status: 'observed', arch: 'amd64-emulated', value: { ok: true, fromCache: false } });
    expect(result.runs[1]?.build.value?.fromCache).toBe(true);
    expect(first.webHealthy.value).toBe(true);
    expect(first.listeningPorts.value).toEqual([{ port: 8080, bind: 'all', reachableFromProbe: true }]);
    expect(first.httpPaths.value).toContainEqual({ port: 8080, path: '/healthz', status: 200 });
    expect(first.httpPaths.value).toContainEqual({ port: 8080, path: '/', status: 302 });
    expect(first.smoke.value).toEqual({ path: '/', status: 302 });
    expect(first.database.value).toEqual({ engine: 'postgres', connections: 1, tablesAfterStart: ['users'], sqliteFileWritten: true });
    expect(first.startupMigration.value).toEqual({ tablesCreatedByStart: true, secondStartHealthy: true });
    expect(first.migrationCommands.value).toEqual([{ command: 'npm run migrate', exitCode: 0, createdTables: true, seconds: 3 }]);
    expect(first.redis.value).toEqual({ connected: true, clients: 1 });
    expect(first.objectStorage.value).toEqual({ objectsWritten: 0 });
    expect(first.localDiskWrites.value).toEqual(['/app/data.sqlite']);
    expect(first.workers.value).toEqual([
      { command: 'node worker.js', stayedRunning: true, exitCode: null, restarts: 0, queueActivity: true },
    ]);
    expect(first.requiredVariables.value).toEqual([{ name: 'SECRET_KEY', healthyWithout: false, healthyWith: true }]);
    expect(first.twoCopiesHealthy.value).toBe(true);
    expect(first.restartHealthy.value).toBe(true);
    expect(first.sizes.value).toEqual([{ profile: 'small-v2', memoryMiB: 512, cpus: 1, healthy: true, startSeconds: 5, oomKilled: false }]);
    expect(first.candidates.from).toEqual(['analysis:rules@x', 'fixed-list']);
    expect(first.infrastructureFailures).toEqual([]);
    expect(Object.keys(first.timings)).toEqual(expect.arrayContaining(['build', 'setA', 'migrations', 'twoCopies', 'requiredVariables']));

    const written = await readFile(finalPath(join(dir, 'observations'), 'repo-001'), 'utf8');
    expect(written.endsWith('}\n')).toBe(true);
    expect(observationSchema.parse(JSON.parse(written))).toEqual(result);
  });

  it('never stores a secret value', async () => {
    const { dir, run } = await setup();
    await run();
    const written = await readFile(finalPath(join(dir, 'observations'), 'repo-001'), 'utf8');
    expect(written).not.toContain(SECRET);
    expect(written).toContain('***');
  });

  it('skips a complete observation unless force is set', async () => {
    const { fake, run } = await setup();
    await run();
    await run();
    expect(fake.calls.builds).toBe(2);
    await run(true);
    expect(fake.calls.builds).toBe(4);
  });

  it('observes again when the recipe changed', async () => {
    const { dir, fake, run } = await setup();
    await run();
    const changed = makeRecipe({ databaseEngine: 'mysql' });
    await observe(changed, fake.deps, {
      force: false,
      observationsDir: join(dir, 'observations'),
      runsDir: join(dir, 'runs'),
      analyses: [],
      harnessVersion: '1',
    });
    expect(fake.calls.builds).toBe(4);
  });

  it('resumes from a partial file that holds run 1', async () => {
    const { dir, fake, recipe, analyses, run } = await setup();
    const first = await runOnce({
      recipe,
      deps: fake.deps,
      manifest: buildObservationManifest(recipe, analyses),
      candidates: collectCandidates(recipe, analyses),
      runIndex: 1,
      runsDir: join(dir, 'runs'),
      harnessVersion: '1',
    });
    expect(fake.calls.builds).toBe(1);
    await writeObservation(partialPath(join(dir, 'runs'), 'repo-001'), {
      schemaVersion: 1,
      id: 'repo-001',
      set: 'tuning',
      repository: 'o/r',
      commit: 'a'.repeat(40),
      recipeHash: recipeHash(recipe),
      imageDigest: null,
      runs: [first],
      unstable: [],
      complete: false,
    });

    const result = await run();
    expect(fake.calls.builds).toBe(2);
    expect(result.runs).toHaveLength(2);
    expect(result.runs[0]).toEqual(first);
    expect(result.complete).toBe(true);
  });

  it('marks a fact unstable when the two runs disagree and adds the medium-v1 row after an out-of-memory exit', async () => {
    const { run } = await setup({ breakFromBuild: 2 });
    const result = await run();
    const second = result.runs[1];
    expect(second?.webHealthy.value).toBe(false);
    expect(second?.twoCopiesHealthy).toMatchObject({ status: 'not_run', note: 'web was not healthy' });
    expect(second?.restartHealthy.status).toBe('not_run');
    expect(second?.sizes.value).toEqual([
      { profile: 'small-v2', memoryMiB: 512, cpus: 1, healthy: false, startSeconds: null, oomKilled: true },
      { profile: 'medium-v1', memoryMiB: 2048, cpus: 1, healthy: true, startSeconds: 5, oomKilled: false },
    ]);
    expect(result.unstable).toEqual(
      expect.arrayContaining(['webHealthy', 'listeningPorts', 'twoCopiesHealthy', 'restartHealthy', 'requiredVariables', 'sizes']),
    );
  });

  it('records a failed build as not_run facts and does not repeat the build', async () => {
    const { fake, run } = await setup({ buildFails: true });
    const result = await run();
    expect(fake.calls.builds).toBe(1);
    expect(result.runs).toHaveLength(1);
    expect(result.complete).toBe(true);
    const [only] = result.runs;
    expect(only?.build).toMatchObject({ status: 'observed', value: { ok: false, failure: 'dockerfile' } });
    expect(only?.webHealthy).toMatchObject({ status: 'not_run', note: 'build failed' });
    expect(only?.sizes).toMatchObject({ status: 'not_run', note: 'build failed' });
  });

  it('retries a service set that did not start once', async () => {
    const { run } = await setup({ failServiceStarts: 1 });
    const result = await run();
    expect(result.runs[0]?.infrastructureFailures).toEqual([]);
    expect(result.runs[0]?.webHealthy.value).toBe(true);
  });

  it('lists a step that failed twice as an infrastructure failure and lets other steps continue', async () => {
    const { run } = await setup({ alwaysFailLabel: '-a' });
    const result = await run();
    const [first] = result.runs;
    expect(first?.infrastructureFailures).toEqual([expect.stringContaining('service set A: service set a did not start')]);
    expect(first?.webHealthy.status).toBe('error');
    expect(first?.database.status).toBe('error');
    expect(first?.migrationCommands.value).toHaveLength(1);
    expect(first?.sizes.status).toBe('error');
    expect(result.unstable).toEqual([]);
  });

  it('tests at most six variables and records the cap', async () => {
    const { dir, fake } = await setup();
    const names = Array.from({ length: 8 }, (_, index) => `VAR_${index}`);
    const many = makeRecipe({ vendorInputs: names.map((name) => ({ name, source: { kind: 'fixed', value: 'x' } })) });
    const result = await observe(many, fake.deps, {
      force: true,
      observationsDir: join(dir, 'observations'),
      runsDir: join(dir, 'runs'),
      analyses: [],
      harnessVersion: '1',
    });
    const variables = result.runs[0]?.requiredVariables;
    expect(variables?.value).toHaveLength(6);
    expect(variables?.note).toContain('6 of 8');
  });
});
