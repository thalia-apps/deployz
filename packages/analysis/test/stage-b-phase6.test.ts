import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { detectStartupMigrationEvidence, hasPreDeployMigration, selectMigrationScript } from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { buildReadinessReport } from '../src/readiness-report.js';

/** A container-ready, PostgreSQL-required app shell. */
function dbApp(extra: Partial<FileTree>): FileTree {
  return {
    'Dockerfile': [
      'FROM node:20-alpine',
      'EXPOSE 3000',
      'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0', pg: '^8.12.0' },
    }),
    '.env.example': 'DATABASE_URL=postgresql://localhost:5432/app\n',
    'src/index.ts': [
      "import express from 'express';",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(3000);',
      '',
    ].join('\n'),
    ...extra,
  };
}

function analyse(tree: FileTree) {
  return analyseRepo(tree);
}

// ==========================================================================
// Mode derivation
// ==========================================================================

describe('migration modes (COMP-014)', () => {
  it('maps "no database" to mode none', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      }),
    };
    expect(analyse(tree).metadata['migrationMode']).toBe('none');
  });

  it('maps a deploy-safe migration script to mode pre_deploy', () => {
    const tree = dbApp({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node dist/index.js', migrate: 'prisma migrate deploy' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', '@prisma/client': '^5.0.0', prisma: '^5.0.0' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
    });
    const analysis = analyse(tree);
    expect(analysis.metadata['migrationMode']).toBe('pre_deploy');
    expect(hasPreDeployMigration(tree)).toBe(true);
  });

  it('maps a migration inside the Dockerfile CMD to mode startup', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "prisma migrate deploy && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const analysis = analyse(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    const evidence = analysis.metadata['migrationStartupEvidence'] as {
      source: string;
      pattern: string;
    }[];
    expect(evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'CMD (Dockerfile)', pattern: 'prisma migrate deploy' }),
      ]),
    );
  });

  it('maps a migration inside a package.json start script to mode startup', () => {
    const tree = dbApp({
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'knex migrate:latest && node dist/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', knex: '^3.0.0' },
      }),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('startup');
  });

  it('finds startup evidence in an entrypoint.sh next to the Dockerfile', () => {
    const tree = dbApp({
      'entrypoint.sh': '#!/bin/sh\npython manage.py migrate\nexec node dist/index.js\n',
    });
    const analysis = analyse(tree);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern: 'python manage.py migrate' })]),
    );
  });

  it('ignores dev-shaped migration commands', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "prisma migrate dev && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('unknown');
  });

  it('maps a required database with no migration evidence to mode unknown', () => {
    const analysis = analyse(dbApp({}));
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('unknown');
  });
});

// ==========================================================================
// DEPLOY-029: the CMD/ENTRYPOINT script chain wins over a package.json
// deploy-shaped script — an image that migrates itself at boot (umami's
// Dockerfile CMD -> scripts/start-docker.sh -> scripts/check-db.js ->
// `prisma migrate deploy`) must not also get an invented pre-deploy command.
// ==========================================================================

/** An umami-shaped tree: CMD runs a script that runs another script that migrates. */
function umamiApp(checkDbContent: string): FileTree {
  return {
    'Dockerfile': ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["sh", "scripts/start-docker.sh"]', ''].join('\n'),
    'scripts/start-docker.sh': ['#!/bin/sh', 'node scripts/check-db.js', 'exec node dist/index.js', ''].join('\n'),
    'scripts/check-db.js': checkDbContent,
    'package.json': JSON.stringify({
      name: 'umami',
      scripts: { start: 'node dist/index.js', 'update-db': 'prisma migrate deploy' },
      dependencies: { '@prisma/client': '^5.0.0', prisma: '^5.0.0' },
    }),
    'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n}\n',
  };
}

describe('startup migration evidence follows the CMD/ENTRYPOINT script chain (DEPLOY-029)', () => {
  it('finds a migration two hops below CMD (CMD -> start-docker.sh -> check-db.js) and records the script path as the source', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n");
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'scripts/check-db.js',
          pattern: 'prisma migrate deploy',
          fromDockerCommand: true,
        }),
      ]),
    );
  });

  it('the CMD chain wins mode startup even though a deploy-shaped package.json script also exists', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n");
    const analysis = analyse(tree);
    expect((analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    // A pre-deploy candidate really is present — proves this is precedence,
    // not merely an absence of the old signal.
    expect(hasPreDeployMigration(tree)).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('startup');
    const evidence = analysis.metadata['migrationStartupEvidence'] as { source: string; pattern: string }[];
    expect(evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'scripts/check-db.js', pattern: 'prisma migrate deploy' })]),
    );
  });

  it('a package.json deploy-shaped script alone (no CMD chain to a migrating script) still maps to pre_deploy', () => {
    const tree = dbApp({
      'Dockerfile': ['FROM node:20-alpine', 'EXPOSE 3000', 'CMD ["node", "dist/index.js"]', ''].join('\n'),
      'package.json': JSON.stringify({
        name: 'app',
        scripts: { start: 'node dist/index.js', 'update-db': 'prisma migrate deploy' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', prisma: '^5.0.0' },
      }),
    });
    expect(analyse(tree).metadata['migrationMode']).toBe('pre_deploy');
  });

  it('follows an extension-less boot script that ENTRYPOINT names by its in-image path (Rails bin/docker-entrypoint)', () => {
    const tree: FileTree = {
      Dockerfile: ['FROM ruby:3.4-slim', 'WORKDIR /rails', 'COPY . .', 'ENTRYPOINT ["/rails/bin/docker-entrypoint"]', 'EXPOSE 3000', 'CMD ["./bin/rails", "server"]', ''].join('\n'),
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n",
      'bin/docker-entrypoint': '#!/bin/bash -e\nif [ "${1}" == "./bin/rails" ] && [ "${2}" == "server" ]; then\n  ./bin/rails db:prepare\nfi\nexec "${@}"\n',
      'bin/rails': '#!/usr/bin/env ruby\nrequire_relative "../config/boot"\n',
    };
    expect(detectStartupMigrationEvidence(tree)).toEqual([
      expect.objectContaining({ source: 'bin/docker-entrypoint', pattern: 'rails db:prepare/db:migrate', fromDockerCommand: true }),
    ]);
    expect(analyse(tree).metadata['migrationMode']).toBe('startup');
  });

  it('resolves an in-image script that several directories hold to the one next to the Dockerfile', () => {
    const tree: FileTree = {
      'docker/single-process/Dockerfile': ['FROM ruby:3.4-slim', 'WORKDIR /app', 'COPY ./ /app/', 'COPY ["docker/single-process/scripts/init", "/scripts/"]', 'EXPOSE 3000', 'CMD ["/scripts/init"]', ''].join('\n'),
      Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n",
      'docker/single-process/scripts/init': '#!/bin/bash -e\nbundle exec rake db:migrate\nexec bundle exec unicorn\n',
      'docker/multi-process/scripts/init': '#!/bin/bash -e\nexec supervisord\n',
    };
    expect(detectStartupMigrationEvidence(tree)).toEqual([
      expect.objectContaining({ source: 'docker/single-process/scripts/init', fromDockerCommand: true }),
    ]);
  });

  it('a CMD script chain with no migration pattern leaves mode unaffected (no false positive)', () => {
    const tree = umamiApp("const { execSync } = require('child_process');\nexecSync('pg_isready');\n");
    // The chain (CMD -> start-docker.sh -> check-db.js) has no migration
    // pattern in it — no evidence, so no spurious startup precedence.
    expect(detectStartupMigrationEvidence(tree)).toEqual([]);
    const analysis = analyse(tree);
    // `update-db: prisma migrate deploy` in package.json is still
    // deploy-shaped, so the existing order applies unchanged: pre_deploy.
    expect(hasPreDeployMigration(tree)).toBe(true);
    expect(analysis.metadata['migrationMode']).toBe('pre_deploy');
  });
});

// ==========================================================================
// Manifest + readiness behaviour
// ==========================================================================

describe('migration mode — manifest and readiness (COMP-014)', () => {
  it('serializes migration.mode on the manifest', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "python manage.py migrate && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const manifest = normalizeDeploymentManifest(analyse(tree), {});
    expect(manifest.migration.mode).toBe('startup');
    expect(manifest.migration.command).toBeNull(); // never invented
  });

  it('startup mode is informational/recommended and never blocks the gate', () => {
    const tree = dbApp({
      'Dockerfile': [
        'FROM node:20-alpine',
        'EXPOSE 3000',
        'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
        'CMD ["sh", "-c", "python manage.py migrate && node dist/index.js"]',
        '',
      ].join('\n'),
    });
    const analysis = analyse(tree);
    const report = buildReadinessReport(analysis);
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('start');
    expect(finding?.severity).toBe('recommended');
    expect(finding?.blocking).toBe(false);

    const manifest = normalizeDeploymentManifest(analysis, {});
    const gate = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(gate.state).toBe('READY');
    expect(gate.findings.some((f) => f.severity === 'error')).toBe(false);
  });

  it('mode none produces no database-migrations finding', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({
        name: 'x',
        scripts: { start: 'node index.js' },
        dependencies: { express: '^4.18.0' },
      }),
    };
    const report = buildReadinessReport(analyse(tree));
    expect(report.findings.some((f) => f.id === 'database-migrations')).toBe(false);
  });

  it('mode unknown keeps the gentle recommendation', () => {
    const report = buildReadinessReport(analyse(dbApp({})));
    const finding = report.findings.find((f) => f.id === 'database-migrations');
    expect(finding).toBeDefined();
    expect(finding?.title).toContain('Give Deployz a way');
  });
});

// ==========================================================================
// Migration safety — never freeze an unsafe command into the pre-deploy task
// ==========================================================================

describe('selectMigrationScript refuses unsafe migration commands', () => {
  const dockerfile = ['FROM node:20-alpine', 'WORKDIR /app', 'RUN npm ci --omit=dev', 'CMD ["node", "dist/index.js"]', ''].join('\n');
  const appTree = (
    scripts: Record<string, string>,
    dependencies: Record<string, string> = {},
    devDependencies: Record<string, string> = {},
    extra: FileTree = {},
  ): FileTree => ({
    'Dockerfile': dockerfile,
    'package.json': JSON.stringify({ name: 'app', scripts: { start: 'node dist/index.js', ...scripts }, dependencies, devDependencies }),
    ...extra,
  });

  it.each([
    ['a copy step whose key mentions migrations', { 'copy-migrations-package': 'mkdir -p dist/migrations && cp src/migrations/package.json dist/migrations/' }, {}],
    ['drizzle-kit push', { 'db:prototype': 'drizzle-kit push' }, { 'drizzle-kit': '^0.31.0' }],
    ['drizzle-kit generate', { 'db:generate': 'drizzle-kit generate' }, { 'drizzle-kit': '^0.31.0' }],
    ['a migration create script', { migrate: 'tsx src/database/migrate.ts create' }, { tsx: '^4.0.0' }],
    ['knex migrate:make', { 'migrate:make': 'knex migrate:make' }, { knex: '^3.0.0' }],
    ['knex migrate:rollback', { 'db:rollback': 'knex migrate:rollback' }, { knex: '^3.0.0' }],
    ['prisma migrate reset', { 'db:migrate': 'prisma migrate reset' }, { prisma: '^5.0.0' }],
    ['a pnpm --filter command', { 'db:migrate': 'pnpm --filter @acme/database exec prisma migrate deploy' }, { prisma: '^5.0.0' }],
    ['a yarn workspace command', { 'db:migrate': 'yarn workspace db run migrate' }, {}],
    ['a ../ path outside the image WORKDIR', { migrate: 'dotenv-flow -p ../../apps/web -- node ./scripts/migrate.mjs' }, { 'dotenv-flow': '^4.0.0' }],
    ['a rename step chained before knex', { migrate: 'node ./dist/db/rename-migrations-to-mjs.mjs && knex migrate:latest' }, { knex: '^3.0.0' }],
    ['a seed chained after a migration', { migrate: 'drizzle-kit migrate && pnpm run seed' }, { 'drizzle-kit': '^0.31.0' }],
    ['a test run', { 'test:migrations': 'vitest run migrations' }, {}],
    ['a db:seed script alone', { 'db:seed': 'node seed.js' }, {}],
  ])('does not select %s', (_name, scripts, dependencies) => {
    expect(selectMigrationScript(appTree(scripts, dependencies))).toBeUndefined();
    expect(hasPreDeployMigration(appTree(scripts, dependencies))).toBe(false);
  });

  it('does not select a CLI that is only a devDependency when the runtime image prunes dev dependencies', () => {
    const tree = appTree({ migrate: 'prisma migrate deploy' }, {}, { prisma: '^5.0.0' });
    expect(selectMigrationScript(tree)).toBeUndefined();
  });

  it('does not select a CLI that is not declared at all', () => {
    expect(selectMigrationScript(appTree({ migrate: 'knex migrate:latest' }))).toBeUndefined();
  });

  it('selects a devDependency CLI when the final Dockerfile stage keeps dev dependencies', () => {
    const tree = appTree({ migrate: 'prisma migrate deploy' }, {}, { prisma: '^5.0.0' }, {
      Dockerfile: ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'RUN npm install', 'CMD ["node", "dist/index.js"]'].join('\n'),
    });
    expect(selectMigrationScript(tree)?.[1]).toBe('prisma migrate deploy');
  });

  it('does not select a script from a package that is not the deployed app', () => {
    const tree: FileTree = {
      'Dockerfile': dockerfile,
      'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
      'packages/db/package.json': JSON.stringify({
        name: 'db',
        scripts: { migrate: 'prisma migrate deploy' },
        dependencies: { prisma: '^5.0.0' },
      }),
    };
    expect(selectMigrationScript(tree)).toBeUndefined();
  });

  it.each([
    ['prisma migrate deploy', { 'db:migrate': 'prisma migrate deploy' }, { prisma: '^5.0.0' }],
    ['knex migrate:latest', { 'db:migrate': 'knex migrate:latest' }, { knex: '^3.0.0' }],
    ['a node migration file', { migrate: 'node dist/migrate.js' }, {}],
    ['python manage.py migrate', { migrate: 'python manage.py migrate --noinput' }, {}],
  ])('still selects %s', (_name, scripts, dependencies) => {
    const tree = appTree(scripts, dependencies);
    expect(selectMigrationScript(tree)).toBeDefined();
    expect(hasPreDeployMigration(tree)).toBe(true);
  });
});

describe('startup migration evidence — entrypoint chains, uwsgi and switches', () => {
  const cases: [string, FileTree, string][] = [
    [
      'an npm run migrate chained before start in CMD',
      { Dockerfile: 'FROM node:20\nCMD npm run migrate && npm start\n' },
      'migrate script',
    ],
    [
      'manage.py migrate in an entrypoint script',
      { 'Dockerfile': 'FROM python:3.12\nENTRYPOINT ["./entrypoint.sh"]\n', 'entrypoint.sh': '#!/bin/sh\npython manage.py migrate\nexec "$@"\n' },
      'python manage.py migrate',
    ],
    [
      'a uwsgi hook-pre-app migration',
      {
        'Dockerfile': 'FROM python:3.12\nCMD ["uwsgi", "--ini", "uwsgi.ini"]\n',
        'uwsgi.ini': '[uwsgi]\nhook-pre-app = exec:./manage.py migrate\n',
      },
      'python manage.py migrate',
    ],
    ['rails db:prepare in CMD', { Dockerfile: 'FROM ruby:3.3\nCMD bin/rails db:prepare && bin/rails server\n' }, 'rails db:prepare/db:migrate'],
    ['sequelize db:migrate in CMD', { Dockerfile: 'FROM node:20\nCMD npx sequelize db:migrate && node server.js\n' }, 'sequelize db:migrate'],
    ['a binary -migrate flag', { Dockerfile: 'FROM alpine\nCMD ["./app", "-migrate"]\n' }, 'binary migrate flag'],
    ['a RUN_MIGRATIONS=1 ENV', { Dockerfile: 'FROM alpine\nENV RUN_MIGRATIONS=1\nCMD ["./app"]\n' }, 'migrate-on-start ENV'],
  ];

  it.each(cases)('detects %s as Dockerfile-command evidence', (_name, tree, pattern) => {
    expect(detectStartupMigrationEvidence(tree)).toEqual(
      expect.arrayContaining([expect.objectContaining({ pattern, fromDockerCommand: true })]),
    );
  });

  it('does not count a dev migration or an unrelated ENV as evidence', () => {
    expect(detectStartupMigrationEvidence({ Dockerfile: 'FROM node:20\nENV RUN_MIGRATIONS=0\nCMD yarn migrate:dev\n' })).toEqual([]);
  });
});

describe('migration script selection: comment entries', () => {
  it('ignores a blank comment-style script and a dev-prefixed migrate script', () => {
    const tree = {
      'package.json': JSON.stringify({
        name: 'app',
        scripts: {
          '// DEPRECATED - use hogli migrations:run instead': '',
          'dev:migrate:postgres': 'export DEBUG=1 && python manage.py migrate',
        },
      }),
    };
    expect(selectMigrationScript(tree)).toBeUndefined();
  });
});
