import { describe, expect, it } from 'vitest';

import type { Claim, ClaimType } from '../contract.js';
import { extractClaims, vendorRequiredVariables } from './extract.js';
import { makeAnalysis, makeManifest } from './test-support.js';

function variable(key: string, patch: Record<string, unknown> = {}) {
  return { key, required: true, secret: false, source: ['.env.example'], classification: 'customer_required', ...patch };
}

function claimsOf(patch: Record<string, unknown> = {}, state: 'READY' | 'NEEDS_CONFIGURATION' | 'NOT_COMPATIBLE' = 'READY'): Claim[] {
  return extractClaims(makeAnalysis(makeManifest(patch), { state, findings: [] }));
}

function claim(claims: Claim[], type: ClaimType, subject: string | null = null): Claim | undefined {
  return claims.find((candidate) => candidate.type === type && candidate.subject === subject);
}

describe('extractClaims', () => {
  it('gives no claim for a failed analysis', () => {
    const file = makeAnalysis(makeManifest(), { state: 'READY', findings: [] }, { status: 'failed', manifest: null, gate: null });
    expect(extractClaims(file)).toEqual([]);
  });

  it('gives one claim per type for a simple app', () => {
    const claims = claimsOf();
    expect(claims.map((entry) => entry.type)).toEqual([
      'readiness',
      'dockerfile',
      'web.port',
      'health.path',
      'database.engine',
      'redis.required',
      'storage.required',
      'storage.local',
      'migration.mode',
    ]);
  });

  it('reads the readiness state from the gate', () => {
    expect(claim(claimsOf({}, 'NEEDS_CONFIGURATION'), 'readiness')).toMatchObject({ value: 'NEEDS_CONFIGURATION', from: 'gate.state' });
  });

  it('reads the Dockerfile path and carries the build context in the subject', () => {
    const claims = claimsOf({
      application: { root: 'apps/web', runtime: 'node', framework: null, dockerfilePath: 'apps/web/Dockerfile' },
      build: { command: null, context: '.' },
    });
    expect(claim(claims, 'dockerfile', '.')).toMatchObject({ value: 'apps/web/Dockerfile', from: 'application.dockerfilePath' });
  });

  it('claims a missing Dockerfile as null', () => {
    const claims = claimsOf({ application: { root: '.', runtime: 'node', framework: null, dockerfilePath: null } });
    expect(claim(claims, 'dockerfile', '.')?.value).toBeNull();
  });

  it('reads the port and the health path', () => {
    const claims = claimsOf();
    expect(claim(claims, 'web.port')).toMatchObject({ value: 8080, from: 'web.port' });
    expect(claim(claims, 'health.path')).toMatchObject({ value: '/healthz', from: 'health.path' });
  });

  it('does not claim the placeholder of a vendor_required health path', () => {
    expect(claim(claimsOf({ health: { path: '/', mode: 'vendor_required' } }), 'health.path')?.value).toBeNull();
  });

  it('maps the database to postgres, mysql or none', () => {
    expect(claim(claimsOf(), 'database.engine')?.value).toBe('none');
    expect(claim(claimsOf({ database: { postgres: true } }), 'database.engine')?.value).toBe('postgres');
    expect(claim(claimsOf({ database: { postgres: true, engine: 'mysql' } }), 'database.engine')?.value).toBe('mysql');
  });

  it('reads the Redis and storage requirements', () => {
    const claims = claimsOf({ redis: { required: true, envBindings: [] }, storage: { required: true, envBindings: [] } });
    expect(claim(claims, 'redis.required')?.value).toBe(true);
    expect(claim(claims, 'storage.required')?.value).toBe(true);
  });

  it.each([
    'Persistent local filesystem storage is not supported',
    'Unsupported storage: the app declares durable local state (data/) with no VOLUME or Compose mount.',
    'Unsupported storage: docker-compose.yml declares named volumes.',
    'Unsupported infrastructure: a Kubernetes persistent volume claim is declared (k8s/pvc.yaml).',
  ])('claims local storage for the reason "%s"', (reason) => {
    const claims = claimsOf({ unsupported: [reason] }, 'NOT_COMPATIBLE');
    expect(claim(claims, 'storage.local')?.value).toBe(true);
  });

  it('does not claim local storage for another unsupported reason', () => {
    const claims = claimsOf({ unsupported: ['Unsupported database dependency: mongoose.'] }, 'NOT_COMPATIBLE');
    expect(claim(claims, 'storage.local')?.value).toBe(false);
  });

  it('reads the migration mode and command', () => {
    const claims = claimsOf({ migration: { command: 'npm run migrate', mode: 'pre_deploy' } });
    expect(claim(claims, 'migration.mode')?.value).toBe('pre_deploy');
    expect(claim(claims, 'migration.command')).toMatchObject({ value: 'npm run migrate', from: 'migration.command' });
  });

  it('gives no migration.command claim without a command, and a null mode when absent', () => {
    const claims = claimsOf();
    expect(claim(claims, 'migration.command')).toBeUndefined();
    expect(claim(claims, 'migration.mode')?.value).toBeNull();
  });

  it('gives one worker claim per declared worker', () => {
    const claims = claimsOf({
      worker: { command: 'node worker.js' },
      workers: [
        { id: 'worker', command: 'node worker.js', source: 'Procfile' },
        { id: 'mailer', command: 'node mailer.js', source: 'Procfile' },
      ],
    });
    const workers = claims.filter((entry) => entry.type === 'worker.command');
    expect(workers.map((entry) => [entry.subject, entry.value])).toEqual([
      ['worker', 'node worker.js'],
      ['mailer', 'node mailer.js'],
    ]);
  });

  it('uses the legacy worker command only when no worker is declared', () => {
    const claims = claimsOf({ worker: { command: 'node worker.js' } });
    expect(claims.filter((entry) => entry.type === 'worker.command')).toEqual([
      { type: 'worker.command', subject: 'worker', value: 'node worker.js', from: 'worker.command' },
    ]);
  });
});

describe('vendorRequiredVariables', () => {
  const manifest = (variables: unknown[], patch: Record<string, unknown> = {}) => makeManifest({ environment: { variables }, ...patch });

  it('keeps a required customer variable', () => {
    expect(vendorRequiredVariables(manifest([variable('STRIPE_KEY')]))).toEqual(['STRIPE_KEY']);
  });

  it('skips a variable that is not required', () => {
    expect(vendorRequiredVariables(manifest([variable('LOG_LEVEL', { required: false, classification: 'optional' })]))).toEqual([]);
  });

  it('skips a variable that Deployz manages or generates', () => {
    const variables = [
      variable('DATABASE_URL', { classification: 'deployz_managed' }),
      variable('SESSION_SECRET', { classification: 'deployz_generated', secret: true }),
    ];
    expect(vendorRequiredVariables(manifest(variables))).toEqual([]);
  });

  it('skips an internal secret that Deployz can mint', () => {
    const secret = variable('JWT_SECRET', { secret: true, purpose: 'internal_secret', classification: 'customer_required' });
    expect(vendorRequiredVariables(manifest([secret]))).toEqual([]);
  });

  it('skips a variable that a database binding covers', () => {
    const bound = manifest([variable('APP_DSN')], {
      database: { postgres: true, envBindings: [{ name: 'APP_DSN', kind: 'url' }] },
    });
    expect(vendorRequiredVariables(bound)).toEqual([]);
  });

  it('keeps a variable that a binding of a disabled resource names', () => {
    const unbound = manifest([variable('REDIS_URL')], { redis: { required: false, envBindings: [{ name: 'REDIS_URL', kind: 'url' }] } });
    expect(vendorRequiredVariables(unbound)).toEqual(['REDIS_URL']);
  });

  it('gives one env.required claim per vendor variable', () => {
    const claims = claimsOf({ environment: { variables: [variable('STRIPE_KEY'), variable('SMTP_HOST')] } });
    expect(claims.filter((entry) => entry.type === 'env.required')).toEqual([
      { type: 'env.required', subject: 'STRIPE_KEY', value: true, from: 'environment.variables.STRIPE_KEY' },
      { type: 'env.required', subject: 'SMTP_HOST', value: true, from: 'environment.variables.SMTP_HOST' },
    ]);
  });
});
