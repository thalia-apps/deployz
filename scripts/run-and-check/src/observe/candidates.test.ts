import { describe, expect, it } from 'vitest';

import { FIXED_HEALTH_PATHS, collectCandidates } from './candidates.js';
import { makeAnalysis, makeRecipe } from './test-support.js';

describe('collectCandidates', () => {
  it('uses the fixed lists when there is no Analysis', () => {
    const candidates = collectCandidates(makeRecipe(), []);
    expect(candidates.healthPaths).toEqual(['/', ...FIXED_HEALTH_PATHS]);
    expect(candidates.ports).toEqual([18080, 8080, 3000, 80]);
    expect(candidates.migrationCommands).toEqual([]);
    expect(candidates.workerCommands).toEqual([]);
    expect(candidates.from).toEqual(['fixed-list']);
  });

  it('adds analysed values and recipe inputs, without duplicates', () => {
    const recipe = makeRecipe({ vendorInputs: [{ name: 'ADMIN_EMAIL', source: { kind: 'fixed', value: 'a@b.c' } }] });
    const candidates = collectCandidates(recipe, [makeAnalysis(), makeAnalysis({ analyser: 'ai@y' })]);
    expect(candidates.healthPaths).toEqual(['/', '/healthz', ...FIXED_HEALTH_PATHS.filter((path) => path !== '/healthz')]);
    expect(candidates.ports).toEqual([18080, 4000, 8080, 3000, 80]);
    expect(candidates.migrationCommands).toEqual(['npm run migrate']);
    expect(candidates.workerCommands).toEqual(['node worker.js']);
    expect(candidates.variables).toEqual(['ADMIN_EMAIL', 'SECRET_KEY']);
    expect(candidates.from).toEqual(['recipe', 'analysis:rules@x', 'analysis:ai@y', 'fixed-list']);
  });

  it('ignores failed analyses that have no manifest', () => {
    const candidates = collectCandidates(makeRecipe(), [makeAnalysis({ status: 'failed', manifest: null })]);
    expect(candidates.ports).toEqual([18080, 8080, 3000, 80]);
    expect(candidates.from).toEqual(['fixed-list']);
  });
});
