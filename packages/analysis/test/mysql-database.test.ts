import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import { manifestToApplicationGraph } from '../src/graph.js';
import { normalizeDeploymentManifest, evaluateManifestReadiness } from '../src/manifest.js';
import { planApplicationGraph } from '../src/planner.js';

// Phase 4B — MySQL is a supported managed relational database: strong
// evidence (driver + an independent signal) resolves a mysql-engine database
// resource, the planner resolves aws.rds-mysql, and weak evidence (a bare
// driver) deploys without a database and raises the binding question.

const BASE: FileTree = {
  'Dockerfile': [
    'FROM node:20-alpine',
    'WORKDIR /app',
    'COPY . .',
    'EXPOSE 3000',
    'HEALTHCHECK --interval=30s CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'package.json': JSON.stringify({
    name: 'shop',
    scripts: { start: 'node dist/index.js', 'db:migrate': 'npx prisma migrate deploy' },
    dependencies: { express: '^4.18.0', mysql2: '^3.9.0' },
  }),
  'src/index.ts': [
    "import express from 'express';",
    "app.get('/health', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT ?? 3000);',
  ].join('\n'),
};

describe('mysql database — strong evidence (mysql:// URL)', () => {
  it('resolves a mysql-engine managed database end to end', () => {
    const analysis = analyseRepo({
      ...BASE,
      '.env.example': 'DATABASE_URL=mysql://localhost:3306/shop\n',
    });

    // Requirement + state.
    const mysqlMeta = analysis.metadata.mysql as { required: boolean; detected: boolean };
    expect(mysqlMeta.required).toBe(true);
    expect(analysis.metadata.databaseState).toBe('mysql');

    // Manifest: the managed-database boolean (legacy name) is true, the
    // engine field names mysql, and nothing is unsupported.
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.postgres).toBe(true);
    expect(manifest.database.engine).toBe('mysql');
    expect(manifest.unsupported).toEqual([]);
    expect(evaluateManifestReadiness(manifest).state).toBe('READY');

    // Graph: one mysql relational database.
    const graph = manifestToApplicationGraph(manifest);
    const db = graph.resources.find((r) => r.id === 'primary-db')!;
    expect(db.kind).toBe('relational_database');
    expect(db.engine).toBe('mysql');
    expect(db.label).toBe('MySQL database');

    // Planner: aws.rds-mysql with the Deployz-pinned engine version, sharing
    // the same size profile knobs as PostgreSQL.
    const ir = planApplicationGraph({ graph, region: null });
    const irDb = ir.resources.find((r) => r.componentId === 'primary-db')!;
    expect(irDb.capabilityKey).toBe('aws.rds-mysql');
    expect(irDb.configuration).toMatchObject({ engine: 'mysql', engineVersion: '8.0' });
  });

  it('a required MySQL database gets the same migration mode and app bindings as PostgreSQL', () => {
    const analysis = analyseRepo({
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', mysql2: '^3.9.0' },
      }),
      '.env.example': 'DATABASE_URL=mysql://localhost:3306/shop\nDB_HOST=localhost\n',
      'src/db.ts': 'export const host = process.env.DB_HOST;\n',
    });
    expect(analysis.metadata.migrationMode).toBe('unknown');

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.envBindings?.map((binding) => binding.name)).toContain('DB_HOST');
  });

  it('Prisma provider "mysql" is independent evidence', () => {
    const analysis = analyseRepo({
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js', 'db:migrate': 'npx prisma migrate deploy' },
        dependencies: { express: '^4.18.0', '@prisma/client': '^5.14.0' },
        devDependencies: { prisma: '^5.14.0' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n  url = env("DATABASE_URL")\n}\n',
    });
    const mysqlMeta = analysis.metadata.mysql as { required: boolean };
    expect(mysqlMeta.required).toBe(true);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.engine).toBe('mysql');
    expect(manifest.unsupported).toEqual([]);
  });

  it('a production compose mysql image corroborates the driver', () => {
    const analysis = analyseRepo({
      ...BASE,
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  db:',
        '    image: mysql:8.0',
        '',
      ].join('\n'),
    });
    const mysqlMeta = analysis.metadata.mysql as { required: boolean };
    expect(mysqlMeta.required).toBe(true);
  });

  it('a PostgreSQL driver next to mysql2 keeps PostgreSQL the engine (COMP-002 guard)', () => {
    const analysis = analyseRepo({
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0', pg: '^8.12.0', mysql2: '^3.9.0' },
      }),
      '.env.example': 'DATABASE_URL=postgresql://localhost:5432/shop\n',
    });
    const mysqlMeta = analysis.metadata.mysql as { required: boolean; detected: boolean };
    expect(mysqlMeta.detected).toBe(false);
    expect(mysqlMeta.required).toBe(false);
    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.database.engine).toBeUndefined();
  });
});

describe('mysql database — weak evidence needs input', () => {
  it('a bare mysql2 driver deploys without a database and raises the question', () => {
    const analysis = analyseRepo(BASE);
    const mysqlMeta = analysis.metadata.mysql as { required: boolean; detected: boolean };
    expect(mysqlMeta.detected).toBe(true);
    expect(mysqlMeta.required).toBe(false);

    const manifest = normalizeDeploymentManifest(analysis, {});
    // No managed database: the boolean is false and no engine is written.
    expect(manifest.database.postgres).toBe(false);
    expect(manifest.database.engine).toBeUndefined();
    expect(manifest.unsupported).toEqual([]);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.resources.some((r) => r.id === 'primary-db')).toBe(false);
    expect(graph.unresolved.some((u) => u.field === 'worker_command')).toBe(false);
  });

  it('a mysql devDependency or an infra-only compose service is not an app database', () => {
    const devDep: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0' },
        devDependencies: { mysql2: '^3.9.0' },
      }),
    };
    expect((analyseRepo(devDep).metadata.mysql as { required: boolean }).required).toBe(false);

    const infraOnly: FileTree = {
      ...BASE,
      'package.json': JSON.stringify({
        name: 'shop',
        scripts: { start: 'node dist/index.js' },
        dependencies: { express: '^4.18.0' },
      }),
      'docker-compose.yml': 'services:\n  app:\n    build: .\n  db:\n    image: mysql:8.0\n',
    };
    expect((analyseRepo(infraOnly).metadata.mysql as { detected: boolean }).detected).toBe(false);
  });
});

describe('mysql database — SQLAlchemy driver scheme', () => {
  const PYTHON: FileTree = {
    'Dockerfile': [
      'FROM python:3.11-slim',
      'WORKDIR /app',
      'COPY . .',
      'RUN pip install -r requirements.txt',
      'EXPOSE 8000',
      'CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:8000"]',
    ].join('\n'),
    'requirements.txt': 'flask==3.0.0\nflask-sqlalchemy==3.1.1\nsqlalchemy==2.0.30\npymysql==1.1.1\ngunicorn==22.0.0\n',
    'app.py': [
      'import os',
      'from flask import Flask',
      'app = Flask(__name__)',
      "app.config['SQLALCHEMY_DATABASE_URI'] = os.environ.get('DATABASE_URL', 'mysql+pymysql://ctfd@db/ctfd')",
      "@app.route('/health')",
      'def health():',
      "    return 'ok'",
    ].join('\n'),
  };

  it('PyMySQL without mysqlclient gets mysql+pymysql through manifest, graph and plan', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(PYTHON), {});
    expect(manifest.database.engine).toBe('mysql');
    expect(manifest.database.urlScheme).toBe('mysql+pymysql');
    const graph = manifestToApplicationGraph(manifest);
    expect(graph.resources.find((r) => r.id === 'primary-db')?.urlScheme).toBe('mysql+pymysql');
    const ir = planApplicationGraph({ graph, region: null });
    expect(ir.resources.find((r) => r.componentId === 'primary-db')?.configuration).toMatchObject({ urlScheme: 'mysql+pymysql' });
  });

  it('mysqlclient keeps the standard mysql scheme', () => {
    const manifest = normalizeDeploymentManifest(
      analyseRepo({ ...PYTHON, 'requirements.txt': `${PYTHON['requirements.txt']}mysqlclient==2.2.4\n` }),
      {},
    );
    expect(manifest.database.engine).toBe('mysql');
    expect(manifest.database.urlScheme).toBeUndefined();
  });

  it('a Node MySQL app keeps the standard mysql scheme', () => {
    const manifest = normalizeDeploymentManifest(
      analyseRepo({ ...BASE, '.env.example': 'DATABASE_URL=mysql://localhost:3306/shop\n' }),
      {},
    );
    expect(manifest.database.urlScheme).toBeUndefined();
  });
});
