import { describe, expect, it } from 'vitest';

import { claimChanges } from './stability.js';
import { makeAnalysis, makeManifest } from './test-support.js';

describe('claimChanges', () => {
  it('finds no change between two identical analyses', () => {
    expect(claimChanges(makeAnalysis(makeManifest()), makeAnalysis(makeManifest()))).toEqual([]);
  });

  it('reports each claim that differs, with both values', () => {
    const a = makeAnalysis(makeManifest());
    const b = makeAnalysis(makeManifest({ web: { command: 'node server.js', port: 3000 }, redis: { required: true, envBindings: [] } }));
    expect(claimChanges(a, b)).toEqual([
      { id: 'repo-001', claim: 'web.port', a: '8080', b: '3000' },
      { id: 'repo-001', claim: 'redis.required', a: 'false', b: 'true' },
    ]);
  });

  it('reports a failed analysis as a change of status', () => {
    const failed = makeAnalysis(makeManifest(), undefined, { status: 'failed', manifest: null, gate: null });
    expect(claimChanges(makeAnalysis(makeManifest()), failed)).toContainEqual({ id: 'repo-001', claim: 'status', a: 'analysed', b: 'failed' });
  });

  it('refuses two analyses of different commits', () => {
    expect(() => claimChanges(makeAnalysis(makeManifest()), makeAnalysis(makeManifest(), undefined, { commit: 'b'.repeat(40) }))).toThrow(/different commits/);
  });
});
