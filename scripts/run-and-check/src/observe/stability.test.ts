import { describe, expect, it } from 'vitest';

import type { ObservationRun } from '../contract.js';
import { collectCandidates } from './candidates.js';
import { buildObservationManifest } from './observation-manifest.js';
import { runOnce } from './run-once.js';
import { findUnstable, statusClass } from './stability.js';
import { makeAnalysis, makeFake, makeRecipe } from './test-support.js';

async function sampleRun(): Promise<ObservationRun> {
  const recipe = makeRecipe();
  const analyses = [makeAnalysis()];
  return runOnce({
    recipe,
    deps: makeFake().deps,
    manifest: buildObservationManifest(recipe, analyses),
    candidates: collectCandidates(recipe, analyses),
    runIndex: 1,
    runsDir: 'runs',
    harnessVersion: '1',
  });
}

describe('statusClass', () => {
  it('groups HTTP statuses', () => {
    expect([200, 204, 302, 404, 503, null, 101].map(statusClass)).toEqual(['2xx', '2xx', '3xx', '4xx', '5xx', 'none', 'other']);
  });
});

describe('findUnstable', () => {
  it('reports nothing for equal runs and ignores logs and timings', async () => {
    const first = await sampleRun();
    const second = structuredClone(first);
    second.timings = { setA: 999 };
    second.webHealthy.evidence = [];
    expect(findUnstable(first, second)).toEqual([]);
  });

  it('ignores a status that stays in its class and reports one that changes class', async () => {
    const first = await sampleRun();
    const second = structuredClone(first);
    const row = second.httpPaths.value?.find((path) => path.status === 200);
    if (row === undefined) throw new Error('test setup');
    row.status = 204;
    expect(findUnstable(first, second)).toEqual([]);
    row.status = 500;
    expect(findUnstable(first, second)).toEqual(['httpPaths']);
  });

  it('reports changed decision values in the order of the contract', async () => {
    const first = await sampleRun();
    const second = structuredClone(first);
    const redis = second.redis.value;
    const worker = second.workers.value?.[0];
    const variable = second.requiredVariables.value?.[0];
    if (!redis || !worker || !variable) throw new Error('test setup');
    redis.connected = false;
    second.webHealthy.value = false;
    worker.stayedRunning = false;
    variable.healthyWithout = true;
    second.twoCopiesHealthy.value = false;
    expect(findUnstable(first, second)).toEqual(['webHealthy', 'redis', 'workers', 'requiredVariables', 'twoCopiesHealthy']);
  });

  it('reports a fact that is observed in one run and failed in the other', async () => {
    const first = await sampleRun();
    const second = structuredClone(first);
    second.database = { status: 'error', value: null, arch: second.database.arch, evidence: [], note: 'inspect failed' };
    expect(findUnstable(first, second)).toEqual(['database']);
  });
});
