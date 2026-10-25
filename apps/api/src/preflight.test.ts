import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

import { reconcileReadiness, type ReadinessReport } from '@deployz/analysis';
import type { DeploymentManifest } from '@deployz/contracts';

import type { EnvironmentSetting } from '@deployz/contracts';
import { applyMigrations, createDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { evaluatePreflight, requirePreflightReady, runDeploymentPreflight } from './preflight.js';

// AI MVP Phase 5 — the preflight gate: manifest gate + this customer's
// configuration + the readiness report's remaining findings, as one result
// with every check listed. Deterministic; no AI, no fetches.

function manifest(overrides: Partial<DeploymentManifest> = {}): DeploymentManifest {
  return {
    application: { root: '.', runtime: 'node', framework: 'express', dockerfilePath: 'Dockerfile' },
    build: { command: 'tsc', context: '.' },
    web: { command: 'node dist/index.js', port: 3000 },
    health: { path: '/health' },
    database: { postgres: true },
    redis: { required: false, envBindings: [] },
    storage: { required: false, envBindings: [] },
    migration: { command: 'npx drizzle-kit push' },
    worker: { command: null },
    environment: {
      variables: [
        { key: 'DATABASE_URL', required: true, secret: false, source: [], classification: 'deployz_managed' },
        { key: 'SESSION_SECRET', required: true, secret: true, source: [], classification: 'deployz_generated' },
        { key: 'STRIPE_SECRET_KEY', required: true, secret: true, source: [], classification: 'customer_required' },
        { key: 'LOG_LEVEL', required: false, secret: false, source: [], classification: 'optional' },
      ],
    },
    externalServices: ['stripe'],
    unsupported: [],
    ...overrides,
  };
}

function readiness(findings: ReadinessReport['findings'] = []): ReadinessReport {
  return {
    state: findings.length > 0 ? 'ALMOST_READY' : 'READY',
    requiredCount: findings.length,
    recommendedCount: 0,
    summary: '',
    findings,
    passed: [],
  };
}

const localhostFinding: ReadinessReport['findings'][number] = {
  id: 'localhost-binding',
  category: 'network',
  title: 'Your app only listens on localhost',
  severity: 'required',
  blocking: false,
  plainEnglishExplanation: 'This app accepts connections only from inside its own container, so Deployz cannot reach it.',
  whyItMatters: '',
  technicalEvidence: 'listen(3000, "127.0.0.1") (server.js)',
  suggestedOutcome: 'Bind the server to all network interfaces (0.0.0.0).',
  confidence: 'likely',
};

const healthFinding: ReadinessReport['findings'][number] = {
  ...localhostFinding,
  id: 'health-check',
  category: 'health',
  title: 'Give Deployz a way to check your app',
  plainEnglishExplanation: 'Deployz needs a reliable way to know when your app is running and ready.',
};

describe('evaluatePreflight', () => {
  it('is READY when every check passes, listing what Deployz configures and what the customer provided', () => {
    const result = evaluatePreflight({ manifest: manifest(), providedEnvKeys: ['STRIPE_SECRET_KEY'], readiness: readiness() });
    expect(result.state).toBe('READY');
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(result.checks.map((check) => check.id)).toEqual([
      'compatibility', 'container', 'start', 'port', 'database', 'redis', 'storage', 'managed-variables', 'customer-variables', 'health', 'migrations',
    ]);
    expect(result.checks.find((check) => check.id === 'managed-variables')?.detail).toBe('2 variables configured automatically');
    expect(result.checks.find((check) => check.id === 'customer-variables')?.detail).toBe('1 value provided');
    expect(result.checks.find((check) => check.id === 'health')?.detail).toBe('Health check at /health');
  });

  it('names the managed database engine — MySQL is never shown as PostgreSQL', () => {
    const database = (engine?: 'postgres' | 'mysql') =>
      evaluatePreflight({ manifest: manifest({ database: { postgres: true, ...(engine ? { engine } : {}) } }), providedEnvKeys: ['STRIPE_SECRET_KEY'], readiness: readiness() })
        .checks.find((check) => check.id === 'database')?.detail;
    expect(database('mysql')).toBe('MySQL — Deployz provides a managed database');
    expect(database('postgres')).toBe('PostgreSQL — Deployz provides a managed database');
    expect(database()).toBe('PostgreSQL — Deployz provides a managed database');
  });

  it('is ACTION_REQUIRED with the missing customer variable named, never a generated one', () => {
    const result = evaluatePreflight({ manifest: manifest(), providedEnvKeys: [], readiness: readiness() });
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.ready).toBe(false);
    expect(result.blockers.map((finding) => finding.id)).toEqual(['required-env-vars-missing']);
    expect(result.blockers[0]?.message).toContain('STRIPE_SECRET_KEY');
    expect(result.blockers[0]?.message).not.toContain('SESSION_SECRET');
    expect(result.checks.find((check) => check.id === 'customer-variables')).toMatchObject({
      status: 'blocked',
      detail: 'Missing: STRIPE_SECRET_KEY',
    });
  });

  it('is ACTION_REQUIRED for a missing port or start command, and UNSUPPORTED for an unsupported architecture', () => {
    const missing = evaluatePreflight({
      manifest: manifest({ web: { command: null, port: null } }),
      providedEnvKeys: ['STRIPE_SECRET_KEY'],
      readiness: readiness(),
    });
    expect(missing.state).toBe('ACTION_REQUIRED');
    expect(missing.checks.filter((check) => check.status === 'blocked').map((check) => check.id)).toEqual(['start', 'port']);

    const unsupported = evaluatePreflight({
      manifest: manifest({ unsupported: ['Unsupported database detected — Deployz hosts PostgreSQL only'] }),
      providedEnvKeys: ['STRIPE_SECRET_KEY'],
      readiness: readiness(),
    });
    expect(unsupported.state).toBe('UNSUPPORTED');
    expect(unsupported.ready).toBe(false);
    expect(unsupported.checks[0]).toMatchObject({ id: 'compatibility', status: 'blocked' });
  });

  it('is READY_WITH_WARNINGS for a missing health endpoint, a missing migration command, or a localhost binding — none block', () => {
    const result = evaluatePreflight({
      manifest: manifest({ migration: { command: null } }),
      providedEnvKeys: ['STRIPE_SECRET_KEY'],
      readiness: readiness([healthFinding, localhostFinding]),
    });
    expect(result.state).toBe('READY_WITH_WARNINGS');
    expect(result.ready).toBe(true);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((finding) => finding.id)).toEqual(['migration-command-missing', 'localhost-binding', 'health-check']);
    expect(result.checks.find((check) => check.id === 'health')).toMatchObject({
      status: 'warning',
      detail: 'No dedicated health endpoint detected — Deployz will probe /health',
    });
    expect(result.checks.find((check) => check.id === 'migrations')?.status).toBe('warning');
    expect(result.checks.find((check) => check.id === 'localhost-binding')).toMatchObject({
      status: 'warning',
      label: 'Your app only listens on localhost',
    });
  });

  it('names a readiness warning once: the title is the label and the explanation is the detail', () => {
    const result = evaluatePreflight({
      manifest: manifest({ migration: { command: null, mode: 'startup' } }),
      providedEnvKeys: ['STRIPE_SECRET_KEY'],
      readiness: readiness([localhostFinding]),
    });
    const row = result.checks.find((check) => check.id === 'localhost-binding')!;
    expect(row.detail).toBe(localhostFinding.plainEnglishExplanation);
    expect(result.checks.find((check) => check.id === 'migrations')).toMatchObject({
      status: 'passed',
      detail: 'The application runs its migrations when it starts',
    });
  });

  it('shows no health warning once the vendor has set the health path', () => {
    const run = (healthPathDecided: boolean) =>
      evaluatePreflight({
        manifest: manifest(),
        providedEnvKeys: ['STRIPE_SECRET_KEY'],
        readiness: reconcileReadiness(readiness([healthFinding]), { containerPort: 3000, startCommand: null, healthPathDecided }),
      });
    expect(run(true).warnings.map((finding) => finding.id)).not.toContain('health-check');
    expect(run(true).checks.find((check) => check.id === 'health')).toMatchObject({ status: 'passed', detail: 'Health check at /health' });
    expect(run(false).warnings.map((finding) => finding.id)).toContain('health-check');
  });

  it('treats a pre-classification manifest on the old rule: every required key is the customer\'s', () => {
    const legacy = manifest({
      environment: { variables: [{ key: 'SESSION_SECRET', required: true, secret: true, source: [] }] },
    });
    const result = evaluatePreflight({ manifest: legacy, providedEnvKeys: [], readiness: null });
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.checks.find((check) => check.id === 'customer-variables')?.detail).toBe('Missing: SESSION_SECRET');
    expect(result.checks.find((check) => check.id === 'managed-variables')?.detail).toBe('Set at installation');
  });

  it('is deterministic', () => {
    const input = { manifest: manifest(), providedEnvKeys: [], readiness: readiness([healthFinding]) };
    expect(evaluatePreflight(input)).toEqual(evaluatePreflight(input));
  });
});

describe('evaluatePreflight — env-var setup settings', () => {
  function setting(overrides: Partial<EnvironmentSetting>): EnvironmentSetting {
    return { key: 'STRIPE_SECRET_KEY', stage: 'runtime', required: true, secret: true, provider: 'customer', ...overrides };
  }

  it('a vendor-optional setting never blocks deployment even with no value', () => {
    const result = evaluatePreflight({
      manifest: manifest(),
      providedEnvKeys: [],
      readiness: readiness(),
      settings: [setting({ provider: 'none', required: false })],
    });
    expect(result.state).toBe('READY');
    expect(result.checks.find((check) => check.id === 'customer-variables')?.detail).toBe('Nothing for you to provide');
  });

  it('a customer-required runtime setting still blocks deployment without a value', () => {
    const result = evaluatePreflight({
      manifest: manifest(),
      providedEnvKeys: [],
      readiness: readiness(),
      settings: [setting({ provider: 'customer', required: true })],
    });
    expect(result.state).toBe('ACTION_REQUIRED');
    expect(result.blockers.map((finding) => finding.id)).toEqual(['required-env-vars-missing']);
    expect(result.checks.find((check) => check.id === 'customer-variables')).toMatchObject({
      status: 'blocked',
      detail: 'Missing: STRIPE_SECRET_KEY',
    });
  });

  it('a build-stage vendor setting is skipped by the runtime gate regardless of value', () => {
    const result = evaluatePreflight({
      manifest: manifest(),
      providedEnvKeys: [],
      readiness: readiness(),
      settings: [setting({ provider: 'vendor', stage: 'build', required: true, secret: false })],
    });
    expect(result.state).toBe('READY');
  });

  it('legacy behaviour (no settings) is unchanged: the old classification rule still applies', () => {
    const withSettings = evaluatePreflight({ manifest: manifest(), providedEnvKeys: [], readiness: readiness(), settings: null });
    const withoutSettings = evaluatePreflight({ manifest: manifest(), providedEnvKeys: [], readiness: readiness() });
    expect(withSettings).toEqual(withoutSettings);
    expect(withSettings.state).toBe('ACTION_REQUIRED');
  });
});

describe('requirePreflightReady', () => {
  it('passes a ready result through, warnings included', () => {
    const result = evaluatePreflight({
      manifest: manifest(),
      providedEnvKeys: ['STRIPE_SECRET_KEY'],
      readiness: readiness([healthFinding]),
    });
    expect(() => requirePreflightReady(result)).not.toThrow();
  });

  it('throws the codes every client already handles, with blockers first in the details', () => {
    const blocked = evaluatePreflight({ manifest: manifest(), providedEnvKeys: [], readiness: readiness([healthFinding]) });
    expect(() => requirePreflightReady(blocked)).toThrow(
      expect.objectContaining({
        statusCode: 422,
        code: 'MANIFEST_NEEDS_CONFIGURATION',
        details: expect.objectContaining({
          state: 'ACTION_REQUIRED',
          findings: [
            expect.objectContaining({ id: 'required-env-vars-missing', severity: 'error' }),
            expect.objectContaining({ id: 'health-check', severity: 'warning' }),
          ],
        }),
      }),
    );
    const unsupported = evaluatePreflight({ manifest: manifest({ unsupported: ['x'] }), providedEnvKeys: [], readiness: null });
    expect(() => requirePreflightReady(unsupported)).toThrow(expect.objectContaining({ code: 'MANIFEST_NOT_COMPATIBLE' }));
  });
});

describe('runDeploymentPreflight — the install gates', () => {
  it("applies the vendor's saved decisions when the caller passes no application (launch, retry, relay register)", async () => {
    const client = new PGlite();
    await applyMigrations(client);
    const db = createDb(client);
    try {
      await db.insert(schema.organization).values({ id: 'org-preflight-gates', name: 'Acme', slug: 'org-preflight-gates' });
      const internalToken = { key: 'INTERNAL_TOKEN', required: true, secret: true, source: [], purpose: 'internal_secret' as const, classification: 'customer_required' as const };
      const [application] = await db
        .insert(schema.applications)
        .values({
          organizationId: 'org-preflight-gates',
          name: 'openship',
          repoFullName: 'acme/openship',
          repoUrl: 'https://github.com/acme/openship',
          environmentSettings: [{ key: 'INTERNAL_TOKEN', stage: 'runtime', required: true, secret: true, provider: 'deployz' }],
        })
        .returning();
      const [customer] = await db
        .insert(schema.customers)
        .values({ organizationId: 'org-preflight-gates', name: 'Customer', email: 'c@example.com' })
        .returning();
      const desiredState = {
        manifest: manifest({ environment: { variables: [manifest().environment.variables[0]!, internalToken] } }),
      };

      const result = await runDeploymentPreflight(
        db,
        { applicationId: application!.id, customerId: customer!.id, desiredState },
        null,
      );
      expect(result.ready).toBe(true);
    } finally {
      await client.close();
    }
  }, 60_000);
});
