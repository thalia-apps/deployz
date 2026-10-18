import { normalizeDeploymentManifest } from '@deployz/analysis';
import type { DeploymentManifest } from '@deployz/contracts';

import type { Recipe } from '../contract.js';
import type { ServiceSet } from '../ports.js';

export function fakeServices(id = 'repo-001'): ServiceSet {
  return {
    id,
    network: `net-${id}`,
    postgres: { host: `${id}-postgres`, port: 5432, user: 'deployz_app', password: 'pgPASSWORD0123', database: 'deployz' },
    mysql: { host: `${id}-mysql`, port: 3306, user: 'deployz_app', password: 'myPASSWORD0123', database: 'deployz' },
    valkey: { host: `${id}-valkey`, port: 6379 },
    minio: {
      host: `${id}-minio`,
      port: 9000,
      endpoint: `http://${id}-minio:9000`,
      accessKey: 'minioACCESS0123',
      secretKey: 'minioSECRET0123',
      bucket: 'test-bucket',
      region: 'us-east-1',
    },
    caVolume: `${id}-ca`,
    caDir: '/deployz/certs',
  };
}

export function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'repo-001',
    set: 'tuning',
    source: { kind: 'fixture', fixture: 'F1' },
    vendorInputs: [],
    notes: [],
    ...overrides,
  };
}

export interface ManifestOptions {
  database?: 'postgres' | 'mysql' | null;
  redis?: boolean;
  storage?: boolean;
  workerCommand?: string;
  migrationCommand?: string;
  /** Names bound to the managed database URL, for example `{ MEMOS_DSN: 'url' }`. */
  aliases?: Record<string, string>;
}

export function manifest(options: ManifestOptions = {}): DeploymentManifest {
  const database = options.database ?? null;
  const metadata = {
    hasDockerfile: true,
    dockerfilePath: 'Dockerfile',
    framework: 'express',
    port: '3000',
    startupCommands: ['node dist/index.js'],
    hasStartupCommand: true,
    postgres: { required: database === 'postgres', evidence: [] },
    mysql: { required: database === 'mysql', evidence: [] },
    redis: { required: options.redis === true, connectionEnvVars: [], compatibility: { supported: true } },
    usesS3: options.storage === true,
    usesLocalFilesystem: false,
    buildCommands: [],
    envVars: [],
    envVarModel: [],
    infrastructureBindings: [],
    databaseState: database ?? 'none',
  };
  const base = normalizeDeploymentManifest(
    { metadata },
    {
      healthPath: '/health',
      ...(options.migrationCommand !== undefined ? { migrationCommand: options.migrationCommand } : {}),
      ...(options.workerCommand !== undefined ? { workerCommand: options.workerCommand } : {}),
    },
  );
  if (options.aliases === undefined) return base;
  return {
    ...base,
    database: {
      ...base.database,
      envBindings: [
        ...(base.database.envBindings ?? []),
        ...Object.entries(options.aliases).map(([name, kind]) => ({ name, kind }) as never),
      ],
    },
  };
}
