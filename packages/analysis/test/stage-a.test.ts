import { describe, expect, it } from 'vitest';

import { analyseRepo, type FileTree } from '../src/analyser.js';
import {
  assessPostgres,
  detectDockerfile,
  detectEnvVarModel,
  detectHealthEndpoint,
  detectLocalFilesystem,
  detectPort,
  detectS3,
  detectStartupCommand,
} from '../src/detectors.js';
import { evaluateManifestReadiness, normalizeDeploymentManifest } from '../src/manifest.js';
import { assessRedis } from '../src/redis.js';
import {
  checkDockerComposeMultiService,
  checkGcp,
  checkKafka,
  checkMysql,
  checkRabbitMq,
  checkSqlite,
} from '../src/rejection.js';

// Stage A regression fixtures — each describes a shape found in the
// repository-compatibility audit and pins the analyser behaviour the fix
// established. The Stage A corpus and its findings registry were removed on
// 2026-10-18; see docs/testing/compatibility.md for the Docker run-and-check test.

describe('COMP-001 — the container port from the Dockerfile and Compose', () => {
  it('reads ENV PORT from the selected Dockerfile', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22-alpine\nENV HOSTNAME=0.0.0.0\nENV PORT=3000\nEXPOSE 3000\nCMD ["sh", "scripts/start-docker.sh"]\n',
      'package.json': JSON.stringify({ dependencies: { next: '16.0.0' } }),
    };
    expect(detectPort(tree)).toMatchObject({ detected: true, value: '3000', details: expect.stringContaining('ENV PORT') });
  });

  it('reads EXPOSE, including the `${PORT:-n}` default form', () => {
    expect(detectPort({ Dockerfile: 'FROM golang:alpine\nEXPOSE 4242\nCMD ["node", "dist/server.js"]\n' })).toMatchObject({
      detected: true,
      value: '4242',
    });
    expect(detectPort({ Dockerfile: 'FROM node:22-slim\nEXPOSE ${PORT:-3333}\nCMD ["/entrypoint.sh"]\n' })).toMatchObject({
      detected: true,
      value: '3333',
    });
  });

  it('prefers the selected Dockerfile (ENV PORT, then EXPOSE) over a code default from any runtime', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nENV PORT=8080\nEXPOSE 8080\n',
      'src/index.ts': 'app.listen(process.env.PORT || 3000);\n',
    };
    expect(detectPort(tree).value).toBe('8080');
    // A Django image next to a Node frontend: the frontend's code default
    // must not become the API container's port.
    const multiRuntime: FileTree = {
      Dockerfile: 'FROM python:3.12\nEXPOSE 8000\nCMD ["gunicorn", "app.wsgi"]\n',
      'frontend/api/index.js': 'app.listen(process.env.PORT || 8080);\n',
    };
    expect(detectPort(multiRuntime).value).toBe('8000');
    const codeOnly: FileTree = {
      Dockerfile: 'FROM node:22\nCMD ["node", "server.js"]\n',
      'server.js': 'app.listen(process.env.PORT || 3000);\n',
    };
    expect(detectPort(codeOnly).value).toBe('3000');
  });

  it('reads the container side of a production Compose port mapping', () => {
    const tree: FileTree = {
      'docker/Dockerfile': 'FROM python:3.12\nCMD ["uwsgi", "docker/uwsgi.ini"]\n',
      'docker/docker-compose.yml': 'services:\n  web:\n    build: ..\n    ports:\n      - "8000:8000"\n  db:\n    image: postgres:16\n',
    };
    expect(detectPort(tree)).toMatchObject({ detected: true, value: '8000' });
  });

  it('ignores a dev Compose mapping and still reports nothing when no source documents the port', () => {
    expect(detectPort({ 'docker/development/compose.yml': 'services:\n  web:\n    ports:\n      - "3000:3000"\n' })).toMatchObject({
      detected: false,
    });
  });
});

describe('COMP-004 / COMP-005 — health paths', () => {
  it('does not turn a model or controller file named health*/heartbeat* into a URL', () => {
    expect(detectHealthEndpoint({ 'server/model/heartbeat.js': 'module.exports = class Heartbeat {};\n' })).toMatchObject({
      detected: false,
    });
    const controller = detectHealthEndpoint({
      'packages/backend/src/controllers/healthcheck.js': 'export default (req, res) => res.json({ ok: true });\n',
    });
    expect(controller.detected).toBe(false);
  });

  it('registers a router mounted at a health prefix, composed through its mount chain', () => {
    const tree: FileTree = {
      'src/routes/index.js': "apiRouter.use('/healthcheck', healthcheckRouter);\napp.use('/api', apiRouter);\n",
      'src/routes/healthcheck.js': "router.get('/', (req, res) => res.send('ok'));\n",
    };
    expect(detectHealthEndpoint(tree)).toMatchObject({ detected: true, path: '/api/healthcheck' });
  });

  it('reads the URL a Dockerfile HEALTHCHECK probes, above a route registration in code', () => {
    const healthcheckOnly: FileTree = {
      Dockerfile: 'FROM node:22\nHEALTHCHECK --interval=5s CMD curl -f http://localhost:3000/api/heartbeat || exit 1\n',
    };
    expect(detectHealthEndpoint(healthcheckOnly)).toMatchObject({ detected: true, path: '/api/heartbeat' });

    const withRoute: FileTree = {
      ...healthcheckOnly,
      'src/index.ts': "app.get('/health', (_req, res) => res.json({ ok: true }));\n",
    };
    expect(detectHealthEndpoint(withRoute).path).toBe('/api/heartbeat');
  });

  it('reads the URL a production Compose healthcheck probes', () => {
    const tree: FileTree = {
      'docker-compose.yml':
        'services:\n  umami:\n    image: ghcr.io/umami/umami\n    healthcheck:\n      test: ["CMD-SHELL", "curl http://localhost:3000/api/heartbeat"]\n',
    };
    expect(detectHealthEndpoint(tree)).toMatchObject({ detected: true, path: '/api/heartbeat' });
  });

  it('reads Go, Python and Ruby route registrations', () => {
    expect(
      detectHealthEndpoint({ 'internal/http/server/routes.go': 'appMux.HandleFunc("GET /healthcheck", readinessProbe)\n' }).path,
    ).toBe('/healthcheck');
    expect(detectHealthEndpoint({ 'api/api.go': 'app.Get("/health", func(c *fiber.Ctx) error { return nil })\n' }).path).toBe(
      '/health',
    );
    expect(detectHealthEndpoint({ 'cmd/handlers.go': 'g.GET("/api/health", a.HealthCheck)\n' }).path).toBe('/api/health');
    expect(detectHealthEndpoint({ 'app/views.py': "@app.route('/healthz')\ndef healthz():\n    return 'ok'\n" }).path).toBe(
      '/healthz',
    );
    expect(detectHealthEndpoint({ 'hc/urls.py': "urlpatterns = [path('health/', views.health)]\n" }).path).toBe('/health');
    expect(detectHealthEndpoint({ 'config/routes.rb': "get '/health', to: 'health#show'\n" }).path).toBe('/health');
  });

  it('ignores route registrations in test files', () => {
    expect(detectHealthEndpoint({ 'api/api_test.go': 'app.Get("/health", handler)\n' })).toMatchObject({ detected: false });
  });
});

describe('COMP-007 — Dockerfile ranking', () => {
  it('ranks dev-container, test, example and OS-package Dockerfiles below the application one', () => {
    const tree: FileTree = {
      '.devcontainer/Dockerfile': 'FROM mcr.microsoft.com/devcontainers/base\n',
      'docker/Dockerfile': 'FROM node:22-alpine\nENV PORT=3000\nEXPOSE 3000\nENTRYPOINT ["sh", "/entrypoint.sh"]\n',
      'docker/Dockerfile.compose': 'FROM automatischio/automatisch:latest\n',
    };
    expect(detectDockerfile(tree).value).toBe('docker/Dockerfile');

    const packaging: FileTree = {
      'packaging/debian/Dockerfile': 'FROM debian:bookworm\nCMD ["/src/packaging/debian/build.sh"]\n',
      'packaging/rpm/Dockerfile': 'FROM rockylinux:9\n',
      'packaging/docker/alpine/Dockerfile': 'FROM alpine:3.24\nEXPOSE 8080\nCMD ["/usr/bin/miniflux"]\n',
      'packaging/docker/distroless/Dockerfile': 'FROM gcr.io/distroless/base-debian13\nEXPOSE 8080\n',
    };
    expect(detectDockerfile(packaging).value).toBe('packaging/docker/alpine/Dockerfile');
  });

  it('reads the startup command from the selected Dockerfile only', () => {
    const tree: FileTree = {
      'apps/remix/Dockerfile.bun': 'FROM oven/bun\nCMD ["bun", "run", "start"]\n',
      'docker/Dockerfile': 'FROM node:22\nCMD ["sh", "start.sh"]\n',
    };
    expect(detectStartupCommand(tree).value).toEqual(['CMD: ["sh", "start.sh"]']);
  });
});

describe('COMP-003 — local-filesystem writes outside runtime code', () => {
  it('ignores build scripts, docs generators, release tooling and tests', () => {
    const tree: FileTree = {
      'scripts/build-geo.js': "fs.mkdirSync(dest);\nfs.writeFileSync(dest + '/geo.mmdb', data);\n",
      'docs/api/generate.js': 'fs.writeFile(out, json, () => {});\n',
      'extra/release/lib.mjs': 'fs.writeFileSync(file, content);\n',
      'src/upload.test.ts': "fs.writeFileSync('/tmp/x', 'y');\n",
      'packages/cli/src/commands/asset.spec.ts': "fs.writeFileSync('a', 'b');\n",
      'machine-learning/test_main.py': "Path('x').write_text('y')\n",
    };
    expect(detectLocalFilesystem(tree)).toMatchObject({ detected: false });
  });

  it('still detects a declared upload volume', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nVOLUME /app/uploads\nCMD ["node", "server.js"]\n',
      'src/server/routes/upload.ts': "fs.writeFileSync(path.join(UPLOAD_DIR, name), buffer);\n",
    };
    expect(detectLocalFilesystem(tree)).toMatchObject({ detected: true, value: ['VOLUME /app/uploads (Dockerfile)'] });
  });
});

describe('COMP-012 — object storage needs S3-specific evidence', () => {
  it('does not treat the umbrella AWS SDKs as S3 usage', () => {
    expect(detectS3({ 'go.mod': 'module x\n\nrequire github.com/aws/aws-sdk-go-v2 v1.30.0\n' })).toMatchObject({ detected: false });
    expect(detectS3({ 'package.json': JSON.stringify({ dependencies: { 'aws-sdk': '^2.1600.0' } }) })).toMatchObject({
      detected: false,
    });
    expect(detectS3({ 'requirements.txt': 'boto3==1.34.0\n', 'export.py': "import boto3\nses = boto3.client('ses')\n" })).toMatchObject({
      detected: false,
    });
  });

  it('detects an S3 client built from the umbrella SDKs', () => {
    expect(
      detectS3({ 'package.json': JSON.stringify({ dependencies: { 'aws-sdk': '^2.1600.0' } }), 'src/storage.js': 'const s3 = new AWS.S3();\n' })
        .value,
    ).toEqual(['aws-sdk']);
    expect(detectS3({ 'upload.py': "import boto3\ns3 = boto3.client('s3')\n" }).value).toEqual(['boto3']);
  });
});

describe('COMP-013 — PostgreSQL requirement evidence beyond root JS files', () => {
  it('accepts a PostgreSQL image in a nested or variant production Compose file', () => {
    const nested: FileTree = {
      'requirements.txt': 'psycopg[c]==3.2.0\n',
      'docker/docker-compose.yml': 'services:\n  db:\n    image: postgres:16\n  web:\n    build: ..\n',
    };
    expect(assessPostgres(nested).required).toBe(true);

    const variant: FileTree = {
      'package.json': JSON.stringify({ dependencies: { pg: '^8.12.0', knex: '^3.0.0' } }),
      'docker-compose.postgres.yml': 'services:\n  postgres:\n    image: postgres\n',
    };
    expect(assessPostgres(variant).required).toBe(true);
  });

  it('accepts a DATABASE_URL literal in Go, Python or Ruby configuration', () => {
    const go: FileTree = {
      'go.mod': 'module miniflux\n\nrequire github.com/lib/pq v1.12.3\n',
      'main.go': 'package main\nimport _ "github.com/lib/pq"\n',
      'internal/config/options.go': 'case "DATABASE_URL":\n\tparser.parseString(value)\n',
    };
    expect(assessPostgres(go).required).toBe(true);
  });

  it('still needs more than an indirect driver, and ignores a dev Compose file', () => {
    const tree: FileTree = {
      'go.mod': 'module x\n\nrequire github.com/lib/pq v1.12.3 // indirect\n',
      'docker/development/compose.yml': 'services:\n  db:\n    image: postgres:16\n',
    };
    expect(assessPostgres(tree).required).toBe(false);
  });
});

describe('COMP-016 — platform and tooling variables are never required', () => {
  it('ignores reads in test runners, tool configs and scripts, and platform-provided names', () => {
    const tree: FileTree = {
      'playwright.config.ts': 'const skip = process.env.PLAYWRIGHT_SKIP_WEB_SERVER;\nexport default { reuse: !process.env.CI };\n',
      'scripts/check-env.js': 'const url = process.env.TRACKER_SCRIPT_URL;\n',
      'src/lib/config.ts': [
        'export const env = process.env.NODE_ENV;',
        'export const port = process.env.PORT;',
        'export const vercel = process.env.VERCEL;',
        'export const secret = hash(process.env.APP_SECRET);',
        '',
      ].join('\n'),
    };
    const required = detectEnvVarModel(tree).filter((v) => v.required).map((v) => v.key);
    expect(required).toEqual(['APP_SECRET']);
  });
});

describe('COMP-017 — reads that carry their own default', () => {
  it('treats the alternative of a `??`/`||` chain and a defaulting helper argument as defaulted', () => {
    const tree: FileTree = {
      'src/lib/create-config.ts': [
        'const port = parseEnvVarNumber(process.env.HTTP_PORT || process.env.PORT, 4242);',
        "const host = parseEnvVarString(process.env.HTTP_HOST, '0.0.0.0');",
        'const response = await axios.get(process.env.API_URL, { headers });',
        'const url = process.env.NEXT_PRIVATE_DATABASE_URL ?? process.env.POSTGRES_URL;',
        "const secret = process.env.UNLEASH_SECRET || 'super-secret';",
        'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2024-01-01" });',
        'const salt = createHash(process.env.ACCESS_TOKEN_SALT);',
        '',
      ].join('\n'),
    };
    const required = detectEnvVarModel(tree).filter((v) => v.required).map((v) => v.key);
    // A `??` chain of two variables requires one of them — the model cannot
    // say which, so it fails open and requires neither.
    expect(required).toEqual(['ACCESS_TOKEN_SALT', 'API_URL', 'STRIPE_SECRET_KEY']);
  });
});

describe('COMP-023 — a bare read stored in configuration is optional unless the code refuses to run without it', () => {
  it('treats assignments and property values as optional, and a throw-guarded one as required', () => {
    const tree: FileTree = {
      'src/lib/create-config.ts': [
        'const defaultServerOption = {',
        '  host: process.env.HTTP_HOST,',
        '  cdnPrefix: process.env.CDN_PREFIX,',
        '};',
        'const openAIAPIKey = process.env.OPENAI_API_KEY;',
        'export const KAFKA_URL = process.env.KAFKA_URL;',
        'const secret = process.env.JWT_SECRET;',
        'if (!secret) {',
        "  throw new Error('JWT_SECRET is not set');",
        '}',
        'const url = process.env.WEBHOOK_URL;',
        "if (!process.env.WEBHOOK_URL) throw new Error('WEBHOOK_URL is required');",
        'const brokers = process.env.KAFKA_BROKERS.split(",");',
        'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);',
        'const kafkaEnabled = Boolean(process.env.KAFKA_URL && process.env.KAFKA_BROKER);',
        'const clickhouseEnabled = !!process.env.CLICKHOUSE_URL;',
        '',
      ].join('\n'),
    };
    const required = detectEnvVarModel(tree).filter((v) => v.required).map((v) => v.key);
    // OPENAI_API_KEY is secret-named, so its bare read stays required;
    // HTTP_HOST, CDN_PREFIX and KAFKA_URL are options with no such claim.
    expect(required).toEqual(['JWT_SECRET', 'KAFKA_BROKERS', 'OPENAI_API_KEY', 'STRIPE_SECRET_KEY', 'WEBHOOK_URL']);
  });
});

describe('COMP-016 — the deployment gate counts every injected database variable as provided', () => {
  it('does not ask the vendor for DATABASE_HOST/PORT/NAME/USER/PASSWORD when PostgreSQL is provisioned', () => {
    const tree: FileTree = {
      Dockerfile: [
        'FROM node:22',
        'EXPOSE 4242',
        'HEALTHCHECK CMD curl -f http://localhost:4242/health || exit 1',
        'CMD ["node", "dist/server.js"]',
        '',
      ].join('\n'),
      'package.json': JSON.stringify({ scripts: { start: 'node dist/server.js' }, dependencies: { pg: '^8.12.0' } }),
      '.env.example': 'DATABASE_URL=\n',
      'src/lib/create-config.ts': [
        'const host = process.env.DATABASE_HOST;',
        'const port = process.env.DATABASE_PORT;',
        'const name = process.env.DATABASE_NAME;',
        'const user = process.env.DATABASE_USER;',
        'const password = process.env.DATABASE_PASSWORD;',
        'const url = process.env.DATABASE_URL;',
        '',
      ].join('\n'),
    };
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(manifest.database.postgres).toBe(true);
    expect(evaluateManifestReadiness(manifest, { providedEnvKeys: [] })).toMatchObject({ state: 'READY' });
  });
});

describe('COMP-006 / COMP-020 — the manifest never carries a detector label, and tooling directories are not app roots', () => {
  it('leaves migration.command null instead of a pattern label when no command resolved', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:22\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
      'package.json': JSON.stringify({
        scripts: { start: 'node server.js', 'update-db': 'prisma migrate deploy' },
        dependencies: { '@prisma/client': '^5.0.0', pg: '^8.0.0' },
      }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
    };
    const analysis = analyseRepo(tree);
    expect(analysis.metadata['migrationCommands']).toEqual(['prisma migrate']);
    expect(normalizeDeploymentManifest(analysis, {}).migration.command).toBeNull();
    expect(normalizeDeploymentManifest(analysis, { migrationCommand: 'prisma migrate deploy' }).migration.command).toBe(
      'prisma migrate deploy',
    );
  });

  it('treats docker/, packaging/ and .devcontainer/ Dockerfile directories as the repository root', () => {
    for (const dockerfilePath of ['docker/Dockerfile', 'packaging/docker/alpine/Dockerfile', '.devcontainer/Dockerfile']) {
      const manifest = normalizeDeploymentManifest({ metadata: { hasDockerfile: true, dockerfilePath } }, {});
      expect(manifest.application.root).toBe('.');
    }
    expect(normalizeDeploymentManifest({ metadata: { dockerfilePath: 'apps/api/Dockerfile' } }, {}).application.root).toBe('apps/api');
  });
});

describe('COMP-002 — optional or configurable dependencies are not architecture', () => {
  it('does not reject a SQL engine driver declared next to a PostgreSQL driver', () => {
    const kutt: FileTree = {
      'package.json': JSON.stringify({
        dependencies: { express: '^4.19.0', knex: '^3.0.0', pg: '^8.12.0', 'better-sqlite3': '^11.0.0', mysql2: '^3.0.0' },
      }),
    };
    expect(checkSqlite(kutt).detected).toBe(false);
    expect(checkMysql(kutt).detected).toBe(false);

    const gatus: FileTree = {
      'go.mod': 'module gatus\n\nrequire (\n\tgithub.com/lib/pq v1.10.9\n\tmodernc.org/sqlite v1.29.0\n)\n',
    };
    expect(checkSqlite(gatus).detected).toBe(false);
  });

  it('still rejects a lone SQLite driver; MySQL and a Prisma mysql provider are SUPPORTED (Phase 4B)', () => {
    expect(checkSqlite({ 'package.json': JSON.stringify({ dependencies: { 'better-sqlite3': '^11.0.0' } }) }).detected).toBe(true);
    // knex is dialect-agnostic: it does not make a SQLite app configurable.
    expect(
      checkSqlite({ 'package.json': JSON.stringify({ dependencies: { knex: '^3.0.0', 'better-sqlite3': '^11.0.0' } }) }).detected,
    ).toBe(true);
    expect(checkMysql({ 'package.json': JSON.stringify({ dependencies: { mysql2: '^3.0.0' } }) }).detected).toBe(false);
    const prismaMysql: FileTree = {
      'package.json': JSON.stringify({ dependencies: { '@prisma/client': '^5.0.0', pg: '^8.12.0' } }),
      'prisma/schema.prisma': 'datasource db {\n  provider = "mysql"\n}\n',
    };
    expect(checkMysql(prismaMysql).detected).toBe(false);
  });

  it('rejects a broker client only with a production Compose service or a required connection variable', () => {
    const optional: FileTree = {
      'package.json': JSON.stringify({ dependencies: { kafkajs: '^2.1.0', pg: '^8.12.0' } }),
      'src/lib/kafka.ts': 'if (process.env.KAFKA_URL) {\n  producer = new Kafka({ brokers: [process.env.KAFKA_URL] });\n}\n',
    };
    expect(checkKafka(optional).detected).toBe(false);

    const required: FileTree = {
      'package.json': JSON.stringify({ dependencies: { kafkajs: '^2.1.0' } }),
      'src/consumer.ts': "const brokers = process.env.KAFKA_BROKERS.split(',');\n",
    };
    expect(checkKafka(required).detected).toBe(true);
    // A presence test in an unrelated file does not excuse an unconditional consumer.
    expect(
      checkKafka({ ...required, 'src/metrics.ts': 'if (process.env.KAFKA_BROKERS) { report(); }\n' }).detected,
    ).toBe(true);

    const composed: FileTree = {
      'package.json': JSON.stringify({ dependencies: { amqplib: '^0.10.0' } }),
      'docker-compose.yml': 'services:\n  app:\n    build: .\n  rabbitmq:\n    image: rabbitmq:3-management\n',
    };
    expect(checkRabbitMq(composed).detected).toBe(true);
    expect(checkRabbitMq({ 'package.json': JSON.stringify({ dependencies: { amqplib: '^0.10.0' } }) }).detected).toBe(false);
  });
});

describe('COMP-008 — a distroless base image is not a Google Cloud deployment', () => {
  it('ignores gcr.io/distroless but still flags another gcr.io base', () => {
    expect(checkGcp({ 'packaging/docker/distroless/Dockerfile': 'FROM gcr.io/distroless/base-debian13:nonroot\n' }).detected).toBe(false);
    expect(checkGcp({ Dockerfile: 'FROM gcr.io/my-project/base:latest\n' }).detected).toBe(true);
  });

  it('ignores a gcr.io base in a deployment sample directory (kubernetes/minikube/)', () => {
    expect(checkGcp({ 'kubernetes/minikube/Dockerfile': 'FROM gcr.io/k8s-minikube/kicbase:v0.0.44\n' }).detected).toBe(false);
  });
});

describe('COMP-009 — Compose service counting', () => {
  it('ignores one-shot services other services wait on, and example directories', () => {
    const flagsmith: FileTree = {
      'docker-compose.yml': [
        'services:',
        '  postgres:',
        '    image: postgres:15.5-alpine',
        '  migrate-db:',
        '    image: flagsmith/flagsmith:latest',
        '    command: [migrate]',
        '  flagsmith:',
        '    image: flagsmith/flagsmith:latest',
        '    depends_on:',
        '      migrate-db:',
        '        condition: service_completed_successfully',
        '',
      ].join('\n'),
    };
    expect(checkDockerComposeMultiService(flagsmith).detected).toBe(false);
    expect(
      checkDockerComposeMultiService({
        '.examples/docker-compose-grafana/compose.yaml': 'services:\n  gatus:\n    image: twinproduction/gatus\n  grafana:\n    image: grafana/grafana\n',
      }).detected,
    ).toBe(false);
  });

  it('ignores a compose file in a test project directory (BTCPayServer.Tests/)', () => {
    const compose = 'services:\n  tests:\n    build: .\n  nbxplorer:\n    image: nicolasdorier/nbxplorer\n  merchant_lnd:\n    image: btcpayserver/lnd\n';
    expect(checkDockerComposeMultiService({ 'docker-compose.yml': compose }).detected).toBe(true);
    expect(checkDockerComposeMultiService({ 'BTCPayServer.Tests/docker-compose.yml': compose }).detected).toBe(false);
  });
});

describe('COMP-011 — Redis evidence from Compose files and guarded clients', () => {
  it('counts only the primary production Compose file as evidence, and never as a requirement alone', () => {
    const variants: FileTree = {
      'package.json': JSON.stringify({ dependencies: { express: '^4.19.0' } }),
      'docker-compose.yml': 'services:\n  server:\n    build: .\n',
      'docker-compose.postgres.yml': 'services:\n  server:\n    build: .\n  redis:\n    image: redis:alpine\n',
      'test/manual/compose.yaml': 'services:\n  redis:\n    image: redis:latest\n',
    };
    const assessment = assessRedis(variants);
    expect(assessment.required).toBe(false);
    expect(assessment.confidence).toBe('low');
    expect(assessment.evidence).toEqual([expect.stringContaining('variant')]);

    const primary: FileTree = {
      'docker/docker-compose.yml': 'services:\n  immich-server:\n    image: immich\n  redis:\n    image: docker.io/valkey/valkey:9\n',
    };
    expect(assessRedis(primary).confidence).toBe('medium');
    expect(assessRedis(primary).required).toBe(false);
  });

  it('treats a client built behind a configuration guard as optional', () => {
    const kutt: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'server/redis.js': 'const Redis = require("ioredis");\nlet client;\nif (env.REDIS_ENABLED) {\n  client = new Redis({ host: env.REDIS_HOST });\n}\n',
    };
    expect(assessRedis(kutt).required).toBe(false);
    const unconditional: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'server/redis.js': 'const Redis = require("ioredis");\nconst client = new Redis(process.env.REDIS_URL);\n',
    };
    expect(assessRedis(unconditional).required).toBe(true);
    // A braceless flag check just above scopes only its own statement.
    const bracelessAbove: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'server/redis.js': 'if (config.METRICS_ENABLED) track();\nconst client = new Redis(process.env.REDIS_URL);\n',
    };
    expect(assessRedis(bracelessAbove).required).toBe(true);
  });
});

describe('COMP-019 — a conditional Redis Cluster client is an option, not a requirement', () => {
  it('rejects only a top-level cluster construction', () => {
    const optional: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'api/core/redis_cluster.py': 'class ClusterCache:\n    def client(self):\n        return RedisCluster(**kwargs)\n',
      'src/cache.js': 'const client = new Redis(process.env.REDIS_URL);\n',
    };
    expect(assessRedis(optional).compatibility.supported).toBe(true);
    const cluster: FileTree = {
      'package.json': JSON.stringify({ dependencies: { ioredis: '^5.0.0' } }),
      'src/cache.js': 'const cluster = new Redis.Cluster([{ host: "a" }]);\n',
    };
    expect(assessRedis(cluster).compatibility.supported).toBe(false);
  });
});
