import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { detectEnvVarModel, detectLocalFilesystem, type ProvisionedResources } from '../src/detectors.js';
import { classifyEnvVariables } from '../src/env-classification.js';

const POSTGRES: ProvisionedResources = { database: 'postgres', storage: false };
const STORAGE: ProvisionedResources = { database: null, storage: true };
const BOTH: ProvisionedResources = { database: 'postgres', storage: true };

function variable(tree: FileTree, key: string, provisioned: ProvisionedResources) {
  return detectEnvVarModel(tree, [], provisioned).find((v) => v.key === key);
}

const GO_VIPER = [
  'package config',
  'func init() {',
  '  viper.SetEnvPrefix("app")',
  '  viper.AutomaticEnv()',
  '  viper.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))',
  '}',
].join('\n');

describe('files-type storage selector (vikunja)', () => {
  const goConfig = (line: string): FileTree => ({
    'pkg/config/config.go': `${GO_VIPER}\nconst (\n  FilesType Key = "files.type"\n)\nfunc defaults() {\n  ${line}\n}\n`,
  });

  it('requires APP_FILES_TYPE when the default is local and storage is provisioned', () => {
    const entry = variable(goConfig('FilesType.setDefault("local")'), 'APP_FILES_TYPE', STORAGE);
    expect(entry).toMatchObject({ required: true });
    expect(entry?.source).toContain(
      'storage selector: default "local" stores files on the container disk — set a value that stores files outside the container',
    );
  });

  it('does not require it for an S3 default, without provisioned storage, or for MIME-type names', () => {
    expect(variable(goConfig('FilesType.setDefault("s3")'), 'APP_FILES_TYPE', STORAGE)).toMatchObject({ required: false });
    expect(variable(goConfig('FilesType.setDefault("local")'), 'APP_FILES_TYPE', POSTGRES)).toMatchObject({ required: false });
    const mime = { 'src/upload.js': "const a = process.env.ALLOWED_FILE_TYPES || 'local';\nconst b = process.env.UPLOAD_FILE_TYPE || 'local';\n" };
    expect(variable(mime, 'ALLOWED_FILE_TYPES', STORAGE)).toMatchObject({ required: false });
    expect(variable(mime, 'UPLOAD_FILE_TYPE', STORAGE)).toMatchObject({ required: false });
  });
});

describe('storage selector set only in an env sample (teable)', () => {
  const sample = (line: string): FileTree => ({
    'apps/web/.env.example': `${line}\nBACKEND_STORAGE_PUBLIC_BUCKET=public-bucket\n`,
  });

  it('uses the sample value as the default when the fetched tree never reads the variable', () => {
    expect(variable(sample('BACKEND_STORAGE_PROVIDER=local'), 'BACKEND_STORAGE_PROVIDER', STORAGE)).toMatchObject({ required: true });
  });

  it('keeps an S3 sample, a docs sample, a missing S3 resource and a read with a hidden default not required', () => {
    expect(variable(sample('BACKEND_STORAGE_PROVIDER=s3'), 'BACKEND_STORAGE_PROVIDER', STORAGE)).toBeUndefined();
    const docsOnly = { 'docs/.env.example': 'BACKEND_STORAGE_PROVIDER=local\n' };
    expect(variable(docsOnly, 'BACKEND_STORAGE_PROVIDER', STORAGE)).toBeUndefined();
    expect(variable(sample('BACKEND_STORAGE_PROVIDER=local'), 'BACKEND_STORAGE_PROVIDER', POSTGRES)).toBeUndefined();
    // outline: the sample says local, but the test env file sets a real value and the code default is s3.
    const outline = { '.env.sample': 'FILE_STORAGE=local\n', '.env.test': 'FILE_STORAGE=local\n' };
    expect(variable(outline, 'FILE_STORAGE', STORAGE)).toMatchObject({ required: false });
  });
});

describe('selector the app reads through a config table or a Go constant, with no default found', () => {
  const zipline = (extra: FileTree = {}): FileTree => ({
    'src/lib/config/read/env.ts': "export const MAP = [\n  env('datasource.type', 'DATASOURCE_TYPE', 'string'),\n];\n",
    ...extra,
  });
  const gotify: FileTree = { 'config/keys.go': 'const (\n  EnvDatabaseDialect = "GOTIFY_DATABASE_DIALECT"\n  EnvDatabaseRegion = "GOTIFY_REGION_DB"\n)\n' };

  it('requires DATASOURCE_TYPE and says the default was not found', () => {
    const entry = variable(zipline(), 'DATASOURCE_TYPE', BOTH);
    expect(entry).toMatchObject({ required: true });
    expect(entry?.source[0]).toBe('storage selector: the default was not found — set a value that stores files outside the container');
  });

  it('does not require it with an S3 sample, a coded default, or no provisioned storage', () => {
    expect(variable(zipline({ '.env.example': 'DATASOURCE_TYPE=s3\n' }), 'DATASOURCE_TYPE', BOTH)).toMatchObject({ required: false });
    expect(variable(zipline({ 'src/x.ts': "const t = process.env.DATASOURCE_TYPE || 's3';\n" }), 'DATASOURCE_TYPE', BOTH)).toMatchObject({
      required: false,
    });
    expect(variable(zipline(), 'DATASOURCE_TYPE', POSTGRES)).toBeUndefined();
  });

  it('requires GOTIFY_DATABASE_DIALECT from a Go string literal and ignores other names', () => {
    expect(variable(gotify, 'GOTIFY_DATABASE_DIALECT', POSTGRES)).toMatchObject({ required: true });
    expect(variable(gotify, 'GOTIFY_REGION_DB', POSTGRES)).toBeUndefined();
  });

  it('does not require the Go selector when a default engine is coded or no database is provisioned', () => {
    const withDefault: FileTree = {
      ...gotify,
      'config/config.go': `${GO_VIPER.replace('"app"', '"gotify"')}\nfunc d() {\n  viper.SetDefault("database.dialect", "postgres")\n}\n`,
    };
    expect(variable(withDefault, 'GOTIFY_DATABASE_DIALECT', POSTGRES)?.required).toBe(false);
    expect(variable(gotify, 'GOTIFY_DATABASE_DIALECT', STORAGE)).toBeUndefined();
  });

  it('leaves a defaulted read that the scanners can see alone', () => {
    const tree = { 'config/app.php': "return ['t' => env('STORAGE_ATTACHMENT_TYPE', env('STORAGE_TYPE', 'local'))];\n" };
    expect(variable(tree, 'STORAGE_ATTACHMENT_TYPE', STORAGE)?.required ?? false).toBe(false);
  });
});

const S3_PRESENCE = 'S3 is used only when all of these are set; otherwise files go to the container disk';

describe('S3 enabled only when every variable of a chain is set (linkwarden)', () => {
  const s3Client = [
    'const s3Client =',
    '  process.env.SPACES_ENDPOINT &&',
    '  process.env.SPACES_REGION &&',
    '  process.env.SPACES_KEY &&',
    '  process.env.SPACES_SECRET',
    '    ? new S3({ endpoint: process.env.SPACES_ENDPOINT })',
    '    : undefined;',
    '',
  ].join('\n');

  it('requires each chain variable and never mints the secret', () => {
    const model = classifyEnvVariables(detectEnvVarModel({ 'lib/s3Client.ts': s3Client }, [], STORAGE), {
      postgresRequired: false,
      redisRequired: false,
      redisBindingNames: [],
      storageRequired: true,
      externalServices: [],
      queueBindingNames: [],
    });
    for (const key of ['SPACES_ENDPOINT', 'SPACES_REGION', 'SPACES_KEY', 'SPACES_SECRET']) {
      const entry = model.find((v) => v.key === key);
      expect(entry?.required, key).toBe(true);
      expect(entry?.classification, key).toBe('customer_required');
      expect(entry?.generatable, key).toBeUndefined();
      expect(entry?.source).toContain(S3_PRESENCE);
    }
  });

  it('ignores an S3 client without a presence chain, a chain that guards something else, and no storage', () => {
    const plain = { 'lib/s3.ts': 'const s3 = new S3({ region: process.env.AWS_REGION });\n' };
    expect(variable(plain, 'AWS_REGION', STORAGE)?.source).not.toContain(S3_PRESENCE);
    const other = { 'lib/x.ts': 'const c = process.env.CACHE_HOST && process.env.CACHE_PORT ? new Redis() : undefined;\n' };
    expect(variable(other, 'CACHE_HOST', STORAGE)?.source ?? []).not.toContain(S3_PRESENCE);
    expect(variable({ 'lib/s3Client.ts': s3Client }, 'SPACES_KEY', POSTGRES)?.source ?? []).not.toContain(S3_PRESENCE);
  });

  it('does not list a chain variable that Deployz binds', () => {
    const bound = {
      'lib/s3Client.ts': 'const c = process.env.S3_BUCKET_NAME && process.env.SPACES_KEY ? new S3Client({}) : undefined;\n',
    };
    expect(variable(bound, 'S3_BUCKET_NAME', STORAGE)?.source ?? []).not.toContain(S3_PRESENCE);
    expect(variable(bound, 'SPACES_KEY', STORAGE)).toMatchObject({ required: true });
  });
});

describe('selector hint when the non-local value is not S3 (postiz)', () => {
  it('keeps the S3 value in the hint when the code shows one', () => {
    const tree = { 'src/s.js': "const t = process.env.STORAGE_PROVIDER || 'local';\nif (t === 's3') use();\n" };
    expect(variable(tree, 'STORAGE_PROVIDER', STORAGE)?.source[0]).toContain('set "s3" to use the managed S3 bucket');
  });

  it('asks for a value that stores files outside the container when no S3 value appears', () => {
    const tree = { 'src/s.js': "const t = process.env.STORAGE_PROVIDER || 'local';\nif (t === 'cloudflare') use();\n" };
    const text = variable(tree, 'STORAGE_PROVIDER', STORAGE)?.source[0];
    expect(text).toContain('set a value that stores files outside the container');
    expect(text).not.toContain('an S3 value');
  });
});

describe('compose volume that the vendor calls optional in production (coder)', () => {
  const compose = (comment: string): FileTree => ({
    'compose.yaml': [
      'services:',
      '  app:',
      '    image: ghcr.io/acme/app:latest',
      '    volumes:',
      '      - /var/run/docker.sock:/var/run/docker.sock',
      ...(comment ? [`      # ${comment}`] : []),
      '      - app_home:/home/app',
      'volumes:',
      '  app_home:',
      '',
    ].join('\n'),
  });

  it('does not flag the volume when the comment above it says it is not required in production', () => {
    expect(detectLocalFilesystem(compose('This volume is not required in a production environment - you may safely remove it.')).detected).toBe(
      false,
    );
  });

  it('still flags it without a comment, or with a comment about another environment', () => {
    expect(detectLocalFilesystem(compose('')).detected).toBe(true);
    expect(detectLocalFilesystem(compose('This volume is not required in development.')).detected).toBe(true);
  });
});

describe('Dockerfile VOLUME that names an ENV path (searxng)', () => {
  const dockerfile = (lines: string[]): FileTree => ({ Dockerfile: ['FROM python:3.12-slim', ...lines, 'CMD ["run"]', ''].join('\n') });

  it('treats a config directory and a cache directory as non-state', () => {
    const tree = dockerfile([
      'ENV __CONFIG_PATH=/etc/searxng __DATA_PATH=/var/cache/searxng',
      'VOLUME $__CONFIG_PATH',
      'VOLUME ${__DATA_PATH}',
    ]);
    expect(detectLocalFilesystem(tree).detected).toBe(false);
  });

  it('still flags a variable that resolves to a data directory, and an unresolved variable', () => {
    const data = dockerfile(['ENV DATA_PATH=/data', 'VOLUME $DATA_PATH']);
    expect(detectLocalFilesystem(data)).toMatchObject({ detected: true, value: ['VOLUME /data (Dockerfile)'] });
    const unresolved = dockerfile(['VOLUME $DATA_PATH']);
    expect(detectLocalFilesystem(unresolved).detected).toBe(true);
  });

  it('still flags a literal volume next to a config volume', () => {
    expect(detectLocalFilesystem(dockerfile(['VOLUME /etc/app', 'VOLUME /srv/data'])).value).toEqual(['VOLUME /srv/data (Dockerfile)']);
  });
});

describe('Dockerfile VOLUME whose variable only the base image sets (COMP-052, searxng)', () => {
  const tree = (mounts: string[]): FileTree => ({
    Dockerfile: ['FROM docker.io/acme/base:app', 'VOLUME $__APP_CONFIG_PATH', 'VOLUME $__APP_DATA_PATH', 'EXPOSE 8080', 'CMD ["run"]', ''].join('\n'),
    'docker-compose.yml': ['services:', '  core:', '    image: docker.io/acme/app:latest', '    volumes:', ...mounts.map((m) => `      - ${m}`), ''].join('\n'),
  });

  it('is not durable state when the Compose service mounts only configuration and cache paths', () => {
    expect(detectLocalFilesystem(tree(['./core-config/:/etc/app/:Z', 'core-data:/var/cache/app/'])).detected).toBe(false);
  });

  it('stays durable state when a mount holds data, or the service mounts fewer paths than the image declares', () => {
    expect(detectLocalFilesystem(tree(['./core-config/:/etc/app/', 'core-data:/var/lib/app'])).detected).toBe(true);
    expect(detectLocalFilesystem(tree(['./core-config/:/etc/app/'])).detected).toBe(true);
    expect(detectLocalFilesystem(tree([])).detected).toBe(true);
  });

  it('finds the own service by the OCI title label when its image name is on the infrastructure list', () => {
    const searxng = (label: string): FileTree => ({
      'container/dist.dockerfile': [
        'FROM docker.io/searxng/base:searxng AS dist',
        label,
        'VOLUME $__SEARXNG_CONFIG_PATH',
        'VOLUME $__SEARXNG_DATA_PATH',
        'EXPOSE 8080',
        'ENTRYPOINT ["/usr/local/searxng/entrypoint.sh"]',
        '',
      ].join('\n'),
      'container/docker-compose.yml': [
        'services:',
        '  core:',
        '    image: docker.io/searxng/searxng:${SEARXNG_VERSION:-latest}',
        '    volumes:',
        '      - ./core-config/:/etc/searxng/:Z',
        '      - core-data:/var/cache/searxng/',
        '',
      ].join('\n'),
    });
    expect(detectLocalFilesystem(searxng('LABEL org.opencontainers.image.title="SearXNG"')).detected).toBe(false);
    expect(detectLocalFilesystem(searxng('LABEL org.opencontainers.image.title="Other"')).detected).toBe(true);
    expect(detectLocalFilesystem(searxng('')).detected).toBe(true);
  });
});

describe('debug tool storage selector (Laravel debugbar)', () => {
  it('does not require the storage driver of a debug tool', () => {
    const tree: FileTree = { 'config/debugbar.php': "<?php\nreturn ['storage' => ['driver' => env('DEBUGBAR_STORAGE_DRIVER', 'file')]];\n" };
    expect(variable(tree, 'DEBUGBAR_STORAGE_DRIVER', STORAGE)).toMatchObject({ required: false });
  });

  it('still requires the app storage driver with a local default', () => {
    const tree: FileTree = { 'config/app.php': "<?php\nreturn ['uploads' => env('UPLOADS_DRIVER', 'local')];\n" };
    expect(variable(tree, 'UPLOADS_DRIVER', STORAGE)).toMatchObject({ required: true });
  });
});
