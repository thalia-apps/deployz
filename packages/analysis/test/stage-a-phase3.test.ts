import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import {
  assessPostgres,
  detectDockerfile,
  detectHealthEndpoint,
  detectLocalFilesystem,
  detectPort,
  detectPostgresql,
  listDockerfileCandidates,
} from '../src/detectors.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';
import { checkDockerComposeMultiService, checkElasticsearch, checkGpu, checkMongo, checkSqlite } from '../src/rejection.js';

// Stage A phase-3 regression fixtures — the main-corpus findings, COMP-024
// onwards. The Stage A corpus and its findings registry were removed on
// 2026-10-18; see docs/testing/compatibility.md for the Docker run-and-check test.

const APP = 'FROM node:22-alpine\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n';

describe('COMP-024 — local-disk state must be declared, not inferred from write calls', () => {
  it('ignores write calls, and detects a Dockerfile VOLUME', () => {
    const writes: FileTree = {
      Dockerfile: APP,
      'src/cache.ts': "fs.mkdirSync(dir, { recursive: true });\nfs.writeFileSync(path.join(dir, 'index.json'), body);\n",
      'app/export.py': "with open('/tmp/export.csv', 'w') as f:\n    f.write(rows)\n",
    };
    expect(detectLocalFilesystem(writes)).toMatchObject({ detected: false });

    const volume: FileTree = { ...writes, Dockerfile: `${APP}VOLUME ["/app/data", "/app/uploads"]\n` };
    expect(detectLocalFilesystem(volume)).toMatchObject({
      detected: true,
      value: ['VOLUME /app/data (Dockerfile)', 'VOLUME /app/uploads (Dockerfile)'],
    });
  });

  it('accepts an object-storage alternative, and a volume that only backs the default embedded database', () => {
    const s3: FileTree = {
      Dockerfile: `${APP}VOLUME /app/data\n`,
      'package.json': JSON.stringify({ dependencies: { '@aws-sdk/client-s3': '^3.0.0' } }),
    };
    expect(detectLocalFilesystem(s3)).toMatchObject({ detected: false });

    const sqliteDefault: FileTree = {
      Dockerfile: 'FROM python:3.12\nVOLUME /database\nCMD ["gunicorn", "app:app"]\n',
      'pyproject.toml': 'dependencies = ["flask", "psycopg2-binary"]\n',
    };
    expect(detectLocalFilesystem(sqliteDefault)).toMatchObject({ detected: false });

    const kutt: FileTree = {
      'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0', knex: '^3.0.0' } }),
      'docker-compose.yml':
        'services:\n  server:\n    build:\n      context: .\n    volumes:\n       - db_data_sqlite:/var/lib/kutt\n       - custom:/kutt/custom\nvolumes:\n  db_data_sqlite:\n  custom:\n',
    };
    expect(detectLocalFilesystem(kutt)).toMatchObject({ detected: false });
  });

  it('reads a four-space-indented Compose file', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'docker-compose.yml': 'services:\n    changedetection:\n      image: ghcr.io/dgtlmoon/changedetection.io\n      volumes:\n        - changedetection-data:/datastore\n\nvolumes:\n  changedetection-data:\n',
    };
    expect(detectLocalFilesystem(tree)).toMatchObject({
      detected: true,
      value: ['volume changedetection-data:/datastore (docker-compose.yml changedetection)'],
    });
  });

  it('detects a Compose volume on the application service only, ignoring read-only and file mounts', () => {
    const tree: FileTree = {
      Dockerfile: APP,
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '    volumes:',
        '      - ./config.yml:/app/config.yml',
        '      - ./custom:/app/custom',
        '      - ./certs:/certs:ro',
        '      - /var/run/docker.sock:/var/run/docker.sock',
        '      - uploads:/app/uploads',
        '  db:',
        '    image: postgres:16',
        '    volumes:',
        '      - pgdata:/var/lib/postgresql/data',
        'volumes:',
        '  uploads:',
        '  pgdata:',
        '',
      ].join('\n'),
      'custom/theme.css': 'body {}\n',
    };
    expect(detectLocalFilesystem(tree)).toMatchObject({
      detected: true,
      value: ['volume uploads:/app/uploads (docker-compose.yml app)'],
    });
  });
});

describe('COMP-026 — Compose sidecars and profile-gated services are not application services', () => {
  it('counts only services that run the app', () => {
    const sidecars: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  app:',
        '    build: .',
        '  meilisearch:',
        '    image: getmeili/meilisearch:v1.8',
        '  caddy:',
        '    image: caddy:2',
        '  mail:',
        '    image: axllent/mailpit',
        '  studio:',
        '    image: myorg/studio',
        '    profiles: ["tools"]',
        '  postgres:',
        '    image: postgres:16',
        '',
      ].join('\n'),
    };
    expect(checkDockerComposeMultiService(sidecars)).toMatchObject({ detected: false });

    // A service that declares a worker process gets its own ECS service
    // (Phase 4A), so it no longer counts as a second application container.
    const appAndWorker: FileTree = {
      'docker-compose.yml': 'services:\n  server:\n    image: twentycrm/twenty\n  worker:\n    image: twentycrm/twenty\n    command: worker\n',
    };
    expect(checkDockerComposeMultiService(appAndWorker)).toMatchObject({ detected: false });

    // Two NON-worker application services are still the unsupported shape.
    const twoApps: FileTree = {
      'docker-compose.yml': 'services:\n  server:\n    image: twentycrm/twenty\n  studio:\n    image: twentycrm/studio\n',
    };
    expect(checkDockerComposeMultiService(twoApps)).toMatchObject({ detected: true, dependency: 'docker-compose-multi-service' });
  });

  it('ignores a browser-test or benchmark Compose file', () => {
    const tree: FileTree = {
      'playwright/docker-compose.yml': 'services:\n  app:\n    build: .\n  playwright:\n    image: mcr.microsoft.com/playwright\n  keycloak:\n    build: ./keycloak\n',
    };
    expect(checkDockerComposeMultiService(tree)).toMatchObject({ detected: false });
  });
});

describe('COMP-027 — Dockerfile naming and ranking', () => {
  it('accepts `<name>.Dockerfile` and `Dockerfile-<name>`, and rejects look-alikes', () => {
    expect(detectDockerfile({ 'docker/ce-production.Dockerfile': APP }).value).toBe('docker/ce-production.Dockerfile');
    expect(detectDockerfile({ '.docker/Dockerfile-build': APP }).value).toBe('.docker/Dockerfile-build');
    expect(
      detectDockerfile({
        'Dockerfile.dev.dockerignore': 'node_modules\n',
        'docker/Dockerfile.j2': 'FROM {{ base }}\n',
        'src/editor/dockerfile/dockerfile.js': 'export const language = {};\n',
        'lib/hubs/dockerfile.ex': 'defmodule Dockerfile do\nend\n',
      }),
    ).toMatchObject({ detected: false });
  });

  it('ranks editor, operator, tool and infrastructure-image directories and variant suffixes last', () => {
    const twenty: FileTree = {
      '.cursor/Dockerfile': APP,
      'packages/twenty-docker/twenty-postgres-spilo/Dockerfile': 'FROM spilo\n',
      'packages/twenty-docker/twenty/Dockerfile': APP,
    };
    expect(listDockerfileCandidates(twenty)[0]).toBe('packages/twenty-docker/twenty/Dockerfile');

    const keycloak: FileTree = { 'operator/Dockerfile': APP, 'quarkus/container/Dockerfile': APP, 'test-framework/db/Dockerfile': APP };
    expect(listDockerfileCandidates(keycloak)[0]).toBe('quarkus/container/Dockerfile');

    const infisical: FileTree = { 'Dockerfile.fips.standalone-infisical': APP, 'Dockerfile.standalone-infisical': APP, 'docs/Dockerfile': APP };
    expect(listDockerfileCandidates(infisical)[0]).toBe('Dockerfile.standalone-infisical');

    const joplin: FileTree = {
      'Dockerfile.transcribe.gpu': 'FROM nvidia/cuda:12.4.0-runtime\n',
      'Dockerfile.transcribe': APP,
      'Dockerfile.server': APP,
    };
    expect(listDockerfileCandidates(joplin)[0]).toBe('Dockerfile.server');
    expect(checkGpu(joplin)).toMatchObject({ detected: false });

    const tooljet: FileTree = {
      'docker/ce-production.Dockerfile': APP,
      'docker/ce-preview.Dockerfile': APP,
      'docker/client.Dockerfile': APP,
      'docker/gitpod.Dockerfile': APP,
      'cypress-tests/cypress-lts.Dockerfile': APP,
    };
    expect(listDockerfileCandidates(tooljet)[0]).toBe('docker/ce-production.Dockerfile');
  });

  it('ranks a long hyphenated name in linear time', () => {
    const name = `Dockerfile-${'a-'.repeat(60)}b`;
    const started = Date.now();
    expect(listDockerfileCandidates({ [name]: APP, Dockerfile: APP })[0]).toBe('Dockerfile');
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe('COMP-028 — EXPOSE variables and non-HTTP ports', () => {
  it('resolves an EXPOSE variable from the Dockerfile ENV/ARG', () => {
    expect(detectPort({ Dockerfile: 'FROM python:3.12\nENV APP_PORT=9000\nEXPOSE ${APP_PORT}\nCMD ["mealie"]\n' })).toMatchObject({
      detected: true,
      value: '9000',
    });
    expect(detectPort({ Dockerfile: 'FROM node:22\nARG VERDACCIO_PORT=4873\nEXPOSE $VERDACCIO_PORT\n' })).toMatchObject({
      detected: true,
      value: '4873',
    });
  });

  it('skips SSH and other non-HTTP ports when the image exposes another one', () => {
    expect(detectPort({ Dockerfile: 'FROM golang:alpine\nEXPOSE 22 3000\nCMD ["gitea"]\n' })).toMatchObject({ detected: true, value: '3000' });
    expect(detectPort({ Dockerfile: 'FROM python\nEXPOSE 22\nEXPOSE 9991\n' })).toMatchObject({ detected: true, value: '9991' });
  });
});

describe('COMP-029 — PostgreSQL drivers beyond Node, Python, Ruby and Go', () => {
  it('reads JVM, PHP, .NET, Rust and Elixir manifests, and the PHP PDO extension', () => {
    expect(detectPostgresql({ 'pom.xml': '<dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>\n' })).toMatchObject({
      detected: true,
      value: ['org.postgresql (JVM)'],
    });
    expect(detectPostgresql({ 'build.gradle.kts': 'implementation("io.r2dbc:r2dbc-postgresql:1.0.0")\n' }).value).toEqual(['r2dbc-postgresql (JVM)']);
    expect(detectPostgresql({ 'composer.json': JSON.stringify({ require: { 'ext-pdo_pgsql': '*' } }) }).value).toEqual(['pdo_pgsql (PHP)']);
    expect(detectPostgresql({ 'src/App.csproj': '<PackageReference Include="Npgsql" Version="8.0.0" />\n' }).value).toEqual(['Npgsql (.NET)']);
    expect(detectPostgresql({ 'Cargo.toml': 'diesel = { version = "2", features = ["postgres", "sqlite"] }\n' }).value).toEqual(['postgres feature (Rust)']);
    expect(detectPostgresql({ 'mix.exs': '{:postgrex, ">= 0.0.0"}\n' }).value).toEqual(['postgrex (Elixir)']);
    const php: FileTree = {
      'docker/php/Dockerfile': 'FROM php:8.3-fpm\nRUN docker-php-ext-install -j "$(nproc)" \\\n        pdo_pgsql \\\n        pdo_sqlite\n',
      '.env.example': 'DATABASE_URL=sqlite:///%kernel.project_dir%/var/data.db\n',
    };
    expect(detectPostgresql(php).value).toEqual(['pdo_pgsql (PHP)']);
    expect(checkSqlite(php)).toMatchObject({ detected: false });
  });

  it('rejects an image that sets the path of its SQLite file, unless the app has a PostgreSQL driver', () => {
    const image: FileTree = {
      Dockerfile: 'FROM debian:12\nCOPY app /app\nENV SQLITE_DATABASE=/app/data/app.sqlite3\nCMD ["/app/server"]\n',
    };
    expect(checkSqlite(image)).toMatchObject({ detected: true, dependency: 'sqlite' });
    expect(checkSqlite({ ...image, 'package.json': JSON.stringify({ dependencies: { pg: '^8' } }) })).toMatchObject({ detected: false });
  });

  it('treats a direct driver in a runtime manifest as a configured engine, not a tool or indirect one', () => {
    expect(
      assessPostgres({
        'go.mod': 'module memos\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n)\n',
        'store/db.go': 'package store\nimport _ "github.com/lib/pq"\n',
      }).required,
    ).toBe(true);
    expect(assessPostgres({ 'build.gradle': 'runtimeOnly "org.postgresql:postgresql"\n' }).required).toBe(true);
    expect(assessPostgres({ 'tools/go.mod': 'module tools\n\nrequire github.com/jackc/pgx/v5 v5.6.0\n' }).required).toBe(false);
  });
});

describe('COMP-032 — database clients need the same corroboration brokers do', () => {
  it('does not reject an integration platform for the clients it ships', () => {
    const tree: FileTree = {
      'package.json': JSON.stringify({ dependencies: { pg: '^8.0.0', mongodb: '^6.0.0', '@elastic/elasticsearch': '^8.0.0' } }),
      'src/plugins/mongodb/query.ts': 'const client = new MongoClient(config.connectionString);\n',
      'docker-compose.yml': 'services:\n  app:\n    build: .\n  mongo:\n    image: mongo:7\n    profiles: ["samples"]\n',
    };
    expect(checkMongo(tree)).toMatchObject({ detected: false });
    expect(checkElasticsearch(tree)).toMatchObject({ detected: false });
  });

  it('still rejects the app whose own data lives there', () => {
    const models: FileTree = {
      'package.json': JSON.stringify({ dependencies: { mongoose: '^8.0.0' } }),
      'api/models/User.js': 'const userSchema = new mongoose.Schema({ email: String });\nmodule.exports = mongoose.model("User", userSchema);\n',
    };
    expect(checkMongo(models)).toMatchObject({ detected: true, dependency: 'mongoose' });

    const compose: FileTree = {
      'package.json': JSON.stringify({ dependencies: { mongodb: '^6.0.0' } }),
      'docker-compose.yml': 'services:\n  api:\n    build: .\n  mongodb:\n    image: mongo:7\n',
    };
    expect(checkMongo(compose)).toMatchObject({ detected: true, dependency: 'mongodb' });

    const required: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@elastic/elasticsearch': '^8.0.0' } }),
      'src/search.ts': 'const node = process.env.ELASTICSEARCH_URL;\nif (!node) throw new Error("ELASTICSEARCH_URL is required");\n',
    };
    expect(checkElasticsearch(required)).toMatchObject({ detected: true });
  });
});

describe('COMP-034 — a script-based HEALTHCHECK names its path in the script', () => {
  it('reads the URL from the health-check script, and treats a bare origin as /', () => {
    const script: FileTree = {
      Dockerfile: `${APP}HEALTHCHECK --interval=10s CMD node ./healthcheck.js\n`,
      'healthcheck.js': "const req = http.get('http://localhost:1337/', (res) => process.exit(res.statusCode === 200 ? 0 : 1));\n",
    };
    expect(detectHealthEndpoint(script)).toMatchObject({ detected: true, path: '/' });

    const origin: FileTree = { Dockerfile: `${APP}HEALTHCHECK CMD wget --spider http://localhost:3000 || exit 1\n` };
    expect(detectHealthEndpoint(origin)).toMatchObject({ detected: true, path: '/' });
  });
});

describe('COMP-035 — build-script directories are not app roots', () => {
  it('maps scripts/ and .docker/ Dockerfiles to the repository root', () => {
    for (const path of ['scripts/Dockerfile', '.docker/Dockerfile-build', 'quarkus/container/Dockerfile', 'packages/twenty-docker/twenty/Dockerfile']) {
      const manifest = normalizeDeploymentManifest(analyseRepo({ [path]: APP }), {});
      expect(manifest.application.root).toBe('.');
    }
  });
});

describe('a Go PostgreSQL driver needs runtime corroboration', () => {
  const goMod = 'module app\n\nrequire github.com/lib/pq v1.10.9\n';

  it('does not require PostgreSQL for a go.mod requirement no source imports', () => {
    expect(assessPostgres({ 'go.mod': goMod, 'main.go': 'package main\nfunc main() {}\n' }).required).toBe(false);
  });

  it('does not require PostgreSQL when only test or vendored Go source imports the driver', () => {
    const tree = {
      'go.mod': goMod,
      'main.go': 'package main\nfunc main() {}\n',
      'store/store_test.go': 'package store\nimport _ "github.com/lib/pq"\n',
      'vendor/github.com/lib/pq/conn.go': 'package pq\nimport _ "github.com/lib/pq"\n',
    };
    expect(assessPostgres(tree).required).toBe(false);
  });

  it('requires PostgreSQL when main code imports the driver and reads DATABASE_URL', () => {
    const tree = {
      'go.mod': goMod,
      'main.go': 'package main\nimport (\n\t"os"\n\t_ "github.com/lib/pq"\n)\nvar dsn = os.Getenv("DATABASE_URL")\n',
    };
    expect(assessPostgres(tree).required).toBe(true);
  });
});
