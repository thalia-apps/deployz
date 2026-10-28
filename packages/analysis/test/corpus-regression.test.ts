/**
 * Regressions from the 2026-10 analysis corpus (linkding, memos, vikunja,
 * shlink, docmost, cal.com, authentik, metabase, vaultwarden, miniflux,
 * listmonk, actual, gitea, meilisearch, qdrant; scripts/run-and-check/ground-truth/). Each case is
 * a small tree with the shape that the real repository has, and a negative
 * case that must keep the old answer.
 */
import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../src/analyser.js';
import { isDerivedUrlEnvVariable } from '../src/derived-url.js';
import {
  detectDockerfileBuildContext,
  detectDockerfileBuildTarget,
  detectDockerfileMissingCopySources,
  detectEnvVarModel,
  detectGitCopyInDockerfile,
  detectHealthEndpoint,
  detectPort,
  detectPostgresql,
  detectStartupCommand,
  detectWorker,
  selectedDockerfile,
  TREE_PATHS,
  type FileTree,
} from '../src/detectors.js';
import { normalizeDeploymentManifest } from '../src/manifest.js';
import { assessRedis } from '../src/redis.js';
import { assessMysql, checkElasticsearch, checkExplicitPersistentDataDir, checkGpu, checkKubernetes, checkNoBuildableDockerfile, checkOtherUnsupportedDatabases, checkSqlite } from '../src/rejection.js';

const envVar = (tree: FileTree, key: string) => detectEnvVarModel(tree).find((variable) => variable.key === key);

describe('the image start command', () => {
  // linkding: an unindented `CMD` continuation of a HEALTHCHECK was read as the start command.
  const linkding = [
    'FROM node:22-alpine AS node-build',
    'CMD ["node", "build.js"]',
    'FROM python:3.13-alpine AS linkding',
    'COPY . .',
    'EXPOSE 9090',
    'HEALTHCHECK --interval=30s --retries=3 --timeout=1s \\',
    'CMD curl -f http://localhost:9090/health || exit 1',
    'CMD ["./bootstrap.sh"]',
    'FROM linkding AS linkding-plus',
    'RUN apk add chromium',
    '',
  ].join('\n');

  it('is the last CMD of the production stage lineage, never a HEALTHCHECK CMD or another stage', () => {
    expect(detectStartupCommand({ Dockerfile: linkding }).value).toEqual(['CMD: ["./bootstrap.sh"]']);
  });

  it('keeps a plain single-stage CMD', () => {
    expect(detectStartupCommand({ Dockerfile: 'FROM node:20\nCOPY . .\nCMD ["node", "server.js"]\n' }).value).toEqual([
      'CMD: ["node", "server.js"]',
    ]);
  });
});

describe('production stage names', () => {
  const uptimeKuma = [
    'FROM node:20 AS release',
    'COPY . .',
    'CMD ["node", "server/server.js"]',
    'FROM release AS nightly',
    'RUN npm run mark-as-nightly',
    'FROM node:20 AS pr-test2',
    'COPY . .',
    'CMD ["npm", "run", "start-pr-test"]',
    'FROM node:20 AS upload-artifact',
    'RUN echo upload',
    '',
  ].join('\n');

  it('skips a numbered test stage and a nightly stage', () => {
    expect(detectDockerfileBuildTarget({ Dockerfile: uptimeKuma }).value).toBe('release');
  });

  it('keeps a runtime stage whose name only contains a digit', () => {
    const tree = { Dockerfile: 'FROM node:20 AS app2\nCOPY . .\nCMD ["node", "a.js"]\nFROM node:20 AS lint\nRUN true\n' };
    expect(detectDockerfileBuildTarget(tree).value).toBe('app2');
  });
});

describe('PHP backed-enum env reads (shlink)', () => {
  const envVars = [
    '<?php',
    'enum EnvVars: string',
    '{',
    "    case DB_DRIVER = 'DB_DRIVER';",
    "    case DEFAULT_DOMAIN = 'DEFAULT_DOMAIN';",
    '    public function loadFromEnv(): mixed',
    '    {',
    '        return env($this->value) ?? $this->defaultValue();',
    '    }',
    '    private function defaultValue(): string|null',
    '    {',
    '        return match ($this) {',
    "            self::DB_DRIVER => 'sqlite',",
    '            default => null,',
    '        };',
    '    }',
    '}',
  ].join('\n');
  const tree: FileTree = {
    Dockerfile: 'FROM php:8.5-alpine\nCOPY . .\nCMD ["php", "-S", "0.0.0.0:8080"]\n',
    'composer.json': JSON.stringify({ require: { 'doctrine/dbal': '^4' } }),
    // A Config directory matches the Laravel `config/*.php` rule too.
    'module/Core/src/Config/EnvVars.php': envVars,
  };

  it('lists every case as a read', () => {
    expect(envVar(tree, 'DEFAULT_DOMAIN')).toBeDefined();
  });

  it('makes an engine selector that defaults to SQLite required when PostgreSQL is provisioned', () => {
    const selector = detectEnvVarModel(tree, [], { database: 'postgres', storage: false }).find((variable) => variable.key === 'DB_DRIVER');
    expect(selector?.required).toBe(true);
    expect(selector?.source.join(' ')).toContain('default "sqlite"');
  });

  it('reads nothing from an enum that does not read the environment', () => {
    const plain = { ...tree, 'module/Core/src/Config/EnvVars.php': envVars.replace('env($this->value)', '$this->value') };
    expect(envVar(plain, 'DEFAULT_DOMAIN')).toBeUndefined();
  });
});

describe('next.config boot guards (cal.com)', () => {
  const nextConfig = [
    'if (!process.env.NEXTAUTH_SECRET) throw new Error("Please set NEXTAUTH_SECRET");',
    'if (!process.env.NEXTAUTH_URL) throw new Error("Please set NEXTAUTH_URL");',
    'module.exports = { reactStrictMode: true };',
  ].join('\n');
  const tree = (dockerfile: string): FileTree => ({
    Dockerfile: dockerfile,
    'package.json': JSON.stringify({ name: 'web', scripts: { start: 'next start' }, dependencies: { next: '^15.0.0' } }),
    'apps/web/next.config.ts': nextConfig,
  });

  it('are required when `next start` loads the config, and the app URL is derived', () => {
    const start = tree('FROM node:20\nWORKDIR /app\nCOPY . .\nRUN yarn build\nCMD ["yarn", "start"]\n');
    expect(envVar(start, 'NEXTAUTH_SECRET')?.required).toBe(true);
    expect(isDerivedUrlEnvVariable(envVar(start, 'NEXTAUTH_URL')!)).toBe(true);
  });

  it('are not required when a standalone server.js runs the built config', () => {
    const standalone = tree('FROM node:20\nWORKDIR /app\nCOPY .next/standalone ./\nCMD ["node", "server.js"]\n');
    expect(envVar(standalone, 'NEXTAUTH_SECRET')?.required ?? false).toBe(false);
  });
});

describe('Redis evidence of a sibling app that the image does not hold (cal.com)', () => {
  const tree = (copies: string): FileTree => ({
    Dockerfile: `FROM node:20 AS builder\nWORKDIR /calcom\n${copies}\nRUN yarn build\nFROM node:20 AS runner\nWORKDIR /calcom\nCOPY --from=builder /calcom/apps/web ./apps/web\nCMD ["yarn", "start"]\n`,
    'package.json': JSON.stringify({ name: 'monorepo', workspaces: ['apps/*'] }),
    'apps/web/package.json': JSON.stringify({ name: 'web', dependencies: { next: '^15.0.0' } }),
    'apps/api/v2/package.json': JSON.stringify({ name: 'api', dependencies: { bull: '^4.0.0', ioredis: '^5.0.0' } }),
    'apps/api/v2/.env.example': 'REDIS_URL=redis://localhost:6379\n',
  });

  it('does not provision Redis for the web image', () => {
    expect(assessRedis(tree('COPY apps/web ./apps/web\nCOPY apps/api/v2 ./apps/api/v2')).required).toBe(false);
  });

  it('still provisions Redis when the image takes the whole build context', () => {
    const whole = tree('COPY . .');
    whole.Dockerfile = 'FROM node:20\nWORKDIR /calcom\nCOPY . .\nRUN yarn build\nCMD ["yarn", "start"]\n';
    expect(assessRedis(whole).required).toBe(true);
  });
});

describe('a TLS Redis requirement (formbricks)', () => {
  const tree = (source: string): FileTree => ({
    Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "server.js"]\n',
    'package.json': JSON.stringify({ name: 'app', dependencies: { bullmq: '^5.0.0', ioredis: '^5.0.0' } }),
    '.env.example': 'REDIS_URL=redis://localhost:6379\n',
    'src/redis.ts': source,
  });

  it('is not read from a message that lists rediss:// as an allowed scheme', () => {
    const redis = assessRedis(tree('if (protocol !== "redis:" && protocol !== "rediss:") throw new Error("REDIS_URL must use redis:// or rediss://");\n'));
    expect(redis.required).toBe(true);
  });

  it('still makes a rediss:// connection URL unsupported', () => {
    const redis = assessRedis(tree('const url = process.env.REDIS_URL ?? "rediss://cache.example.com:6380";\n'));
    expect(redis.compatibility.supported).toBe(false);
  });
});

describe('a queue consumer that the start path runs (linkding)', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM python:3.13\nCOPY . .\nCMD ["./bootstrap.sh"]\n',
    'pyproject.toml': '[project]\nname = "linkding"\ndependencies = ["django", "huey"]\n',
    'bootstrap.sh': '#!/bin/sh\npython manage.py migrate\nsupervisord -c supervisord-tasks.conf\nexec uwsgi --http :9090 uwsgi.ini\n',
    'supervisord-tasks.conf': '[program:jobs]\ncommand=python manage.py run_huey -f\n',
  };

  it('is an in-process worker: no worker command question', () => {
    expect(normalizeDeploymentManifest(analyseRepo(tree), {}).worker.needsCommand).not.toBe(true);
  });

  it('still asks for the worker command when the start path does not run it', () => {
    const { 'supervisord-tasks.conf': _, ...withoutConsumer } = tree;
    withoutConsumer['bootstrap.sh'] = '#!/bin/sh\nexec uwsgi --http :9090 uwsgi.ini\n';
    expect(detectWorker(withoutConsumer).value).toEqual(['huey']);
    expect(normalizeDeploymentManifest(analyseRepo(withoutConsumer), {}).worker.needsCommand).toBe(true);
  });
});

describe('a root health check (cal.com)', () => {
  it('accepts a redirect when the image HEALTHCHECK probes `/`', () => {
    const tree = { Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD wget --spider http://localhost:3000 || exit 1\nCMD ["node", "server.js"]\n' };
    expect(normalizeDeploymentManifest(analyseRepo(tree), {}).health).toEqual({ path: '/', mode: 'root', redirectsAccepted: true });
  });

  it('keeps an explicit health route strict', () => {
    const tree = { Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nHEALTHCHECK CMD wget --spider http://localhost:3000/health || exit 1\nCMD ["node", "server.js"]\n' };
    expect(normalizeDeploymentManifest(analyseRepo(tree), {}).health).toEqual({ path: '/health', mode: 'explicit' });
  });
});

describe('a build argument that a RUN step requires (memos)', () => {
  const dockerfile = (arg: string) =>
    [
      'FROM golang:1.27-alpine AS backend',
      'COPY . .',
      `ARG TARGETOS TARGETARCH ${arg} COMMIT=unknown`,
      'RUN : "${VERSION:?Pass VERSION}" && go build -ldflags "-X main.Version=${VERSION}" -o memos ./cmd/memos',
      'FROM alpine:3.21 AS monolithic',
      'COPY --from=backend /go/memos /usr/local/memos/memos',
      'ENTRYPOINT ["/usr/local/memos/memos"]',
      '',
    ].join('\n');

  it('is a required build-stage variable', () => {
    const version = envVar({ 'scripts/Dockerfile': dockerfile('VERSION') }, 'VERSION');
    expect(version?.required).toBe(true);
    expect(version?.source.join(' ')).toContain(' build arg VERSION');
  });

  it('is not required when the ARG has a default', () => {
    expect(envVar({ 'scripts/Dockerfile': dockerfile('VERSION=dev') }, 'VERSION')?.required ?? false).toBe(false);
  });

  it('is not required in a stage the build never runs', () => {
    const tree = { Dockerfile: `FROM golang:1.27-alpine AS publish\nARG TAG\nRUN : "\${TAG:?}" && echo "\${TAG}"\n${dockerfile('VERSION=dev')}` };
    expect(envVar(tree, 'VERSION')?.required ?? false).toBe(false);
    expect(envVar(tree, 'TAG')?.required ?? false).toBe(false);
  });
});

describe('a multi-process check of the image the build produces (twenty)', () => {
  const tree = (lastStage: string): FileTree => ({
    'docker/Dockerfile': [
      'FROM node:24-alpine AS twenty',
      'COPY . /app',
      'CMD ["node", "dist/main"]',
      `FROM twenty AS ${lastStage}`,
      'ADD https://github.com/just-containers/s6-overlay/releases/download/v3/s6-overlay-noarch.tar.xz /tmp',
      'COPY docker/s6-rc.d /etc/s6-overlay/s6-rc.d',
      'ENTRYPOINT ["/init"]',
      '',
    ].join('\n'),
    'docker/s6-rc.d/postgres/run': '#!/bin/sh\nexec postgres\n',
    'docker/s6-rc.d/redis/run': '#!/bin/sh\nexec redis-server\n',
    'docker/s6-rc.d/server/run': '#!/bin/sh\nexec node dist/main\n',
  });
  const multiProcess = (files: FileTree) => analyseRepo(files).rejections.some((rejection) => rejection.dependency === 'multi-process-image' && rejection.detected);

  it('ignores a trailing dev all-in-one stage', () => {
    expect(multiProcess(tree('twenty-app-dev'))).toBe(false);
  });

  it('still rejects an s6 image that is the production stage', () => {
    expect(multiProcess(tree('all-in-one'))).toBe(true);
  });
});

describe('a database TLS mode that defaults to disable (vikunja)', () => {
  const tree = (sslDefault: string): FileTree => ({
    'pkg/config/config.go': [
      'package config',
      'const (',
      '\tDatabaseSslMode Key = `database.sslmode`',
      ')',
      'func InitDefaultConfig() {',
      `\tDatabaseSslMode.setDefault("${sslDefault}")`,
      '}',
      'func InitConfig() {',
      '\tviper.SetEnvPrefix("vikunja")',
      '\tviper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))',
      '\tviper.AutomaticEnv()',
      '}',
    ].join('\n'),
  });
  const sslMode = (files: FileTree, database: 'postgres' | null) =>
    detectEnvVarModel(files, [], { database, storage: false }).find((variable) => variable.key === 'VIKUNJA_DATABASE_SSLMODE');

  it('must be set when Deployz provisions PostgreSQL, which accepts only TLS', () => {
    const variable = sslMode(tree('disable'), 'postgres');
    expect(variable?.required).toBe(true);
    expect(variable?.source.join(' ')).toContain('set "require"');
  });

  it('is not asked for a read in a tool of another language than the image (geopulse)', () => {
    const tool: FileTree = {
      Dockerfile: 'FROM eclipse-temurin:21-jre\nCOPY target/app.jar /app.jar\nCMD ["java", "-jar", "/app.jar"]\n',
      'demo-integrations/store.go': 'package demo\nvar q = "sslmode=" + env("GEOPULSE_POSTGRES_SSLMODE", "disable")\n',
    };
    const variable = detectEnvVarModel(tool, [], { database: 'postgres', storage: false }).find((entry) => entry.key === 'GEOPULSE_POSTGRES_SSLMODE');
    expect(variable?.required ?? false).toBe(false);
  });

  it('is not asked when the default already uses TLS or no database is provisioned', () => {
    expect(sslMode(tree('require'), 'postgres')?.required ?? false).toBe(false);
    expect(sslMode(tree('disable'), null)?.required ?? false).toBe(false);
  });
});

describe('a viper key that a boot guard requires (vikunja)', () => {
  const config = (corsDefault: string) =>
    [
      'package config',
      'const (',
      '\tServicePublicURL Key = `service.publicurl`',
      '\tCorsEnable Key = `cors.enable`',
      ')',
      'func InitDefaultConfig() {',
      `\tCorsEnable.setDefault(${corsDefault})`,
      '}',
      'func InitConfig() {',
      '\tviper.SetEnvPrefix("vikunja")',
      '\tviper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))',
      '\tviper.AutomaticEnv()',
      '\tif CorsEnable.GetBool() && ServicePublicURL.GetString() == "" {',
      '\t\tlog.Fatalf("service.publicurl is required when cors.enable is true")',
      '\t}',
      '}',
    ].join('\n');
  const tree = (corsDefault: string): FileTree => ({
    Dockerfile: 'FROM golang:1.27 AS build\nCOPY . .\nRUN go build -o /vikunja\nFROM scratch\nCOPY --from=build /vikunja /vikunja\nENTRYPOINT ["/vikunja"]\n',
    'go.mod': 'module code.vikunja.io/api\n\ngo 1.27\n',
    'pkg/config/config.go': config(corsDefault),
  });

  it('is required, and Deployz supplies it as the app URL', () => {
    const url = envVar(tree('true'), 'VIKUNJA_SERVICE_PUBLICURL');
    expect(url?.required).toBe(true);
    expect(isDerivedUrlEnvVariable(url!)).toBe(true);
  });

  it('is not required when the other condition is off by default', () => {
    expect(envVar(tree('false'), 'VIKUNJA_SERVICE_PUBLICURL')?.required ?? false).toBe(false);
  });
});

// Round 2 (umami, directus, Ghost, n8n, uptime-kuma, changedetection.io, homepage, formbricks, plausible, outline).

describe('JS env reads that do not need a value', () => {
  const read = (source: string, key: string) =>
    detectEnvVarModel({ Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "server.js"]\n', 'src/server.js': source }).find((variable) => variable.key === key);

  it('a negation is a presence test (umami `return !process.env.CLOUD_MODE`)', () => {
    expect(read('export function enabled() {\n  return !process.env.CLOUD_MODE;\n}\n', 'CLOUD_MODE')?.required).toBe(false);
  });

  it('a membership test compares the value (plausible `.includes(process.env.MIX_ENV)`)', () => {
    expect(read("const ce = ['ce', 'ce_dev'].includes(process.env.MIX_ENV);\n", 'MIX_ENV')?.required).toBe(false);
  });

  it('one candidate of a fallback list (uptime-kuma port list)', () => {
    expect(read('const port = [args.port, process.env.UPTIME_KUMA_PORT, process.env.PORT, 3001].find((p) => p);\n', 'UPTIME_KUMA_PORT')?.required).toBe(false);
  });

  it('a secret whose local any condition tests, with no throw when absent (uptime-kuma initial admin)', () => {
    const source = [
      'const username = process.env.UK_INITIAL_ADMIN_USERNAME;',
      'const password = process.env.UK_INITIAL_ADMIN_PASSWORD;',
      'if (!username && !password) {',
      '  return false;',
      '}',
    ].join('\n');
    expect(read(source, 'UK_INITIAL_ADMIN_PASSWORD')?.required).toBe(false);
  });

  it('a secret that a getter only returns (homepage MCP token)', () => {
    expect(read('export function mcpToken() {\n  return process.env.HOMEPAGE_MCP_TOKEN;\n}\n', 'HOMEPAGE_MCP_TOKEN')?.required).toBe(false);
  });

  it('keeps a secret required when a throw guards it', () => {
    const source = 'export function key() {\n  return process.env.APP_SECRET_KEY;\n}\nif (!process.env.APP_SECRET_KEY) {\n  throw new Error("set it");\n}\n';
    expect(read(source, 'APP_SECRET_KEY')?.required).toBe(true);
  });

  it('keeps a value passed to an ordinary call required', () => {
    expect(read('const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\n', 'STRIPE_SECRET_KEY')?.required).toBe(true);
  });
});

describe('a JS server that checks the Host header (homepage)', () => {
  const tree = (source: string): FileTree => ({
    Dockerfile: 'FROM node:24\nCOPY . .\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
    'src/utils/auth.js': source,
  });

  it('lets the ALB health check pass the 400 it gets', () => {
    const health = normalizeDeploymentManifest(analyseRepo(tree('const allowed = (process.env.HOMEPAGE_ALLOWED_HOSTS ?? "").split(",");\n')), {}).health;
    expect(health.hostChecked).toBe(true);
  });

  it('does not for a server without a host list', () => {
    expect(normalizeDeploymentManifest(analyseRepo(tree('export const ok = true;\n')), {}).health).not.toHaveProperty('hostChecked');
  });
});

describe('a Redis queue that only an optional mode turns on (n8n)', () => {
  const tree = (mode: string): FileTree => ({
    Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "bin/n8n"]\n',
    'package.json': JSON.stringify({ name: 'n8n', scripts: { worker: './bin/n8n worker' }, dependencies: { bull: '^4.0.0', ioredis: '^5.0.0' } }),
    'src/configs/executions.config.ts': [
      "const executionModeSchema = z.enum(['regular', 'queue']);",
      'export class ExecutionsConfig {',
      "  @Env('EXECUTIONS_MODE', executionModeSchema)",
      `  mode: ExecutionMode = '${mode}';`,
      '}',
    ].join('\n'),
    'src/config/redis.config.ts': "export const host = process.env.QUEUE_BULL_REDIS_HOST ?? 'localhost';\n",
  });

  it('does not provision Redis when the default mode runs jobs in process', () => {
    expect(assessRedis(tree('regular')).required).toBe(false);
  });

  it('provisions Redis when the queue is the default mode', () => {
    expect(assessRedis(tree('queue')).required).toBe(true);
  });
});

describe('a production JSON config that names the database client (Ghost)', () => {
  const tree = (client: string): FileTree => ({
    Dockerfile: 'FROM node:22\nCOPY . .\nCMD ["node", "index.js"]\n',
    'package.json': JSON.stringify({ name: 'ghost', dependencies: { knex: '^3.0.0', mysql2: '^3.0.0', sqlite3: '^5.0.0' } }),
    'core/shared/config/env/config.production.json': JSON.stringify({ database: { client, connection: { host: '127.0.0.1' } } }),
  });

  it('is MySQL, whose connection the vendor confirms', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(tree('mysql')), {});
    expect(manifest.database.engine).toBe('mysql');
  });

  it('is not MySQL when it names another client', () => {
    expect(normalizeDeploymentManifest(analyseRepo(tree('sqlite3')), {}).database.engine).not.toBe('mysql');
  });
});

describe('a documentation site image beside the app image (authentik)', () => {
  const docs = (generator: string): string =>
    [
      'FROM node:24 AS docs-builder',
      `RUN pnpm install --filter "@goauthentik/${generator}-config"`,
      'COPY ./website /work/website/',
      'RUN pnpm run build',
      'FROM nginx:1.29',
      'COPY --from=docs-builder /work/website/docs/build /usr/share/nginx/html',
      '',
    ].join('\n');
  const tree = (generator: string): FileTree => ({
    'website/Dockerfile': docs(generator),
    'lifecycle/container/Dockerfile': 'FROM python:3.14-slim\nCOPY ./authentik /authentik\nCOPY ./manage.py /\nENTRYPOINT ["dumb-init", "--", "ak"]\n',
    'pyproject.toml': '[project]\nname = "authentik"\n',
  });

  it('builds the application image, not the shallower docs site', () => {
    expect(selectedDockerfile(tree('docusaurus'))?.path).toBe('lifecycle/container/Dockerfile');
  });

  it('keeps the shallower image when it is no docs site', () => {
    expect(selectedDockerfile(tree('eslint'))?.path).toBe('website/Dockerfile');
  });
});

describe('a database URL that only the image start script names (metabase)', () => {
  const tree = (script: string): FileTree => ({
    Dockerfile: 'FROM eclipse-temurin:25-jre\nCOPY bin/docker/run_metabase.sh /app/\nENTRYPOINT ["/app/run_metabase.sh"]\n',
    'bin/docker/run_metabase.sh': script,
  });

  it('lists the binding name the script forwards, not one in a comment', () => {
    const script = "#!/bin/bash\n# usage: file_env 'XYZ_DB_PASSWORD'\nfile_env() { :; }\nfile_env 'MB_DB_CONNECTION_URI'\nexec java -jar /app/metabase.jar\n";
    expect(envVar(tree(script), 'MB_DB_CONNECTION_URI')?.purpose).toBe('infrastructure_binding');
    expect(envVar(tree(script), 'XYZ_DB_PASSWORD')).toBeUndefined();
  });

  it('adds no name the script does not read', () => {
    expect(envVar(tree('#!/bin/bash\nexec java -jar /app/metabase.jar\n'), 'MB_DB_CONNECTION_URI')).toBeUndefined();
  });
});

describe('a health check script that builds its URL from variables (vaultwarden)', () => {
  const tree = (url: string): FileTree => ({
    Dockerfile: 'FROM debian:bookworm-slim\nCOPY docker/healthcheck.sh /healthcheck.sh\nEXPOSE 80\nHEALTHCHECK --interval=60s CMD ["/healthcheck.sh"]\nCMD ["/start.sh"]\n',
    'docker/healthcheck.sh': `#!/bin/sh\ncurl --insecure --fail --silent \\n     "${url}" || exit 1\n`,
  });

  it('reads the path after a scheme and a base path variable', () => {
    expect(normalizeDeploymentManifest(analyseRepo(tree('http${s}://${addr}:${ROCKET_PORT}${base_path}/alive')), {}).health).toEqual({ path: '/alive', mode: 'explicit' });
  });

  it('does not read a URL on another host', () => {
    expect(normalizeDeploymentManifest(analyseRepo(tree('https://example.com/alive')), {}).health.path).not.toBe('/alive');
  });
});

describe('a Dockerfile beside no project file that copies its whole context (miniflux)', () => {
  const tree = (extra: string[]): FileTree => {
    const files: FileTree = {
      'packaging/docker/alpine/Dockerfile': 'FROM golang:alpine AS build\nADD . /go/src/app\nWORKDIR /go/src/app\nRUN make miniflux\nFROM alpine\nCOPY --from=build /go/src/app/miniflux /usr/bin/miniflux\nCMD ["/usr/bin/miniflux"]\n',
      Makefile: 'miniflux:\n\tgo build -o miniflux main.go\n',
      'go.mod': 'module miniflux.app/v2\n',
    };
    return Object.defineProperty(files, TREE_PATHS, { value: [...Object.keys(files), ...extra], enumerable: false });
  };

  it('builds from the repository root', () => {
    expect(detectDockerfileBuildContext(tree([])).value).toBe('.');
  });

  it('keeps the Dockerfile directory when it holds the project', () => {
    expect(detectDockerfileBuildContext(tree(['packaging/docker/alpine/go.mod'])).detected).toBe(false);
  });
});

describe('a test that calls the health route (listmonk)', () => {
  const tree = (callerPath: string): FileTree => ({
    Dockerfile: 'FROM alpine:3.22\nCOPY listmonk .\nEXPOSE 9000\nCMD ["./listmonk"]\n',
    'go.mod': 'module github.com/knadh/listmonk\n',
    'cmd/handlers.go': 'func initHTTPHandlers(e *echo.Echo) {\n\tg := e.Group("")\n\tg.GET("/health", a.HealthCheck)\n}\n',
    'tests/package.json': '{"name": "listmonk-tests", "devDependencies": {"@playwright/test": "^1.50.0"}}',
    [callerPath]: "test('up', async ({ page }) => {\n  return (await page.request.get('/health')).ok();\n});\n",
  });

  it('reads the route the app registers, not the test call', () => {
    expect(detectHealthEndpoint(tree('tests/specs/subscribers.spec.js')).path).toBe('/health');
  });

  it('keeps the bare route when the same file also registers it under the API prefix', () => {
    const handlers = 'func initHTTPHandlers(e *echo.Echo) {\n\tg := e.Group("", a.auth.Middleware)\n\tg.GET("/api/health", a.HealthCheck)\n\tp := e.Group("")\n\tp.GET("/health", a.HealthCheck)\n}\n';
    expect(detectHealthEndpoint({ ...tree('tests/specs/subscribers.spec.js'), 'cmd/handlers.go': handlers }).path).toBe('/health');
  });

  it('still prefers the longer path from another file', () => {
    expect(
      detectHealthEndpoint({ 'package.json': '{"name": "app"}', 'src/app.js': "app.get('/health', ok);\n", 'src/api.js': "router.get('/api/health', ok);\n" }).path,
    ).toBe('/api/health');
  });

  it('still reads a route that app source registers', () => {
    expect(detectHealthEndpoint({ 'package.json': '{"name": "app"}', 'src/server.js': "app.get('/healthz', (req, res) => res.send('ok'));\n" }).path).toBe('/healthz');
  });
});

describe('a development image that runs a mounted checkout (actual)', () => {
  const tree = (dev: string): FileTree => ({
    Dockerfile: dev,
    'sync-server.Dockerfile':
      'FROM node:24 AS builder\nCOPY packages/ ./packages/\nRUN yarn build:server\nFROM node:24-slim\nCOPY --from=builder /app/build ./build\nEXPOSE 5006\nCMD ["node", "build/app.js"]\n',
    'package.json': '{"name": "actual"}',
  });

  it('builds the image that copies the app, not the image that copies nothing', () => {
    expect(selectedDockerfile(tree('FROM node:24-bookworm AS dev\nRUN apt-get update -y\nWORKDIR /app\nCMD ["sh", "./bin/docker-start"]\n'))?.path).toBe('sync-server.Dockerfile');
  });

  it('keeps the shallower image when it copies the app in', () => {
    expect(selectedDockerfile(tree('FROM node:24-bookworm\nWORKDIR /app\nCOPY . .\nCMD ["sh", "./bin/docker-start"]\n'))?.path).toBe('Dockerfile');
  });
});

describe('a build step that bind-mounts .git (gitea)', () => {
  const tree = (mount: string): FileTree => ({
    Dockerfile: [
      'FROM golang:1.25 AS build-env',
      'COPY . /go/src/code.gitea.io/gitea',
      'RUN --mount=type=cache,target="/root/.cache/go-build" \\',
      `    ${mount} \\`,
      '    make backend',
      'FROM alpine:3.22',
      'COPY --from=build-env /go/src/code.gitea.io/gitea/gitea /app/gitea/gitea',
      'CMD ["/usr/bin/s6-svscan", "/etc/s6"]',
      '',
    ].join('\n'),
  });

  it('needs the .git directory the source archive does not have', () => {
    expect(detectGitCopyInDockerfile(tree('--mount=type=bind,source=".git/",target=".git/"')).detected).toBe(true);
  });

  it('does not flag a bind mount of another path or of another stage', () => {
    expect(detectGitCopyInDockerfile(tree('--mount=type=bind,source=go.mod,target=go.mod')).detected).toBe(false);
    expect(detectGitCopyInDockerfile(tree('--mount=type=bind,from=src,source=.git,target=.git')).detected).toBe(false);
  });
});

describe('a configuration file that names the data location (meilisearch, qdrant)', () => {
  const tree = (path: string, config: string): FileTree => ({
    Dockerfile:
      'FROM rust:1.89 AS compiler\nCOPY . .\nRUN cargo build --release\nFROM alpine:3.22\nCOPY --from=compiler /target/release/app /bin/app\nEXPOSE 7700\nCMD ["/bin/app"]\n',
    'Cargo.toml': '[package]\nname = "app"\n',
    [path]: config,
  });

  it('is durable local state', () => {
    expect(checkExplicitPersistentDataDir(tree('config.toml', '# Where the database lives.\ndb_path = "./data.ms"\n')).detected).toBe(true);
    expect(checkExplicitPersistentDataDir(tree('config/config.yaml', 'storage:\n  # Where to store all the data\n  storage_path: ./storage\n')).detected).toBe(true);
  });

  it('is not a commented setting, a cache path or a setting in a test config', () => {
    expect(checkExplicitPersistentDataDir(tree('config.toml', '# db_path = "./data.ms"\n')).detected).toBe(false);
    expect(checkExplicitPersistentDataDir(tree('config/config.yaml', 'storage:\n  data_dir: /tmp/cache\n')).detected).toBe(false);
    expect(checkExplicitPersistentDataDir(tree('tests/config.yaml', 'storage_path: ./storage\n')).detected).toBe(false);
  });
});

describe('a Rust health route (qdrant)', () => {
  const tree = (source: string): FileTree => ({
    Dockerfile: 'FROM rust:1.89 AS builder\nCOPY . .\nRUN cargo build --release\nFROM debian:13-slim\nCOPY --from=builder /target/release/qdrant /qdrant/qdrant\nEXPOSE 6333\nCMD ["/qdrant/qdrant"]\n',
    'Cargo.toml': '[package]\nname = "qdrant"\n',
    'src/actix/api/service_api.rs': source,
  });

  it('reads an actix route attribute', () => {
    expect(detectHealthEndpoint(tree('#[get("/healthz")]\nasync fn healthz() -> impl Responder {\n    kubernetes_healthz()\n}\n')).path).toBe('/healthz');
  });

  it('reads no route from a Rust string that is no route', () => {
    expect(detectHealthEndpoint(tree('const NAME: &str = "healthz";\n')).detected).toBe(false);
  });
});

describe('an init process ENTRYPOINT with no CMD (mastodon)', () => {
  const tree = (cmd: string): FileTree => ({
    Dockerfile: `FROM ruby:3.4-slim\nCOPY . /opt/mastodon\nEXPOSE 3000 4000\nENTRYPOINT ["/usr/bin/tini", "--"]\n${cmd}`,
    Gemfile: "source 'https://rubygems.org'\ngem 'rails'\n",
  });

  it('has no start command', () => {
    expect(detectStartupCommand(tree('')).detected).toBe(false);
  });

  it('runs the CMD the init process is given', () => {
    expect(detectStartupCommand(tree('CMD ["bundle", "exec", "puma", "-C", "config/puma.rb"]\n')).detected).toBe(true);
  });
});

describe('a Redis queue that a mode equality test turns on, with no default (Flowise)', () => {
  const tree = (test: string): FileTree => ({
    Dockerfile: 'FROM node:20-alpine\nCOPY . .\nRUN pnpm install && pnpm build\nEXPOSE 3000\nCMD [ "pnpm", "start" ]\n',
    'package.json': JSON.stringify({ name: 'flowise', scripts: { start: 'node bin/run start', 'start-worker': 'node bin/run worker' }, dependencies: { bullmq: '^5.0.0', ioredis: '^5.0.0' } }),
    'src/CachePool.ts': `export class CachePool {\n    async init() {\n        if (${test}) {\n            this.redis = new Redis(process.env.REDIS_URL)\n        }\n    }\n}\n`,
    'src/Interface.ts': "export enum MODE {\n    QUEUE = 'queue',\n    MAIN = 'main'\n}\n",
  });

  it('does not provision Redis when the mode is unset by default', () => {
    expect(assessRedis(tree('process.env.MODE === MODE.QUEUE')).required).toBe(false);
  });

  it('provisions Redis when no test turns the queue mode on', () => {
    expect(assessRedis(tree('process.env.MODE !== MODE.MAIN')).required).toBe(true);
  });
});

describe('a development environment image beside the app images (penpot)', () => {
  const tree = (devDir: string): FileTree => ({
    [`docker/${devDir}/Dockerfile`]: 'FROM ubuntu:24.04\nRUN apt-get update && apt-get install -y openjdk-21-jdk nodejs\nCOPY files/init.sh /home/init.sh\nCMD ["/home/init.sh"]\n',
    'docker/images/Dockerfile.backend': 'FROM eclipse-temurin:21-jre\nCOPY bundle-backend/ /opt/penpot/backend/\nEXPOSE 6060\nCMD ["/bin/bash", "run.sh"]\n',
  });

  it('ranks the devenv image below the app image', () => {
    expect(selectedDockerfile(tree('devenv'))?.path).toBe('docker/images/Dockerfile.backend');
  });

  it('keeps a shallower image in an ordinary directory', () => {
    expect(selectedDockerfile(tree('runtime'))?.path).toBe('docker/runtime/Dockerfile');
  });
});

// Round 5
describe('round 5 corpus (langflow, litellm, activepieces, budibase, onyx, monica, snipe-it, invoiceninja, open-webui, kestra, temporal)', () => {
  const laravel = (files: FileTree): FileTree => ({
    Dockerfile: 'FROM php:8.3-apache\nRUN docker-php-ext-install pdo_mysql\nCOPY . /var/www/html\nEXPOSE 80\n',
    'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
    ...files,
  });

  it('reads the Laravel framework health route from bootstrap/app.php (monica)', () => {
    const app = "return Application::configure(basePath: dirname(__DIR__))\n    ->withRouting(\n        web: __DIR__.'/../routes/web.php',\n        health: '/up',\n    )\n    ->create();\n";
    expect(detectHealthEndpoint(laravel({ 'bootstrap/app.php': app })).path).toBe('/up');
    expect(detectHealthEndpoint(laravel({ 'bootstrap/app.php': app.replace("        health: '/up',\n", '') })).detected).toBe(false);
  });

  it('keeps a PHP route behind the image Apache server (snipe-it)', () => {
    const routes = "Route::withoutMiddleware(['web'])->get(\n    '/health',\n    [HealthController::class, 'get']\n);\n";
    const image = 'FROM ubuntu:24.04\nRUN apt-get install -y apache2 libapache2-mod-php8.3 php8.3-mysql\nRUN echo export APACHE_RUN_USER=docker >> /etc/apache2/envvars\nCOPY . /var/www/html\nCMD ["/startup.sh"]\nEXPOSE 80\n';
    expect(detectHealthEndpoint(laravel({ Dockerfile: image, 'routes/web.php': routes })).path).toBe('/health');
    expect(detectHealthEndpoint({ Dockerfile: image.replace('php8.3-mysql', 'nodejs'), 'server.js': "app.get('/health', (req, res) => res.send('ok'));\n" }).detected).toBe(false);
  });

  it('prefixes routes/api.php with the prefix that the RouteServiceProvider maps (invoiceninja)', () => {
    const routes = "Route::get('/health', function () { return ['ok' => true]; });\n";
    const provider = (prefix: string) => `Route::prefix('${prefix}')\n             ->middleware('api')\n             ->group(base_path('routes/api.php'));\n`;
    expect(detectHealthEndpoint(laravel({ 'routes/api.php': routes, 'app/Providers/RouteServiceProvider.php': provider('') })).path).toBe('/health');
    expect(detectHealthEndpoint(laravel({ 'routes/api.php': routes, 'app/Providers/RouteServiceProvider.php': provider('v1') })).path).toBe('/v1/health');
    expect(detectHealthEndpoint(laravel({ 'routes/api.php': routes })).path).toBe('/api/health');
  });

  it('provisions MySQL for a Laravel image that has only the MySQL PHP driver (snipe-it)', () => {
    const tree = (drivers: string): FileTree => ({
      Dockerfile: `FROM ubuntu:24.04\nRUN apt-get install -y \\\n  libapache2-mod-php8.3 \\\n  ${drivers} \\\n  php8.3-gd\nCOPY . /var/www/html\nCMD ["/startup.sh"]\n`,
      'composer.json': '{"require":{"laravel/framework":"^11.0"}}',
      'config/database.php': "'default' => env('DB_CONNECTION', 'mysql'),\n'mysql' => ['driver' => 'mysql'],\n'pgsql' => ['driver' => 'pgsql'],\n",
      '.env.example': 'DB_CONNECTION=mysql\nDB_HOST=127.0.0.1\n',
    });
    expect(normalizeDeploymentManifest(analyseRepo(tree('php8.3-mysql')), {}).database.engine).toBe('mysql');
    expect(normalizeDeploymentManifest(analyseRepo(tree('php8.3-mysql php8.3-pgsql')), {}).database.engine).not.toBe('mysql');
  });

  it('does not take a hosted-API client for a GPU requirement (langflow, litellm)', () => {
    const pyproject = (dep: string): FileTree => ({ 'pyproject.toml': `[project]\ndependencies = ["fastapi"]\n[project.optional-dependencies]\nextra = ["${dep}"]\n` });
    expect(checkGpu(pyproject('nvidia-riva-client>=2.15.0')).detected).toBe(false);
    expect(checkGpu(pyproject('langchain-nvidia-ai-endpoints~=1.0.0')).detected).toBe(false);
    expect(checkGpu(pyproject('nvidia-cudnn-cu12==9.1.0')).detected).toBe(true);
  });

  it('never builds a Dockerfile from a docker_example directory (langflow)', () => {
    const tree: FileTree = {
      'docker_example/Dockerfile': 'FROM langflowai/langflow:latest\nCMD ["python", "-m", "langflow", "run"]\n',
      'docker/build_and_push.Dockerfile': 'FROM python:3.12\nCOPY ./src /app/src\nCMD ["langflow", "run"]\n',
    };
    expect(selectedDockerfile(tree)?.path).toBe('docker/build_and_push.Dockerfile');
  });

  it('ranks a datastore support image below the application image (budibase)', () => {
    const tree: FileTree = {
      'hosting/couchdb/Dockerfile': 'FROM node:22-slim\nCOPY runner.sh ./\nEXPOSE 5984\nCMD ["./bbcouch-runner.sh"]\n',
      'hosting/single/Dockerfile': 'FROM node:22-slim\nCOPY . /app\nEXPOSE 80\nCMD ["./runner.sh"]\n',
    };
    expect(selectedDockerfile(tree)?.path).toBe('hosting/single/Dockerfile');
  });

  it('takes no port from a Cassandra service or a develop/ Compose file (temporal)', () => {
    const compose = 'services:\n  store:\n    image: cassandra:3.11\n    ports:\n      - "9042:9042"\n';
    expect(detectPort({ 'docker-compose.yml': compose }).value).not.toBe('9042');
    expect(detectPort({ 'develop/docker-compose/docker-compose.yml': compose.replace('cassandra:3.11', 'acme/app:1') }).value).not.toBe('9042');
    expect(detectPort({ 'docker-compose.yml': compose.replace('cassandra:3.11', 'acme/app:1') }).value).toBe('9042');
  });

  it('rejects a Python OpenSearch client only with a corroborating service (onyx)', () => {
    const tree = (compose: string): FileTree => ({
      'pyproject.toml': '[project]\ndependencies = [\n    "opensearch-py==3.2.0",\n]\n',
      'docker-compose.yml': compose,
    });
    expect(checkElasticsearch(tree('services:\n  api:\n    image: acme/api\n  index:\n    image: opensearchproject/opensearch:3\n')).detected).toBe(true);
    expect(checkElasticsearch(tree('services:\n  api:\n    image: acme/api\n')).detected).toBe(false);
  });

  it('rejects the CouchDB client nano when a Compose service is named after CouchDB (budibase)', () => {
    const tree = (name: string): FileTree => ({
      'package.json': '{"dependencies":{"@budibase/nano":"10.1.5"}}',
      'docker-compose.yml': `services:\n  app:\n    image: acme/app\n  ${name}:\n    image: acme/database:2.1.0\n`,
    });
    expect(checkOtherUnsupportedDatabases(tree('couchdb-service')).detected).toBe(true);
    expect(checkOtherUnsupportedDatabases(tree('files')).detected).toBe(false);
  });

  it('keeps Redis optional when the setting that selects it defaults to another backend (open-webui)', () => {
    const tree = (fallback: string): FileTree => ({
      'requirements.txt': 'redis==5.0.0\nfastapi\n',
      'backend/app/env.py': `REDIS_URL = os.getenv('REDIS_URL', '')\nWEBSOCKET_MANAGER = os.getenv('WEBSOCKET_MANAGER', '${fallback}')\n`,
      'backend/app/socket.py': "from app.env import WEBSOCKET_MANAGER, REDIS_URL\nif WEBSOCKET_MANAGER == 'redis':\n    mgr = AsyncRedisManager(REDIS_URL)\n",
    });
    expect(assessRedis(tree('')).required).toBe(false);
    expect(assessRedis(tree('redis')).required).toBe(true);
  });

  it('builds the application stage, not a trailing stage that runs a CI script (superset)', () => {
    const tree = (last: string): FileTree => ({
      Dockerfile: [
        'FROM python:3.11 AS lean',
        'ENV SUPERSET_HOME="/app/superset_home" \\',
        '    SUPERSET_PORT="8088"',
        'COPY superset /app/superset',
        'CMD ["/app/docker/entrypoints/run-server.sh"]',
        'EXPOSE ${SUPERSET_PORT}',
        'FROM lean AS superset',
        'RUN pip install psycopg2',
        'FROM lean AS showtime',
        `CMD ["/app/docker/entrypoints/${last}"]`,
        '',
      ].join('\n'),
    });
    expect(detectDockerfileBuildTarget(tree('docker-ci.sh')).value).toBe('superset');
    expect(detectStartupCommand(tree('docker-ci.sh')).value).toEqual(['CMD: ["/app/docker/entrypoints/run-server.sh"]']);
    expect(detectPort(tree('docker-ci.sh')).value).toBe('8088');
    expect(detectDockerfileBuildTarget(tree('run-showtime.sh')).detected).toBe(false);
  });

  it('reads the app service that waits on the database and the FastAPI router mount (khoj)', () => {
    const compose = [
      'services:',
      '  database:',
      '    image: pgvector/pgvector:pg15',
      '  sandbox:',
      '    image: ghcr.io/acme/terrarium:latest',
      '    healthcheck:',
      '      test: ["CMD-SHELL", "curl -f http://localhost:8080/health"]',
      '  computer:',
      '    image: ghcr.io/acme/computer:latest',
      '    ports:',
      '      - "5900:5900"',
      '  server:',
      '    depends_on:',
      '      database:',
      '        condition: service_healthy',
      '    image: ghcr.io/acme/app:latest',
      '    ports:',
      '      - "42110:42110"',
      '',
    ].join('\n');
    const router = (mount: string): FileTree => ({
      'src/app/routers/api.py': 'from fastapi import APIRouter\napi = APIRouter()\n\n@api.get("/health", response_class=Response)\ndef health():\n    return Response(status_code=200)\n',
      'src/app/configure.py': `def configure_routes(app):\n    app.include_router(api, prefix="${mount}")\n`,
    });
    expect(detectPort({ 'docker-compose.yml': compose, 'pyproject.toml': '[project]\nname = "app"\n' }).value).toBe('42110');
    expect(detectPort({ 'docker-compose.yml': compose.replace('    depends_on:\n      database:\n        condition: service_healthy\n', '') }).value).toBe('5900');
    expect(detectHealthEndpoint(router('/api')).path).toBe('/api/health');
    expect(detectHealthEndpoint({ ...router('/api'), 'src/app/other.py': 'app.include_router(api, prefix="/v2")\n' }).path).toBe('/health');
  });

  it('asks for the start command when the image CMD only prints the usage (kestra)', () => {
    const tree = (cmd: string): FileTree => ({ Dockerfile: `FROM eclipse-temurin:21-jre\nCOPY app /app/kestra\nENTRYPOINT ["docker-entrypoint.sh"]\nCMD ${cmd}\n` });
    expect(detectStartupCommand(tree('["--help"]')).detected).toBe(false);
    expect(detectStartupCommand(tree('["server", "standalone"]')).detected).toBe(true);
  });
});

describe('round 6 corpus (karakeep, beszel, pingvin-share)', () => {
  it('takes a dialect-neutral ORM next to a SQLite driver for SQLite, not PostgreSQL (karakeep)', () => {
    const tree = (deps: Record<string, string>): FileTree => ({ 'package.json': JSON.stringify({ dependencies: deps }) });
    expect(detectPostgresql(tree({ 'drizzle-orm': '0.44.0', 'better-sqlite3': '11.0.0' })).detected).toBe(false);
    expect(detectPostgresql(tree({ 'drizzle-orm': '0.44.0' })).detected).toBe(true);
    expect(detectPostgresql(tree({ 'drizzle-orm': '0.44.0', 'better-sqlite3': '11.0.0', pg: '8.0.0' })).value).toEqual(['pg']);
  });

  it('takes no MySQL engine from an indirect Go module (beszel on PocketBase)', () => {
    const goMod = (requires: string[]): FileTree => ({
      'go.mod': ['module example.com/app', '', 'go 1.24', '', 'require (', ...requires.map((line) => `\t${line}`), ')', ''].join('\n'),
      'main.go': 'package main\n',
    });
    expect(assessMysql(goMod(['github.com/pocketbase/pocketbase v0.40.5', 'github.com/go-sql-driver/mysql v1.9.1 // indirect'])).detected).toBe(false);
    expect(assessMysql(goMod(['github.com/go-sql-driver/mysql v1.9.1'])).detected).toBe(true);
    expect(assessMysql(goMod(['gorm.io/driver/mysql v1.5.7', 'github.com/go-sql-driver/mysql v1.9.1 // indirect'])).detected).toBe(true);
  });

  it('joins a sub-path to a root NestJS controller with one slash (pingvin-share)', () => {
    const tree: FileTree = {
      'backend/src/main.ts': 'app.setGlobalPrefix("api");\n',
      'backend/src/app.controller.ts': '@Controller("/")\nexport class AppController {\n  @Get("health")\n  async health() {}\n}\n',
    };
    expect(detectHealthEndpoint(tree).path).toBe('/api/health');
  });

  it('serves an unprivileged nginx image on 8080 with the nginx command, not a package script (CyberChef)', () => {
    const tree = (image: string): FileTree => ({
      Dockerfile: `FROM node:24-alpine AS builder\nCOPY . .\nRUN npm run build\nFROM ${image} AS cyberchef\nCOPY --from=builder /app/build/prod /usr/share/nginx/html/\n`,
      'package.json': JSON.stringify({ scripts: { start: 'npx grunt dev', build: 'npx grunt prod' } }),
    });
    expect(detectPort(tree('nginxinc/nginx-unprivileged:stable-alpine')).value).toBe('8080');
    expect(detectPort(tree('nginx:stable-alpine')).value).toBe('80');
    expect(detectStartupCommand(tree('nginxinc/nginx-unprivileged:stable-alpine')).value).toEqual(['CMD: ["nginx", "-g", "daemon off;"]']);
    expect(detectStartupCommand({ ...tree('node:24-alpine'), Dockerfile: 'FROM node:24-alpine\nCOPY . .\n' }).value).toEqual(['start: npx grunt dev']);
    // A third-party image with nginx in its name has its own init (InvoiceShelf on serversideup/php).
    expect(detectStartupCommand(tree('serversideup/php:8.5-fpm-nginx-alpine')).detected).toBe(false);
  });

  it('never selects a FROM scratch image that only exports files (focalboard Dockerfile.build)', () => {
    const tree: FileTree = {
      'Dockerfile.build': 'FROM golang:1.18 AS backend\nCOPY . .\nRUN make server-linux-package\nFROM scratch AS dist\nCOPY --from=backend /dist/focalboard-server-linux-amd64.tar.gz /\n',
      'docker/Dockerfile': 'FROM golang:1.18 AS gobuild\nCOPY . .\nRUN make server\nFROM debian:buster-slim\nCOPY --from=gobuild /go/bin/focalboard-server /opt/focalboard/bin/\nEXPOSE 8000/tcp\nCMD ["/opt/focalboard/bin/focalboard-server"]\n',
    };
    expect(selectedDockerfile(tree)?.path).toBe('docker/Dockerfile');
    expect(selectedDockerfile({ Dockerfile: 'FROM golang:1.22 AS build\nCOPY . .\nRUN go build -o /app\nFROM scratch\nCOPY --from=build /app /app\nENTRYPOINT ["/app"]\n' })?.path).toBe('Dockerfile');
  });

  it('rejects a PHP app that opens its own SQLite file (Wallos, grocy)', () => {
    expect(checkSqlite({ 'endpoints/db.php': "<?php\n$db = new SQLite3('../../db/wallos.db');\n" }).detected).toBe(true);
    expect(checkSqlite({ 'services/DatabaseService.php': "<?php\n$pdo = new \\PDO\\Sqlite('sqlite:' . $this->GetDbFilePath());\n" }).detected).toBe(true);
    expect(checkSqlite({ 'helpers/PrerequisiteChecker.php': "<?php\n$dbh = new \\PDO('sqlite::memory:');\n" }).detected).toBe(false);
    expect(checkSqlite({ 'composer.json': '{"require": {"ext-pdo_mysql": "*"}}', 'src/db.php': "<?php\n$db = new SQLite3($file);\n" }).detected).toBe(false);
    // A database client with drivers for several engines (Adminer).
    expect(
      checkSqlite({
        'adminer/drivers/sqlite.inc.php': "<?php\n$this->link = new SQLite3($filename);\n",
        'adminer/drivers/pgsql.inc.php': "<?php\n$this->link = @pg_connect($connection_string);\n",
      }).detected,
    ).toBe(false);
  });

  it('finds no app to build in a repository of only documents (readeck, glitchtip on GitHub)', () => {
    const tree = (paths: string[]): FileTree => Object.assign(Object.fromEntries(paths.map((path) => [path, 'text\n'])), { [TREE_PATHS]: paths });
    expect(checkNoBuildableDockerfile(tree(['README.md', 'LICENSE', '.github/FUNDING.yml'])).dependency).toBe('no-application-source');
    expect(checkNoBuildableDockerfile(tree(['README.md', 'requirements.txt', 'app.py'])).dependency).toBe('no-buildable-dockerfile');
    const analysis = analyseRepo(tree(['README.md']));
    expect(analysis.rejections.find((r) => r.detected)?.dependency).toBe('no-application-source');
  });

  it('takes drizzle-orm with a libSQL client for SQLite, not PostgreSQL (openstatus)', () => {
    expect(detectPostgresql({ 'package.json': JSON.stringify({ dependencies: { 'drizzle-orm': '0.44.0', '@libsql/client': '0.15.0' } }) }).detected).toBe(false);
  });

  it('reads no build-context file from a heredoc COPY (AutoGPT)', () => {
    const dockerfile = "FROM python:3.12\nCOPY <<'EOF' /etc/app.conf\nkey=value\nEOF\nCOPY app.py /app/\nCMD [\"python\", \"/app/app.py\"]\n";
    const tree = (paths: string[]): FileTree => Object.assign({ Dockerfile: dockerfile }, { [TREE_PATHS]: ['Dockerfile', ...paths] });
    expect(detectDockerfileMissingCopySources(tree(['app.py']))).toEqual([]);
    expect(detectDockerfileMissingCopySources(tree([]))).toEqual(['app.py']);
  });

  it('ranks a Dockerfile in a hidden tool directory below the app image (AutoGPT, erpnext .oss-scanner)', () => {
    const app = 'FROM python:3.12\nCOPY . .\nEXPOSE 8006\nCMD ["python", "-m", "backend.rest"]\n';
    expect(selectedDockerfile({ '.oss-scanner/Dockerfile': app, 'autogpt_platform/backend/Dockerfile': app })?.path).toBe('autogpt_platform/backend/Dockerfile');
  });

  it('takes a Helm chart in a prefixed charts directory for a self-hosting sample (sqlpad)', () => {
    const chart = 'apiVersion: v2\nname: sqlpad\n';
    expect(checkKubernetes({ 'sqlpad-charts/Chart.yaml': chart }).detected).toBe(false);
    expect(checkKubernetes({ 'Chart.yaml': chart }).detected).toBe(true);
  });
});
