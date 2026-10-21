import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

const PG_PREFIX = "const { Pool } = require('pg');\n";

function appTree(overrides: Record<string, string | undefined>): FileTree {
  const tree: Record<string, string | undefined> = {
    Dockerfile: [
      'FROM node:20-alpine',
      'EXPOSE 3000',
      'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "src/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node src/index.js' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.js': 'app.listen(process.env.PORT || 3000);\n',
    'docker-compose.yml': 'services:\n  app:\n    build: .\n  db:\n    image: postgres:16\n',
    ...overrides,
  };
  return Object.fromEntries(Object.entries(tree).filter(([, content]) => content !== undefined)) as FileTree;
}

function manifestFor(tree: FileTree) {
  return normalizeDeploymentManifest(analyseRepo(tree), {});
}

describe('database.connectionUnverified', () => {
  it('is set when the app reads its database connection only under a name analysis cannot see', () => {
    const manifest = manifestFor(appTree({ 'src/db.js': PG_PREFIX + 'const pool = new Pool(config.get("database"));\n' }));
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.connectionUnverified).toBe(true);
    const readiness = evaluateManifestReadiness(manifest);
    expect(readiness.state).toBe('NEEDS_CONFIGURATION');
    expect(readiness.findings).toContainEqual(
      expect.objectContaining({ id: 'database-connection-unverified', category: 'database', severity: 'error' }),
    );
  });

  it('is not set when the app reads DATABASE_URL', () => {
    const manifest = manifestFor(
      appTree({ 'src/db.js': PG_PREFIX + 'new Pool({ connectionString: process.env.DATABASE_URL });\n' }),
    );
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
    expect(evaluateManifestReadiness(manifest).findings.map((finding) => finding.id)).not.toContain(
      'database-connection-unverified',
    );
  });

  it('is not set when the app reads a detected alias', () => {
    const manifest = manifestFor(
      appTree({
        'src/db.js': PG_PREFIX + 'function makePool(dsn) {\n  return new Pool({ connectionString: dsn });\n}\nmakePool(process.env.MEMOS_DSN);\n',
      }),
    );
    expect(manifest.database.envBindings).toContainEqual({ name: 'MEMOS_DSN', kind: 'url' });
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });

  it('is not set when a sample file declares a standard name', () => {
    const manifest = manifestFor(appTree({ '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n' }));
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });

  it('is not set without a managed database', () => {
    const manifest = manifestFor(appTree({ 'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4' } }) }));
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });
});

describe('database guard: a standard name written in runtime source', () => {
  it('does not ask when a Go config switch names DATABASE_URL', () => {
    const tree = {
      'go.mod': 'module example.com/app\n\nrequire github.com/lib/pq v1.10.9\n',
      'Dockerfile': 'FROM golang:1.22\nCOPY . .\nRUN go build -o /app\nEXPOSE 8080\nCMD ["/app"]\n',
      'internal/config/parser.go': 'package config\n\nimport _ "github.com/lib/pq"\n\nfunc parse(key, value string) {\n\tswitch key {\n\tcase "DATABASE_URL":\n\t\tdatabaseURL = value\n\t}\n}\n',
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['databaseNamesMentioned']).toContain('DATABASE_URL');
  });

  it('does not ask when an env enum names the DB_* parts that Deployz injects', () => {
    const manifest = manifestFor(
      appTree({
        'src/db.js': PG_PREFIX + 'const pool = new Pool(config.get("database"));\n',
        'src/env-vars.js': "export const EnvVars = { DB_HOST: 'DB_HOST', DB_NAME: 'DB_NAME', DB_USER: 'DB_USER', DB_PASSWORD: 'DB_PASSWORD' };\n",
      }),
    );
    expect(manifest.database.envBindings).toContainEqual({ name: 'DB_HOST', kind: 'host' });
    expect(manifest.database).not.toHaveProperty('connectionUnverified');
  });
});
