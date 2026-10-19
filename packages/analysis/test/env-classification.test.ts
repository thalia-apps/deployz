/**
 * AI MVP Phase 4 — environment-variable classification. Deterministic rules
 * only: who supplies each value, decided from names, detected requirements
 * and the external-service catalog. No value is ever read.
 */

import { describe, expect, it } from 'vitest';

import type { ManifestEnvVariable } from '@deployz/contracts';

import { analyseRepo } from '../src/analyser.js';
import { derivedS3EnvValue } from '../src/bindings.js';
import { classifyEnvVariables, isGeneratableSecretName } from '../src/env-classification.js';
import type { FileTree } from '../src/detectors.js';
import { evaluateManifestReadiness, generatedEnvKeys, mintedEnvKeys, normalizeDeploymentManifest } from '../src/manifest.js';

const NO_REQUIREMENTS = {
  postgresRequired: false,
  redisRequired: false,
  redisBindingNames: [],
  storageRequired: false,
  externalServices: [],
  queueBindingNames: [],
};

function variable(key: string, overrides: Partial<ManifestEnvVariable> = {}): ManifestEnvVariable {
  return { key, required: true, secret: false, source: [`read in src/index.ts`], ...overrides };
}

describe('isGeneratableSecretName', () => {
  it('accepts application-internal secrets', () => {
    for (const key of [
      'SESSION_SECRET',
      'JWT_SECRET',
      'NEXTAUTH_SECRET',
      'AUTH_SECRET',
      'SECRET_KEY_BASE',
      'SECRET_KEY',
      'APP_KEY',
      'ENCRYPTION_KEY',
      'NEXT_PRIVATE_ENCRYPTION_KEY',
      'COOKIE_SECRET',
      'HASH_SALT',
    ]) {
      expect(isGeneratableSecretName(key), key).toBe(true);
    }
  });

  it('rejects third-party credentials, connection strings and API keys', () => {
    for (const key of [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'GITHUB_CLIENT_SECRET',
      'GOOGLE_CLIENT_SECRET',
      'SMTP_PASSWORD',
      'AWS_SECRET_ACCESS_KEY',
      'OPENAI_API_KEY',
      'DATABASE_URL',
      'REDIS_URL',
      'LICENSE_KEY',
      'SENTRY_DSN',
      'OAUTH_CLIENT_SECRET',
      'S3_SECRET_KEY',
      // Shared with another party — must match theirs, never minted.
      'WEBHOOK_SECRET',
      'HMAC_SECRET',
      'LICENSE_SECRET',
      'PARTNER_SIGNING_KEY',
      'SHARED_SECRET',
    ]) {
      expect(isGeneratableSecretName(key), key).toBe(false);
    }
  });
});

describe('classifyEnvVariables', () => {
  it('marks the names Deployz injects as managed — only for the requirements this app has', () => {
    const model = [variable('DATABASE_URL'), variable('REDIS_URL'), variable('AWS_S3_BUCKET'), variable('PORT', { required: false })];
    const none = classifyEnvVariables(model, NO_REQUIREMENTS);
    expect(none.map((v) => v.classification)).toEqual(['customer_required', 'customer_required', 'customer_required', 'deployz_managed']);

    const all = classifyEnvVariables(model, {
      postgresRequired: true,
      redisRequired: true,
      redisBindingNames: ['REDIS_URL'],
      storageRequired: true,
      externalServices: [],
      queueBindingNames: [],
    });
    expect(all.every((v) => v.classification === 'deployz_managed')).toBe(true);
  });

  it('never asks for static AWS SDK keys: the task role supplies the credentials', () => {
    const model = [
      variable('AWS_ACCESS_KEY_ID', { secret: true }),
      variable('AWS_SECRET_ACCESS_KEY', { secret: true }),
      variable('AWS_SESSION_TOKEN', { secret: true }),
      variable('STRIPE_SECRET_KEY', { secret: true }),
    ];
    const classified = classifyEnvVariables(model, { ...NO_REQUIREMENTS, storageRequired: true });
    expect(classified.map((v) => [v.required, v.classification])).toEqual([
      [false, 'optional'],
      [false, 'optional'],
      [false, 'optional'],
      [true, 'customer_required'],
    ]);
  });

  it('generates app-internal secrets, never a third-party or service credential', () => {
    const model = [
      variable('SESSION_SECRET', { secret: true }),
      variable('STRIPE_SECRET_KEY', { secret: true }),
      variable('GITHUB_CLIENT_SECRET', { secret: true }),
      variable('SMTP_PASS', { secret: true }),
    ];
    const classified = classifyEnvVariables(model, { ...NO_REQUIREMENTS, externalServices: ['stripe', 'smtp'] });
    expect(classified.map((v) => [v.key, v.classification])).toEqual([
      ['SESSION_SECRET', 'deployz_generated'],
      ['STRIPE_SECRET_KEY', 'customer_required'],
      ['GITHUB_CLIENT_SECRET', 'customer_required'],
      ['SMTP_PASS', 'customer_required'],
    ]);
  });

  it('never generates a value for a secret the app does not require, or a non-secret', () => {
    const classified = classifyEnvVariables(
      [variable('SESSION_SECRET', { secret: true, required: false }), variable('APP_SECRET', { secret: false })],
      NO_REQUIREMENTS,
    );
    expect(classified.map((v) => v.classification)).toEqual(['optional', 'customer_required']);
  });

  it('distinguishes optional reads from sample-only declarations', () => {
    const classified = classifyEnvVariables(
      [
        variable('LOG_LEVEL', { required: false, source: ['read in src/log.ts'] }),
        variable('FEATURE_X', { required: false, source: ['.env.example declares FEATURE_X'] }),
      ],
      NO_REQUIREMENTS,
    );
    expect(classified.map((v) => v.classification)).toEqual(['optional', 'unknown']);
  });

  it('is pure and preserves every other attribute', () => {
    const model = [variable('LICENSE_KEY', { secret: true })];
    const classified = classifyEnvVariables(model, NO_REQUIREMENTS);
    expect(model[0]).not.toHaveProperty('classification');
    expect(classified[0]).toEqual({ ...model[0], classification: 'customer_required' });
  });
});

describe('analyseRepo → manifest gate (Phase 4)', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "server.js"]\n',
    'package.json': JSON.stringify({ name: 'app', dependencies: { express: '^4', pg: '^8', stripe: '^12' } }),
    'server.js': [
      "const secret = process.env.SESSION_SECRET;",
      "const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);",
      "const license = process.env.LICENSE_KEY;",
      "const level = process.env.LOG_LEVEL || 'info';",
      "require('express')().get('/health', (_q, r) => r.send(secret && stripe && license && level)).listen(3000);",
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\nSESSION_SECRET=\nSTRIPE_SECRET_KEY=\nLICENSE_KEY=\nLOG_LEVEL=info\nUNUSED_FLAG=\n',
  };

  it('classifies the model in the analysis metadata', () => {
    const model = analyseRepo(tree).metadata['envVarModel'] as ManifestEnvVariable[];
    const byKey = Object.fromEntries(model.map((v) => [v.key, v.classification]));
    expect(byKey).toMatchObject({
      DATABASE_URL: 'deployz_managed',
      SESSION_SECRET: 'deployz_generated',
      STRIPE_SECRET_KEY: 'customer_required',
      LICENSE_KEY: 'customer_required',
      LOG_LEVEL: 'optional',
      UNUSED_FLAG: 'unknown',
    });
  });

  it('carries the classification into the manifest and never asks the vendor for a generated secret', () => {
    const manifest = normalizeDeploymentManifest(analyseRepo(tree), {});
    expect(generatedEnvKeys(manifest)).toEqual(['SESSION_SECRET']);

    const missing = evaluateManifestReadiness(manifest, { providedEnvKeys: [] });
    expect(missing.state).toBe('NEEDS_CONFIGURATION');
    const finding = missing.findings.find((f) => f.id === 'required-env-vars-missing');
    expect(finding?.message).toContain('STRIPE_SECRET_KEY');
    expect(finding?.message).toContain('LICENSE_KEY');
    expect(finding?.message).not.toContain('SESSION_SECRET');

    const provided = evaluateManifestReadiness(manifest, { providedEnvKeys: ['STRIPE_SECRET_KEY', 'LICENSE_KEY'] });
    expect(provided.state).toBe('READY');
  });

  it('keeps a pre-Phase-4 model (no classification) on the old rule: every required key is the vendor\'s', () => {
    const manifest = normalizeDeploymentManifest(
      { metadata: { hasDockerfile: true, dockerfilePath: 'Dockerfile', port: '3000', startupCommands: ['CMD: node x'], envVarModel: [variable('SESSION_SECRET', { secret: true })] } },
      {},
    );
    expect(generatedEnvKeys(manifest)).toEqual([]);
    expect(evaluateManifestReadiness(manifest, { providedEnvKeys: [] }).state).toBe('NEEDS_CONFIGURATION');
  });
});

describe('S3 region/endpoint derived from the deployment region', () => {
  const read = (key: string): ManifestEnvVariable => variable(key);

  it('derives the region and the regional endpoint for a name the app reads', () => {
    expect(derivedS3EnvValue(read('S3_REGION'), 'us-east-2')).toBe('us-east-2');
    expect(derivedS3EnvValue(read('S3_ENDPOINT'), 'us-east-2')).toBe('https://s3.us-east-2.amazonaws.com');
    expect(derivedS3EnvValue(read('AWS_S3_ENDPOINT'), 'eu-west-1')).toBe('https://s3.eu-west-1.amazonaws.com');
  });

  it('derives nothing for credentials, public URLs, AWS_REGION or a name the app never reads', () => {
    for (const key of ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_PUBLIC_BASE_URL', 'AWS_REGION']) {
      expect(derivedS3EnvValue(read(key), 'us-east-2'), key).toBeNull();
    }
    const sampleOnly = variable('S3_REGION', { source: ['.env.example declares S3_REGION'] });
    expect(derivedS3EnvValue(sampleOnly, 'us-east-2')).toBeNull();
  });

  it('classifies a derived name as managed only when storage is provisioned', () => {
    const model = [read('S3_REGION'), read('S3_ENDPOINT'), variable('S3_ACCESS_KEY_ID', { secret: true })];
    expect(classifyEnvVariables(model, { ...NO_REQUIREMENTS, storageRequired: true }).map((v) => v.classification)).toEqual([
      'deployz_managed',
      'deployz_managed',
      'customer_required',
    ]);
    expect(classifyEnvVariables(model, NO_REQUIREMENTS).map((v) => v.classification)).toEqual([
      'customer_required',
      'customer_required',
      'customer_required',
    ]);
  });

  it('classifies a Hovod-shaped repository: generated JWT secret, derived S3 location, vendor-supplied S3 keys', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:20-alpine\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
      'package.json': JSON.stringify({ name: 'app', dependencies: { zod: '^3', '@aws-sdk/client-s3': '^3' } }),
      'src/env.ts': [
        "import { z } from 'zod';",
        'const envSchema = z.object({',
        '  S3_ENDPOINT: z.string().min(1),',
        '  S3_REGION: z.string().min(1),',
        '  S3_BUCKET: z.string().min(1),',
        '  S3_ACCESS_KEY_ID: z.string().min(1),',
        '  S3_SECRET_ACCESS_KEY: z.string().min(1),',
        '  S3_PUBLIC_BASE_URL: z.string().url(),',
        "  JWT_SECRET: z.string().min(32, 'JWT_SECRET is required'),",
        '});',
        'export const env = envSchema.parse(process.env);',
        '',
      ].join('\n'),
      '.env.example': [
        'S3_ENDPOINT=http://minio:9000',
        'S3_REGION=us-east-1',
        'S3_BUCKET=hovod-vod',
        'S3_ACCESS_KEY_ID=minioadmin',
        'S3_SECRET_ACCESS_KEY=minioadmin',
        'S3_PUBLIC_BASE_URL=http://localhost:9000/hovod-vod',
        'JWT_SECRET=change-me-to-a-long-random-string-of-32-chars',
        '',
      ].join('\n'),
    };
    const model = analyseRepo(tree).metadata['envVarModel'] as ManifestEnvVariable[];
    const byKey = Object.fromEntries(model.map((v) => [v.key, v.classification]));
    expect(byKey).toMatchObject({
      JWT_SECRET: 'deployz_generated',
      S3_BUCKET: 'deployz_managed',
      S3_REGION: 'deployz_managed',
      S3_ENDPOINT: 'deployz_managed',
      S3_ACCESS_KEY_ID: 'customer_required',
      S3_SECRET_ACCESS_KEY: 'customer_required',
      S3_PUBLIC_BASE_URL: 'customer_required',
    });
  });
});

describe('minted secrets (OpenShip)', () => {
  const manifest = normalizeDeploymentManifest(
    {
      metadata: {
        hasDockerfile: true,
        dockerfilePath: 'Dockerfile',
        port: '3000',
        startupCommands: ['CMD: node x'],
        envVarModel: [
          // An optional internal secret with a development default: generated.
          variable('BETTER_AUTH_SECRET', { required: false, secret: true, purpose: 'internal_secret', classification: 'optional' }),
          // Optional internal secrets whose presence turns a feature on: never minted.
          variable('OPENSHIP_ACME_EAB_HMAC_KEY', { required: false, secret: true, purpose: 'internal_secret', classification: 'optional' }),
          variable('POSTHOG_PROJECT_KEY', { required: false, secret: true, purpose: 'internal_secret', classification: 'optional' }),
          variable('INTERNAL_TOKEN', { required: true, secret: true, purpose: 'internal_secret', classification: 'customer_required' }),
          variable('SESSION_SECRET', { secret: true, purpose: 'internal_secret', classification: 'deployz_generated' }),
        ],
      },
    },
    {},
  );
  const setting = (key: string, provider: 'deployz' | 'vendor' | 'customer' | 'none') => ({
    key,
    stage: 'runtime' as const,
    required: false,
    secret: true,
    provider,
  });

  it('mints only generated and generatable internal secrets when the vendor has not decided', () => {
    expect(mintedEnvKeys(manifest, null).sort()).toEqual(['BETTER_AUTH_SECRET', 'SESSION_SECRET']);
  });

  it('follows the saved decision: only "Managed by Deployz" is minted', () => {
    const minted = mintedEnvKeys(manifest, [
      setting('BETTER_AUTH_SECRET', 'none'),
      setting('INTERNAL_TOKEN', 'deployz'),
      setting('SESSION_SECRET', 'customer'),
      setting('OPENSHIP_ACME_EAB_HMAC_KEY', 'vendor'),
    ]);
    expect(minted).toEqual(['INTERNAL_TOKEN']);
  });

  it('classifies an optional generatable internal secret as deployz_generated', () => {
    const [classified] = classifyEnvVariables(
      [variable('BETTER_AUTH_SECRET', { required: false, secret: true, purpose: 'internal_secret' })],
      NO_REQUIREMENTS,
    );
    expect(classified!.classification).toBe('deployz_generated');
    const [hmac] = classifyEnvVariables(
      [variable('OPENSHIP_ACME_EAB_HMAC_KEY', { required: false, secret: true, purpose: 'internal_secret' })],
      NO_REQUIREMENTS,
    );
    expect(hmac!.classification).toBe('optional');
  });
});
