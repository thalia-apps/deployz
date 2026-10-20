import { describe, expect, it } from 'vitest';
import { analyseRepo } from '../src/analyser.js';
import {
  composeApplicationServices,
  detectDockerfile,
  detectEnvVarModel,
  detectFramework,
  detectPort,
  detectPostgresql,
  detectRuntime,
  detectS3,
  detectUnbuildableDockerfile,
  dockerfileSelectionTied,
  pathInRuntimeImage,
  TREE_PATHS,
  type FileTree,
} from '../src/detectors.js';

const dockerfile = (...lines: string[]): string => `${lines.join('\n')}\n`;

describe('Dockerfile selection ranks the image that serves HTTP', () => {
  it('prefers the Dockerfile that exposes a port over a sibling that does not (immich shape)', () => {
    const tree: FileTree = {
      'machine-learning/Dockerfile': dockerfile('FROM python:3.11-slim', 'WORKDIR /usr/src', 'CMD ["python", "-m", "ml"]'),
      'server/Dockerfile': dockerfile('FROM node:22', 'WORKDIR /usr/src/app', 'EXPOSE 2283', 'CMD ["start.sh"]'),
    };
    expect(detectDockerfile(tree).value).toBe('server/Dockerfile');
    expect(dockerfileSelectionTied(tree)).toBeNull();
  });

  it('prefers the image that starts something over a builder-only Dockerfile (searxng shape)', () => {
    const tree: FileTree = {
      'container/builder.dockerfile': dockerfile('FROM base:builder AS builder', 'COPY ./requirements.txt ./', 'RUN uv pip install -r requirements.txt'),
      'container/dist.dockerfile': dockerfile('FROM base:dist AS dist', 'COPY --from=builder /venv ./.venv/', 'EXPOSE 8080', 'ENTRYPOINT ["/entrypoint.sh"]'),
    };
    expect(detectDockerfile(tree).value).toBe('container/dist.dockerfile');
  });

  it('keeps the alphabetical pick and reports the tie when no signal separates two images', () => {
    const tree: FileTree = {
      'a/Dockerfile': dockerfile('FROM node:22', 'EXPOSE 3000', 'CMD ["node", "a.js"]'),
      'b/Dockerfile': dockerfile('FROM node:22', 'EXPOSE 3001', 'CMD ["node", "b.js"]'),
    };
    expect(detectDockerfile(tree).value).toBe('a/Dockerfile');
    expect(dockerfileSelectionTied(tree)).toEqual(['a/Dockerfile', 'b/Dockerfile']);
  });

  it('writes the tie to the analysis metadata, and omits the key when one image wins', () => {
    const tied: FileTree = {
      'a/Dockerfile': dockerfile('FROM node:22', 'EXPOSE 3000', 'CMD ["node", "a.js"]'),
      'b/Dockerfile': dockerfile('FROM node:22', 'EXPOSE 3001', 'CMD ["node", "b.js"]'),
    };
    const single: FileTree = { Dockerfile: dockerfile('FROM node:22', 'EXPOSE 3000', 'CMD ["node", "a.js"]') };
    expect(analyseRepo(tied).metadata['dockerfileSelectionTied']).toEqual(['a/Dockerfile', 'b/Dockerfile']);
    expect('dockerfileSelectionTied' in analyseRepo(single).metadata).toBe(false);
  });
});

describe('runtime follows the production stage lineage', () => {
  const paperless = dockerfile(
    'FROM docker.io/node:24-trixie-slim AS compile-frontend',
    'RUN pnpm install',
    'FROM ghcr.io/astral-sh/uv:0.12.5-python3.14-trixie-slim AS s6-overlay-base',
    'WORKDIR /usr/src/s6',
    'FROM s6-overlay-base AS main-app',
    'WORKDIR /usr/src/paperless/src/',
    'COPY ./src ./',
    'COPY --from=compile-frontend /src/static/ ./static/',
    'EXPOSE 8000',
    'ENTRYPOINT ["/init"]',
  );

  it('reads python through the FROM stage, not the node stage it copies a bundle from', () => {
    const tree: FileTree = { Dockerfile: paperless, 'src/manage.py': '# django', 'src-ui/package.json': '{"dependencies":{"@angular/core":"1"}}' };
    expect(detectRuntime(tree).value).toBe('python');
  });

  it('reads python from a uv image tag, and node from a node image', () => {
    const uv: FileTree = { Dockerfile: dockerfile('FROM ghcr.io/astral-sh/uv:0.12-python3.14-trixie-slim', 'CMD ["x"]') };
    const bareUv: FileTree = { Dockerfile: dockerfile('FROM ghcr.io/astral-sh/uv:0.12', 'CMD ["x"]'), 'package.json': '{"dependencies":{"a":"1"}}' };
    const node: FileTree = { Dockerfile: dockerfile('FROM node:22 AS build', 'FROM node:22-slim', 'CMD ["node", "x.js"]'), 'package.json': '{}' };
    expect(detectRuntime(uv).value).toBe('python');
    expect(detectRuntime(bareUv).value).toBe('node');
    expect(detectRuntime(node).value).toBe('node');
  });

  it('keeps the copied-stage fallback when the lineage names no runtime image (grafana shape)', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM golang:1.25 AS go-builder', 'FROM node:22 AS js-builder', 'FROM ubuntu:24.04', 'COPY --from=go-builder /out/app /app', 'CMD ["/app"]'),
    };
    expect(detectRuntime(tree).value).toBe('go');
  });

  it('ignores a tooling go.mod and an empty package.json next to a python app', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM registry.example/base:app', 'EXPOSE 8080', 'ENTRYPOINT ["/e.sh"]'),
      'go.mod': 'module x/devtools\ntool example.com/shfmt\nrequire a v1 // indirect\n',
      'package.json': '{"name":"x","dependencies":{}}',
      'requirements.txt': 'flask\n',
      'app/main.py': 'import flask',
    };
    expect(detectRuntime(tree).value).toBe('python');
  });

  it('keeps go when the go.mod has Go source below it', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM registry.example/base:app', 'EXPOSE 8080', 'ENTRYPOINT ["/e.sh"]'),
      'go.mod': 'module x/app\nrequire a v1\n',
      'cmd/main.go': 'package main',
      'requirements.txt': 'flask\n',
    };
    expect(detectRuntime(tree).value).toBe('go');
  });

  it('falls back to a tooling manifest when nothing else remains', () => {
    expect(detectRuntime({ 'go.mod': 'module x\n' }).value).toBe('go');
  });

  it('reads the Go source below a go.mod from the full path list', () => {
    const tree: FileTree = { 'go.mod': 'module x\n', 'requirements.txt': 'flask\n' };
    Object.defineProperty(tree, TREE_PATHS, { value: ['go.mod', 'requirements.txt', 'cmd/main.go'] });
    expect(detectRuntime(tree).value).toBe('go');
  });
});

describe('framework belongs to the image runtime', () => {
  const desktop = { 'desktop/package.json': '{"devDependencies":{"express":"4"}}' };

  it('has no Node framework for a Go image, whatever a desktop shell depends on', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM golang:1.25 AS build', 'FROM scratch', 'EXPOSE 3456', 'ENTRYPOINT ["/app"]'),
      'go.mod': 'module x\n',
      'main.go': 'package main',
      ...desktop,
    };
    expect(detectFramework(tree).detected).toBe(false);
  });

  it('still names the framework of a Node image', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM node:22', 'EXPOSE 3000', 'CMD ["node", "x.js"]'),
      'package.json': '{"dependencies":{"express":"4"}}',
    };
    expect(detectFramework(tree).value).toBe('express');
  });

  it('names the framework when no Dockerfile is selected', () => {
    expect(detectFramework({ 'package.json': '{"dependencies":{"express":"4"}}' }).value).toBe('express');
  });

  it('names Nest before Express, and keeps Express without Nest', () => {
    expect(detectFramework({ 'package.json': '{"dependencies":{"express":"4","@nestjs/core":"10"}}' }).value).toBe('@nestjs/core');
    expect(detectFramework({ 'package.json': '{"dependencies":{"express":"4","nest":"1"}}' }).value).toBe('nest');
    expect(detectFramework({ 'package.json': '{"dependencies":{"express":"4","next":"15"}}' }).value).toBe('express');
  });
});

describe('port belongs to the selected application', () => {
  const compose = (extra = ''): string =>
    [
      'services:',
      '  app:',
      '    image: ghcr.io/acme/app:latest',
      '    ports:',
      "      - '4007:5000'",
      '  db:',
      '    image: postgres:16',
      extra,
    ].join('\n');

  it('uses the published port of the one application service over a source default (postiz shape)', () => {
    const tree: FileTree = {
      'Dockerfile.dev': dockerfile('FROM node:22', 'CMD ["sh", "-c", "nginx && pnpm run pm2"]'),
      'docker-compose.yaml': compose(),
      'apps/backend/src/main.ts': 'listen(process.env.PORT || 3000)',
    };
    expect(detectPort(tree).value).toBe('5000');
  });

  it('does not read a port default from a test file', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM node:22', 'CMD ["node", "x.js"]'),
      'src/__tests__/server.ts': 'listen(process.env.PORT || 4000)',
    };
    expect(detectPort(tree).value).not.toBe('4000');
  });

  it('keeps the source default when two application services publish a port', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM node:22', 'CMD ["node", "x.js"]'),
      'docker-compose.yaml': ['services:', '  a:', '    image: acme/a', '    ports:', "      - '1:5000'", '  b:', '    image: acme/b', '    ports:', "      - '2:6000'"].join('\n'),
      'src/main.ts': 'listen(process.env.PORT || 3000)',
    };
    expect(detectPort(tree).value).toBe('3000');
  });
});

describe('a suggested command resolves inside the runtime image', () => {
  it('maps a Django manage.py to the image working directory (paperless shape)', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM python:3.13', 'WORKDIR /usr/src/paperless/src/', 'COPY ./src ./', 'CMD ["gunicorn"]'),
      'src/manage.py': 'DJANGO_SETTINGS_MODULE',
    };
    expect(pathInRuntimeImage(tree, 'src/manage.py')).toBe('manage.py');
  });

  it('follows COPY --from through a builder stage', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM python:3 AS builder', 'COPY . /opt/app/', 'FROM python:3', 'WORKDIR /opt/app', 'COPY --from=builder /opt/app/ /opt/app/', 'CMD ["x"]'),
      'api/manage.py': '',
    };
    expect(pathInRuntimeImage(tree, 'api/manage.py')).toBe('api/manage.py');
  });

  it('gives an absolute path outside the working directory, and resolves a context subdirectory', () => {
    const outside: FileTree = {
      Dockerfile: dockerfile('FROM python:3', 'WORKDIR /app', 'COPY src /srv/code/', 'CMD ["x"]'),
      'src/manage.py': '',
    };
    const sub: FileTree = {
      'docker/Dockerfile': dockerfile('FROM python:3', 'WORKDIR /app', 'COPY manage.py .', 'CMD ["x"]'),
      'docker/manage.py': '',
    };
    expect(pathInRuntimeImage(outside, 'src/manage.py')).toBe('/srv/code/manage.py');
    expect(pathInRuntimeImage(sub, 'docker/manage.py')).toBe('manage.py');
  });

  it('gives no path when the image never copies the file', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile('FROM python:3', 'WORKDIR /app', 'COPY requirements.txt .', 'CMD ["x"]'),
      'src/manage.py': '',
    };
    expect(pathInRuntimeImage(tree, 'src/manage.py')).toBeNull();
    expect(pathInRuntimeImage({ 'src/manage.py': '' }, 'src/manage.py')).toBeNull();
  });

  it('suggests the image path of the migration command, and no command for a file the image never copies', () => {
    const django = 'import os\nos.environ.setdefault("DJANGO_SETTINGS_MODULE", "x.settings")\n';
    const base = { 'requirements.txt': 'django\npsycopg2\n', 'src/settings.py': 'DATABASES = {"default": {"ENGINE": "django.db.backends.postgresql"}}', 'src/manage.py': django };
    const copied = analyseRepo({ ...base, Dockerfile: dockerfile('FROM python:3.13', 'WORKDIR /usr/src/app/src/', 'COPY ./src ./', 'CMD ["gunicorn"]') });
    const notCopied = analyseRepo({ ...base, Dockerfile: dockerfile('FROM python:3.13', 'WORKDIR /app', 'COPY requirements.txt .', 'CMD ["gunicorn"]') });
    expect(copied.metadata['suggestedMigrationCommand']).toBe('python manage.py migrate --noinput');
    expect(notCopied.metadata['suggestedMigrationCommand']).toBeUndefined();
  });
});

describe('dependency evidence is scoped', () => {
  it('does not read an indirect go.mod module as an S3 client', () => {
    const indirect: FileTree = { 'go.mod': 'require (\n\tgithub.com/aws/aws-sdk-go-v2/service/s3 v1.1.0 // indirect\n)\n', 'main.go': 'package main' };
    const direct: FileTree = { 'go.mod': 'require (\n\tgithub.com/aws/aws-sdk-go-v2/service/s3 v1.1.0\n)\n', 'main.go': 'package main' };
    expect(detectS3(indirect).detected).toBe(false);
    expect(detectS3(direct).detected).toBe(true);
  });

  it('keeps an indirect go.mod driver as PostgreSQL driver evidence', () => {
    const tree: FileTree = { 'go.mod': 'require (\n\tgorm.io/driver/postgres v1.6.0\n\tgithub.com/jackc/pgx/v5 v5.7.6 // indirect\n)\n', 'main.go': 'package main' };
    expect(detectPostgresql(tree).detected).toBe(true);
  });
});

describe('a base image selected by a build argument is a required input', () => {
  const required = (tree: FileTree): string[] =>
    detectEnvVarModel(tree)
      .filter((variable) => variable.required)
      .map((variable) => variable.key);

  it('requires a global ARG without a default that a FROM reads (coder shape)', () => {
    const tree: FileTree = { Dockerfile: dockerfile('ARG BASE_IMAGE', 'FROM ${BASE_IMAGE}', 'CMD ["x"]') };
    const variable = detectEnvVarModel(tree).find((entry) => entry.key === 'BASE_IMAGE');
    expect(variable?.required).toBe(true);
    expect(variable?.source.join(' ')).toContain('selects the base image; the build fails without it');
  });

  it('follows a FROM of the stage lineage', () => {
    const tree: FileTree = { Dockerfile: dockerfile('ARG TAG', 'FROM base:$TAG AS base', 'FROM base', 'CMD ["x"]') };
    expect(required(tree)).toContain('TAG');
  });

  it('follows a FROM that selects a stage by a build argument (livebook shape)', () => {
    const tree: FileTree = {
      Dockerfile: dockerfile(
        'ARG BASE_IMAGE',
        'ARG VARIANT',
        'FROM ${BASE_IMAGE} AS base-default',
        'FROM ${BASE_IMAGE} AS base-cuda',
        'FROM base-${VARIANT}',
        'CMD ["x"]',
      ),
    };
    expect(required(tree)).toEqual(expect.arrayContaining(['BASE_IMAGE', 'VARIANT']));
  });

  it('does not require an ARG with a default, an ARG used only in RUN, or one a Compose file sets', () => {
    expect(required({ Dockerfile: dockerfile('ARG BASE_IMAGE=node:22', 'FROM ${BASE_IMAGE}', 'CMD ["x"]') })).not.toContain('BASE_IMAGE');
    expect(required({ Dockerfile: dockerfile('ARG VERSION', 'FROM node:22', 'ARG VERSION', 'RUN echo $VERSION', 'CMD ["x"]') })).not.toContain('VERSION');
    const composed: FileTree = {
      Dockerfile: dockerfile('ARG BASE_IMAGE', 'FROM ${BASE_IMAGE}', 'CMD ["x"]'),
      'docker-compose.yml': ['services:', '  app:', '    build:', '      context: .', '      args:', '        BASE_IMAGE: node:22'].join('\n'),
    };
    const entry = detectEnvVarModel(composed).find((variable) => variable.key === 'BASE_IMAGE');
    expect(entry?.source.join(' ')).not.toContain('selects the base image');
  });
});

describe('a development-named Dockerfile is dev-only only when its content agrees', () => {
  const paths = (tree: FileTree, list: string[]): FileTree => Object.defineProperty(tree, TREE_PATHS, { value: list });

  it('accepts a sole Dockerfile.dev that builds the app and starts it for production (postiz shape)', () => {
    const tree = paths({ 'Dockerfile.dev': dockerfile('FROM node:22', 'RUN pnpm run build', 'CMD ["node", "server.js"]') }, ['Dockerfile.dev']);
    expect(detectUnbuildableDockerfile(tree)).toBeNull();
  });

  it('rejects a sole Dockerfile.dev that starts a dev server, starts nothing, or builds nothing', () => {
    const devServer = paths({ 'Dockerfile.dev': dockerfile('FROM node:22', 'RUN pnpm run build', 'CMD ["pnpm", "dev"]') }, ['Dockerfile.dev']);
    const noStart = paths({ 'Dockerfile.dev': dockerfile('FROM node:22', 'RUN pnpm run build') }, ['Dockerfile.dev']);
    const noBuild = paths({ 'Dockerfile.dev': dockerfile('FROM node:22', 'COPY . .', 'CMD ["node", "server.js"]') }, ['Dockerfile.dev']);
    for (const tree of [devServer, noStart, noBuild]) expect(detectUnbuildableDockerfile(tree)).toContain('development or a template');
  });
});

describe('Compose infrastructure is not an application service', () => {
  const services = (compose: string): string[] =>
    composeApplicationServices({ 'docker-compose.yml': compose })?.services.map((service) => service.name) ?? [];

  it('drops a database whose image name omits "postgres" (lobehub, lemmy shapes)', () => {
    const paradedb = ['services:', '  app:', '    image: acme/app', '  postgresql:', '    image: paradedb/paradedb:latest-pg17', "    command: ['postgres','-c','shared_preload_libraries=pg_search']"].join('\n');
    const upgrade = ['services:', '  app:', '    image: acme/app', '  db:', '    image: someorg/pgautoupgrade:18-alpine', '    command: postgres'].join('\n');
    expect(services(paradedb)).toEqual(['app']);
    expect(services(upgrade)).toEqual(['app']);
  });

  it('drops a database by its command, its health probe or its data volume', () => {
    const command = ['services:', '  app:', '    image: acme/app', '  store:', '    image: acme/store', '    command: redis-server --appendonly yes'].join('\n');
    const probe = ['services:', '  app:', '    image: acme/app', '  store:', '    image: acme/store', '    healthcheck:', '      test: ["CMD", "pg_isready"]'].join('\n');
    const volume = ['services:', '  app:', '    image: acme/app', '  store:', '    image: acme/store', '    volumes:', '      - ./data:/var/lib/mysql'].join('\n');
    for (const compose of [command, probe, volume]) expect(services(compose)).toEqual(['app']);
  });

  it('keeps two services built from their own images, and an app that sets POSTGRES_* to connect', () => {
    const two = ['services:', '  web:', '    build: ./web', '  api:', '    build: ./api'].join('\n');
    const connecting = ['services:', '  server:', '    image: acme/server', '    environment:', '      - POSTGRES_PASSWORD=x', '  db:', '    image: postgres:16'].join('\n');
    const named = ['services:', '  postgres:', '    image: acme/custom-api', '    command: node server.js'].join('\n');
    expect(services(two)).toEqual(['web', 'api']);
    expect(services(connecting)).toEqual(['server']);
    expect(services(named)).toEqual(['postgres']);
  });
});

describe('databaseState follows the required engine', () => {
  it('is unsupported for a SQLite app that only has an unrequired PostgreSQL ORM (karakeep shape)', () => {
    const tree: FileTree = { 'package.json': '{"dependencies":{"better-sqlite3":"11","drizzle-orm":"0.3"}}' };
    expect(analyseRepo(tree).metadata['databaseState']).toBe('unsupported');
  });

  it('stays postgres for a driver without a requirement, and for a required PostgreSQL', () => {
    const driverOnly: FileTree = { 'package.json': '{"dependencies":{"pg":"8"}}' };
    const required: FileTree = {
      'package.json': '{"dependencies":{"pg":"8"}}',
      'docker-compose.yml': ['services:', '  app:', '    image: acme/app', '  db:', '    image: postgres:16'].join('\n'),
      '.env.example': 'DATABASE_URL=postgres://u:p@db:5432/app\n',
    };
    const driver = analyseRepo(driverOnly).metadata;
    expect(driver['databaseState']).toBe('postgres');
    expect((driver['postgres'] as { required: boolean }).required).toBe(false);
    expect(analyseRepo(required).metadata['databaseState']).toBe('postgres');
  });

  it('is none without any database evidence', () => {
    expect(analyseRepo({ 'package.json': '{"dependencies":{"express":"4"}}' }).metadata['databaseState']).toBe('none');
  });
});

describe('workerNeedsProcess separates in-process job libraries from separate worker processes', () => {
  const needs = (tree: FileTree): unknown => analyseRepo(tree).metadata['workerNeedsProcess'];

  it('is false when every pattern runs inside the web process, and the worker fact stays detected', () => {
    for (const dependency of ['bull', 'bullmq', 'agenda', 'pg-boss', 'graphile-worker', 'bree']) {
      const result = analyseRepo({ 'package.json': `{"dependencies":{"${dependency}":"1"}}` });
      expect(result.metadata['hasWorkerProcesses']).toBe(true);
      expect(result.metadata['workerNeedsProcess']).toBe(false);
    }
    expect(needs({ 'src/pool.js': "const { Worker } = require('node:worker_threads');" })).toBe(false);
  });

  it('is true for a separate consumer, a declared process or a Compose worker service', () => {
    expect(needs({ 'requirements.txt': 'celery\n' })).toBe(true);
    expect(needs({ 'package.json': '{"dependencies":{"bull":"4"}}', Procfile: 'web: node server.js\nworker: node dist/worker.js\n' })).toBe(true);
    expect(needs({ 'docker-compose.yml': ['services:', '  app:', '    image: acme/app', '  worker:', '    image: acme/app'].join('\n') })).toBe(true);
  });

  it('is false when no worker evidence exists', () => {
    expect(needs({ 'package.json': '{"dependencies":{"express":"4"}}' })).toBe(false);
  });
});
