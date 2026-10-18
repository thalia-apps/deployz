import { deploymentManifestSchema } from '@deployz/contracts';
import { describe, expect, it } from 'vitest';

import { buildObservationManifest } from './observation-manifest.js';
import { makeAnalysis, makeRecipe } from './test-support.js';

describe('buildObservationManifest', () => {
  it('builds a valid manifest with every service on when there is no Analysis', () => {
    const manifest = buildObservationManifest(makeRecipe(), []);
    expect(deploymentManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.database).toMatchObject({ postgres: true, engine: 'postgres' });
    expect(manifest.redis.required).toBe(true);
    expect(manifest.storage.required).toBe(true);
    expect(manifest.web).toEqual({ command: null, port: 18080 });
    expect(manifest.health.path).toBe('/');
  });

  it('uses the recipe database engine', () => {
    expect(buildObservationManifest(makeRecipe({ databaseEngine: 'mysql' }), []).database.engine).toBe('mysql');
  });

  it('merges the bindings, variables and commands of all analyses', () => {
    const other = makeAnalysis({ analyser: 'ai@y' });
    if (other.manifest === null) throw new Error('test setup');
    other.manifest.redis.envBindings = [
      { name: 'REDIS_HOST', kind: 'host' },
      { name: 'REDIS_URL', kind: 'url' },
    ];
    other.manifest.environment.variables.push({ key: 'EXTRA', required: false, secret: false, source: [] });
    const manifest = buildObservationManifest(makeRecipe(), [makeAnalysis(), other]);
    expect(manifest.redis.envBindings.map((b) => b.name)).toEqual(['REDIS_URL', 'REDIS_HOST']);
    expect(manifest.database.envBindings?.map((b) => b.name)).toEqual(['DATABASE_URL']);
    expect(manifest.environment.variables.map((v) => v.key)).toEqual(['SECRET_KEY', 'DATABASE_URL', 'LOG_LEVEL', 'EXTRA']);
    expect(manifest.web).toEqual({ command: null, port: 18080 });
    expect(manifest.migration.command).toBe('npm run migrate');
    expect(manifest.worker.command).toBe('node worker.js');
  });
});
