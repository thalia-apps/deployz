import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';

// A ready Node/Express app: Dockerfile + port + health route + PostgreSQL.
const READY_TREE: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY package*.json ./',
    'RUN npm ci --omit=dev',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: {
      start: 'node dist/index.js',
      build: 'tsc -p tsconfig.json',
      'db:migrate': 'npx drizzle-kit push',
    },
    dependencies: { express: '^4.18.0', pg: '^8.12.0', 'drizzle-orm': '^0.36.0' },
  }),
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/shop\n',
  'src/index.ts': [
    "import express from 'express';",
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
};

describe('normalizeDeploymentManifest', () => {
  it('turns a ready analysis into a validated manifest', () => {
    const analysis = analyseRepo(READY_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.application).toEqual({
      root: '.',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'Dockerfile',
    });
    expect(manifest.web).toEqual({ command: 'CMD: ["node", "dist/index.js"]', port: 3000 });
    expect(manifest.health.path).toBe('/health');
    expect(manifest.database.postgres).toBe(true);
    // The detector records the pattern label; the runnable command arrives
    // as the application's resolved override, never from the label.
    expect(manifest.migration.command).toBeNull();
    expect(manifest.build.command).toBe('tsc -p tsconfig.json');
    expect(manifest.build.context).toBe('.');
    expect(manifest.environment.variables).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'PORT' }),
        expect.objectContaining({ key: 'DATABASE_URL' }),
      ]),
    );
    expect(manifest.unsupported).toEqual([]);
  });

  it('vendor overrides win over detection', () => {
    const analysis = analyseRepo(READY_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {
      appRoot: 'apps/web',
      dockerfilePath: 'apps/web/Dockerfile.prod',
      buildContext: 'apps/web',
      buildCommand: 'pnpm build',
      startCommand: 'pnpm start',
      port: 8080,
      healthPath: '/api/health',
      migrationCommand: 'pnpm db:migrate',
      redisRequired: true,
    });
    expect(manifest.application).toEqual({
      root: 'apps/web',
      runtime: 'node',
      framework: 'express',
      dockerfilePath: 'apps/web/Dockerfile.prod',
    });
    expect(manifest.build).toEqual({ command: 'pnpm build', context: 'apps/web' });
    expect(manifest.web).toEqual({ command: 'pnpm start', port: 8080 });
    expect(manifest.health.path).toBe('/api/health');
    expect(manifest.migration.command).toBe('pnpm db:migrate');
    expect(manifest.redis.required).toBe(true);
  });

  it('derives the app root from a nested Dockerfile path, defaulting the build context to the repo root', () => {
    const analysis = analyseRepo({
      'apps/web/Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      'apps/web/package.json': JSON.stringify({ scripts: { start: 'node index.js' } }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.application.root).toBe('apps/web');
    expect(manifest.application.dockerfilePath).toBe('apps/web/Dockerfile');
    expect(manifest.build.context).toBe('.');
  });

  it('flags unsupported databases and local filesystem', () => {
    const analysis = analyseRepo({
      'package.json': JSON.stringify({ dependencies: { mongoose: '^8.0.0' } }),
      'src/models/user.js': 'const mongoose = require("mongoose");\nmodule.exports = mongoose.model("User", new mongoose.Schema({ name: String }));\n',
      Dockerfile: 'FROM node:20\nVOLUME /data\n',
      'src/index.js': 'const db = require("mongoose");\nfs.writeFileSync("/tmp/x", "y");\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.unsupported.some((r) => r.includes('MongoDB'))).toBe(true);
    expect(manifest.unsupported.some((r) => r.includes('local filesystem'))).toBe(true);
  });

  it('flags a Dockerfile that copies .git as unsupported, so the install gate blocks it (DEPLOY-031)', () => {
    const analysis = analyseRepo({
      'go.mod': 'module example.com/app\n',
      'main.go': 'package main\nfunc main() {}\n',
      Dockerfile: 'FROM golang:1.25 AS build\nWORKDIR /build\nCOPY go.mod ./\nCOPY .git/ .\nRUN make build\nFROM debian:trixie-slim\nCOPY --from=build /build/app /usr/bin/app\nEXPOSE 8081\nENTRYPOINT ["/usr/bin/app"]\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.unsupported.some((r) => r.includes('.git'))).toBe(true);
    expect(evaluateManifestReadiness(manifest).state).toBe('NOT_COMPATIBLE');
  });

  it('carries a declared background worker process as a supported worker workload (Phase 4A)', () => {
    const analysis = analyseRepo({
      ...READY_TREE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js', worker: 'node dist/worker.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
      }),
    });
    // The API resolves the command from package.json scripts and persists it
    // in metadata; overrides carry it for rows analysed before Phase 8.
    const manifest = normalizeDeploymentManifest(analysis, {
      workerCommand: 'node dist/worker.js',
    });
    expect(manifest.worker.command).toBe('node dist/worker.js');
    expect(manifest.workers).toEqual([
      { id: 'worker', command: 'node dist/worker.js', source: 'package.json' },
    ]);
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('worker-like code WITHOUT a start command stays deployable (no unsupported reason)', () => {
    const analysis = analyseRepo({
      ...READY_TREE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.0.0' },
      }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.worker.command).toBeNull();
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('resolves Redis bindings from detected connection env vars', () => {
    const analysis = analyseRepo({
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      '.env.example': 'REDIS_URL=redis://localhost:6379\n',
      'src/index.js': 'import { createClient } from "redis";\ncreateClient();\n',
      'package.json': JSON.stringify({ dependencies: { redis: '^4.0.0' } }),
    });
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.redis.required).toBe(true);
    expect(manifest.redis.envBindings).toEqual([{ name: 'REDIS_URL', kind: 'url' }]);
  });

  // ── Stateless regression (no-PostgreSQL deployments) ──────────────────────

  /** A dockerized web app with a health endpoint, NO PostgreSQL, NO database
   *  env vars, but WITH an unrelated `migrate` script in package.json. A
   *  script named `migrate` must NOT imply PostgreSQL. */
  const STATELESS_TREE: FileTree = {
    'Dockerfile': 'FROM node:20-alpine\nEXPOSE 3000\nHEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1\nCMD ["node", "dist/index.js"]\n',
    'package.json': JSON.stringify({
      name: 'stateless-app',
      scripts: { start: 'node dist/index.js', build: 'tsc', migrate: 'node scripts/migrate-data.js' },
      dependencies: { express: '^4.18.0' },
    }),
    'src/index.ts': "import express from 'express';\nconst app = express();\napp.get('/health', (_req, res) => res.json({ ok: true }));\napp.listen(3000);\n",
    'scripts/migrate-data.js': '// one-time data migration script, no database required\n',
  };

  it('stateless app: postgres not required, database.postgres false, deployable, migrationMode none, no migration command', () => {
    const analysis = analyseRepo(STATELESS_TREE);
    const postgresMeta = analysis.metadata.postgres as { required?: boolean };
    expect(postgresMeta?.required).not.toBe(true);
    expect(analysis.metadata.migrationMode).toBe('none');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.migration.command).toBeNull();
    expect(manifest.migration.mode).toBe('none');
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  // ── Inconsistency guard: migration command without PostgreSQL ─────────────

  it('blocks when a migration command override is set but postgresRequired is false', () => {
    const analysis = analyseRepo(STATELESS_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {
      migrationCommand: 'npm run migrate',
    });
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.migration.command).toBe('npm run migrate');
    // A setting resolves it (a database, or no separate migration): never a rejection.
    expect(manifest.unsupported).toEqual([]);
    const gate = evaluateManifestReadiness(manifest);
    expect(gate.state).toBe('NEEDS_CONFIGURATION');
    expect(gate.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'migration-database-missing' })]));
  });

  it('does NOT fire the guard when postgres is true (existing migration-command-missing warning path unchanged)', () => {
    const analysis = analyseRepo(READY_TREE);
    // READY_TREE has postgres=true, no migrationCommand override
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    // No unsupported reason from the guard
    expect(manifest.unsupported).toEqual([]);
    // The existing warning still fires
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('READY');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'migration-command-missing' })]),
    );
  });

  it('does NOT fire the guard for postgres=false with no migration command override', () => {
    const analysis = analyseRepo(STATELESS_TREE);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.migration.command).toBeNull();
    expect(manifest.unsupported).toEqual([]);
  });
});

describe('evaluateManifestReadiness', () => {
  it('returns READY for a deployable manifest', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(READY_TREE), {});
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');
  });

  it('returns NOT_COMPATIBLE for an unsupported app, and blocks regardless of other fields', () => {
    const analysis = analyseRepo({
      'package.json': JSON.stringify({
        scripts: { start: 'node index.js' },
        dependencies: { mongoose: '^7.0.0' },
      }),
      'Dockerfile': 'FROM node:20-alpine\nCMD ["node", "index.js"]\n',
      'src/index.js': 'const mongoose = require("mongoose");\nconst User = mongoose.model("User", new mongoose.Schema({}));\n',
    });
    const manifest = normalizeDeploymentManifest(analysis, { port: 3000 });
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('NOT_COMPATIBLE');
    const errors = result.findings.filter((f) => f.severity === 'error');
    // The unsupported DB blocks; the missing health evidence is also an error
    // (no silent /health default) but never changes the NOT_COMPATIBLE state.
    expect(errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'unsupported' })]),
    );
    expect(errors.some((f) => f.id === 'health-path-required')).toBe(true);
  });

  it('returns NEEDS_CONFIGURATION when Dockerfile or port or start command is missing', () => {
    const manifest = normalizeDeploymentManifest({ metadata: { hasDockerfile: false } }, {});
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('NEEDS_CONFIGURATION');
    const ids = result.findings.filter((f) => f.severity === 'error').map((f) => f.id);
    expect(ids).toEqual(
      expect.arrayContaining(['dockerfile-missing', 'port-missing', 'start-command-missing']),
    );
  });

  it('the missing-migration warning names MySQL for a MySQL database', () => {
    const manifest = normalizeDeploymentManifest(
      { metadata: { hasDockerfile: true, dockerfilePath: 'Dockerfile', startupCommands: ['node index.js'], port: '3000', databaseState: 'mysql', mysql: { detected: true, required: true } } },
      {},
    );
    expect(manifest.database.engine).toBe('mysql');
    const warning = evaluateManifestReadiness(manifest).findings.find((f) => f.id === 'migration-command-missing');
    expect(warning?.message).toBe('This app uses MySQL but has no migration command; schema updates will not run on deploy.');
  });

  it('the migration inconsistency names no engine when no database is required', () => {
    const manifest = normalizeDeploymentManifest(
      { metadata: { hasDockerfile: true, dockerfilePath: 'Dockerfile', startupCommands: ['node index.js'], port: '3000' } },
      { migrationCommand: 'npm run migrate' },
    );
    const unsupported = evaluateManifestReadiness(manifest).findings.map((f) => f.message).join(' ');
    expect(unsupported).toContain('the manifest does not require a database');
    expect(unsupported).not.toContain('does not require PostgreSQL');
  });

  it('READY carries a warning when PostgreSQL is required but no migration command exists', () => {
    const manifest = normalizeDeploymentManifest(
      {
        metadata: {
          hasDockerfile: true,
          dockerfilePath: 'Dockerfile',
          startupCommands: ['node index.js'],
          port: '3000',
          postgres: { required: true },
        },
      },
      {},
    );
    const result = evaluateManifestReadiness(manifest);
    expect(result.state).toBe('READY');
    expect(result.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'migration-command-missing' })]),
    );
  });
});