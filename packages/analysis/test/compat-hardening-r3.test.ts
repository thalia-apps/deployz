import { describe, expect, it } from 'vitest';

import type { FileTree } from '../src/analyser.js';
import { analyseRepo } from '../src/analyser.js';
import { deriveInfrastructureBindings } from '../src/bindings.js';
import { detectEnvVarModel, detectS3, type ProvisionedResources } from '../src/detectors.js';
import {
  checkExplicitPersistentDataDir,
  checkOtherUnsupportedDatabases,
  checkRabbitMq,
  checkRequiredConfigFileMount,
} from '../src/rejection.js';

// R3 — storage names and selectors read through config classes and helpers,
// and rejection signals for apps outside the one-image Fargate shape.

const STORAGE: ProvisionedResources = { database: 'postgres', storage: true };

const NODE_APP: FileTree = {
  Dockerfile: 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/main.js"]\n',
  'package.json': JSON.stringify({ name: 'app', dependencies: { '@aws-sdk/client-s3': '^3.0.0', pg: '^8.0.0' } }),
  'src/main.ts': 'new S3Client({});\napp.listen(3000);\n',
};

const CONFIG_CLASS = [
  "import { IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';",
  '',
  'export class ConfigVariables {',
  '  @IsOptional()',
  '  STORAGE_TYPE: StorageDriverType = StorageDriverType.LOCAL;',
  '',
  '  @ValidateIf((env) => env.STORAGE_TYPE === StorageDriverType.S_3)',
  '  STORAGE_S3_NAME: string;',
  '}',
  '',
].join('\n');

function s3Bindings(tree: FileTree): string[] {
  return deriveInfrastructureBindings(tree, analyseRepo(tree))
    .filter((binding) => binding.resource === 's3')
    .map((binding) => binding.applicationVariable);
}

describe('R3 — typed config class storage names and selectors', () => {
  it('reads a class-validator field as an env read and binds an `_S3_NAME` bucket', () => {
    const tree = { ...NODE_APP, 'src/config/config-variables.ts': CONFIG_CLASS };
    expect(s3Bindings(tree)).toContain('STORAGE_S3_NAME');
  });

  it('requires a storage selector whose enum default is a local value', () => {
    const tree = { ...NODE_APP, 'src/config/config-variables.ts': CONFIG_CLASS };
    const selector = detectEnvVarModel(tree, [], STORAGE).find((entry) => entry.key === 'STORAGE_TYPE');
    expect(selector?.required).toBe(true);
    expect(selector?.source.some((text) => text.startsWith('storage selector'))).toBe(true);
  });

  it('does not require a selector whose enum default is S3, or a class without class-validator', () => {
    const s3Default = CONFIG_CLASS.replace('StorageDriverType.LOCAL', 'StorageDriverType.S_3');
    const plainClass = CONFIG_CLASS.replace(/import .*\n/, '');
    for (const content of [s3Default, plainClass]) {
      const model = detectEnvVarModel({ ...NODE_APP, 'src/config/config-variables.ts': content }, [], STORAGE);
      expect(model.find((entry) => entry.key === 'STORAGE_TYPE')?.required ?? false).toBe(false);
    }
  });

  it('does not require a local-disk selector when no storage is provisioned', () => {
    const tree = { 'package.json': '{"name":"app"}', 'src/config/config-variables.ts': CONFIG_CLASS };
    const model = detectEnvVarModel(tree, [], { database: null, storage: false });
    expect(model.find((entry) => entry.key === 'STORAGE_TYPE')?.required ?? false).toBe(false);
  });
});

describe('R3 — ini-backed Python config with env override', () => {
  const CONFIG_PY = [
    'import configparser',
    'import os',
    '',
    'class EnvInterpolation(configparser.BasicInterpolation):',
    '    def before_get(self, parser, section, option, value, defaults):',
    '        value = super().before_get(parser, section, option, value, defaults)',
    '        envvar = os.getenv(option)',
    '        return envvar if value == "" and envvar else value',
    '',
    'config_ini = configparser.ConfigParser(interpolation=EnvInterpolation())',
    'class ServerConfig(object):',
    '    UPLOAD_PROVIDER: str = empty_str_cast(config_ini["uploads"]["UPLOAD_PROVIDER"]) \\',
    '        or "filesystem"',
    '',
  ].join('\n');
  const CTFD_LIKE: FileTree = {
    Dockerfile: 'FROM python:3.11\nEXPOSE 8000\nCMD ["gunicorn", "app:create_app()"]\n',
    'requirements.txt': 'boto3==1.35.27\nflask==3.0.0\n',
    'app/config.py': CONFIG_PY,
    'app/config.ini': '[uploads]\nUPLOAD_PROVIDER =\nAWS_S3_BUCKET =\n',
  };

  it('detects S3 from an ini key and requires the upload selector', () => {
    expect(detectS3(CTFD_LIKE).detected).toBe(true);
    const selector = detectEnvVarModel(CTFD_LIKE, [], STORAGE).find((entry) => entry.key === 'UPLOAD_PROVIDER');
    expect(selector?.required).toBe(true);
  });

  it('ignores a ConfigParser that does not let the environment override its keys', () => {
    const tree = { ...CTFD_LIKE, 'app/config.py': CONFIG_PY.replace('os.getenv(option)', 'None') };
    expect(detectEnvVarModel(tree, [], STORAGE).find((entry) => entry.key === 'UPLOAD_PROVIDER')).toBeUndefined();
  });

  it('keeps a selector that already defaults to s3 optional', () => {
    const tree = { ...CTFD_LIKE, 'app/config.py': CONFIG_PY.replace('"filesystem"', '"s3"') };
    expect(detectEnvVarModel(tree, [], STORAGE).find((entry) => entry.key === 'UPLOAD_PROVIDER')?.required ?? false).toBe(false);
  });
});

describe('R3 — rejection signals', () => {
  it('rejects an Ecto adapter for ClickHouse, but not a ClickHouse client of customer data', () => {
    expect(checkOtherUnsupportedDatabases({ 'mix.exs': '{:ecto_ch, "~> 0.8"}\n{:postgrex, ">= 0.0.0"}\n' })).toMatchObject({
      detected: true,
      dependency: 'clickhouse',
    });
    expect(
      checkOtherUnsupportedDatabases({ 'package.json': '{"dependencies":{"@clickhouse/client":"1.0.0"}}', 'src/a.ts': 'const x = 1;' }),
    ).toMatchObject({ detected: false });
  });

  it('rejects an image data home on /data without a VOLUME, and accepts one with a VOLUME or another home', () => {
    const dockerfile = (extra: string): FileTree => ({ Dockerfile: `FROM elixir:1.17\nENV LIVEBOOK_HOME=/data\n${extra}CMD ["/app/bin/server"]\n` });
    expect(checkExplicitPersistentDataDir(dockerfile(''))).toMatchObject({ detected: true, dependency: 'local-filesystem' });
    expect(checkExplicitPersistentDataDir(dockerfile('VOLUME /data\n'))).toMatchObject({ detected: false });
    expect(checkExplicitPersistentDataDir({ Dockerfile: 'FROM node:20\nENV APP_HOME=/app\nCMD ["node","x.js"]\n' })).toMatchObject({
      detected: false,
    });
  });

  it('does not read a data directory under a temporary or cache path as durable state, and still rejects a real one', () => {
    const read = (path: string): FileTree => ({
      Dockerfile: 'FROM node:20\nCOPY . .\nCMD ["node","api/server.js"]\n',
      'api/tech-stack.js': `const dir = process.env.CHROMIUM_DATA_DIR || '${path}';\n`,
    });
    expect(checkExplicitPersistentDataDir(read('/tmp/chromium-data'))).toMatchObject({ detected: false });
    expect(checkExplicitPersistentDataDir(read('/var/cache/chromium'))).toMatchObject({ detected: false });
    expect(checkExplicitPersistentDataDir({ Dockerfile: 'FROM node:20\nENV APP_DATA_DIR=/tmp/app\nCMD ["node","x.js"]\n' })).toMatchObject({ detected: false });
    expect(checkExplicitPersistentDataDir({ Dockerfile: 'FROM node:20\nCMD ["node","x.js"]\n', '.env': 'APP_DATA_DIR=/tmp/app\n' })).toMatchObject({ detected: false });
    expect(checkExplicitPersistentDataDir(read('/srv/chromium-data'))).toMatchObject({ detected: true, dependency: 'local-filesystem' });
    expect(checkExplicitPersistentDataDir({ Dockerfile: 'FROM node:20\nENV APP_DATA_DIR=/data\nCMD ["node","x.js"]\n' })).toMatchObject({ detected: true });
  });

  it('rejects an image ENV config file that no instruction creates', () => {
    const base = 'FROM alpine:3\nWORKDIR /app\nENV PATH=/app:$PATH \\\n  X_APP_CONFIG="/config/configuration.yml"\nCMD ["/app/server"]\n';
    expect(checkRequiredConfigFileMount({ Dockerfile: base })).toMatchObject({ detected: true, dependency: 'local-filesystem' });
    expect(checkRequiredConfigFileMount({ Dockerfile: base.replace('CMD', 'COPY config.yml /config/configuration.yml\nCMD') })).toMatchObject({
      detected: false,
    });
    expect(checkRequiredConfigFileMount({ Dockerfile: 'FROM alpine:3\nENV APP_PORT=80\nCMD ["/app/server"]\n' })).toMatchObject({
      detected: false,
    });
  });

  it('rejects a Python settings module that hard-codes a RabbitMQ host, but not one that reads it from the environment', () => {
    const files: FileTree = {
      'pyproject.toml': '[project]\ndependencies = [\n  "pika",\n]\n',
      'app/default_settings.py': 'RABBITMQ_HOST = "127.0.0.1"\n',
    };
    expect(checkRabbitMq(files)).toMatchObject({ detected: true, dependency: 'rabbitmq' });
    expect(checkRabbitMq({ ...files, 'app/default_settings.py': 'RABBITMQ_HOST = os.environ.get("RABBITMQ_HOST")\n' })).toMatchObject({
      detected: false,
    });
    expect(checkRabbitMq({ 'app/default_settings.py': 'RABBITMQ_HOST = "127.0.0.1"\n' })).toMatchObject({ detected: false });
  });
});
