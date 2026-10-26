import type { PGlite } from '@electric-sql/pglite';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from './test-utils.js';

// The drizzle journal is the Lambda migrator's ONLY source of truth (it
// applies an entry when its `when` stamp exceeds the single max created_at
// recorded in drizzle.__drizzle_migrations). A hand-edited journal that
// drops an entry, breaks idx/when ordering, or drifts from the .sql files
// silently skips migrations in production — the deploy gate cannot see it
// because /health/ready never touches the database. These invariants are
// therefore checked here, on every test run.
describe('drizzle journal invariants', () => {
  const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
  const journal = JSON.parse(
    readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: Array<{ idx: number; when: number; tag: string }> };
  const sqlFiles = readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  it('idx and when are strictly increasing — the migrator applies by when-order', () => {
    for (let i = 1; i < journal.entries.length; i += 1) {
      const prev = journal.entries[i - 1]!;
      const current = journal.entries[i]!;
      expect(current.idx, `idx must increase at entry ${current.tag}`).toBeGreaterThan(prev.idx);
      expect(current.when, `when must increase at entry ${current.tag}`).toBeGreaterThan(prev.when);
    }
  });

  it('every journal tag has a .sql file and vice versa', () => {
    const journalTags = journal.entries.map((entry) => `${entry.tag}.sql`);
    expect([...journalTags].sort()).toEqual(sqlFiles);
  });
});

// Smoke tests: the generated SQL migrations apply cleanly to a fresh
// ephemeral Postgres (PGlite) and produce the expected catalog shape.
describe('migrations', () => {
  let client: PGlite | undefined;

  beforeAll(async () => {
    ({ client } = await createTestDb());
  });

  afterAll(async () => {
    // Guarded: if beforeAll throws, client is undefined — don't mask the real
    // error behind "Cannot read properties of undefined (reading 'close')".
    await client?.close();
  });

  // 0046 was re-stamped after the 0044/0045 hotfix, so a database that already
  // applied it under its old stamp runs it again: it must be a no-op there.
  it('re-applies 0046_environment_setup without error', async () => {
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const sql = readFileSync(join(migrationsDir, '0046_environment_setup.sql'), 'utf8');
    await expect(client!.exec(sql.replaceAll('--> statement-breakpoint', ''))).resolves.toBeDefined();
  });

  it('creates the hot-path indexes, and 0054 re-applies without error', async () => {
    const { rows } = await client!.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN (
         'deployment_jobs_deployment_created_idx', 'deployment_jobs_active_state_idx',
         'deployment_stack_events_job_idx', 'event_logs_deployment_occurred_idx',
         'event_logs_organization_occurred_idx')`,
    );
    expect(rows).toHaveLength(5);
    const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'drizzle');
    const sql = readFileSync(join(migrationsDir, '0054_hot_path_indexes.sql'), 'utf8');
    await expect(client!.exec(sql.replaceAll('--> statement-breakpoint', ''))).resolves.toBeDefined();
  });

  it('creates all 30 core tables', async () => {
    const { rows } = await client!.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'account',
      'application_configs',
      'applications',
      'billing_checkout_intents',
      'billing_provider_events',
      'billing_reconciliation_events',
      'billing_subscriptions',
      'custom_domains',
      'customer_email_challenges',
      'customer_sessions',
      'customers',
      'deploy_links',
      'deployment_jobs',
      'deployment_owners',
      'deployment_resources',
      'deployment_stack_events',
      'deployments',
      'event_logs',
      'github_installations',
      'invitation',
      'jev_failure_classifications',
      'jev_shadow_verifications',
      'member',
      'organization',
      'pending_secrets',
      'public_install_links',
      'releases',
      'session',
      'user',
      'verification',
    ]);
  });

  it('creates the 28 enum types', async () => {
    const { rows } = await client!.query<{ typname: string }>(
      `SELECT typname FROM pg_type
       WHERE typtype = 'e' AND typnamespace = 'public'::regnamespace
       ORDER BY typname`,
    );
    expect(rows.map((r) => r.typname)).toEqual([
      'ai_explanation_state',
      'analysis_status',
      'billing_checkout_intent_status',
      'billing_event_processing_status',
      'billing_provider',
      'billing_reconciliation_status',
      'billing_subscription_status',
      'build_status',
      'cleanup_state',
      'compatibility_status',
      'custom_domain_status',
      'deployment_billing_state',
      'deployment_source',
      'deployment_state',
      'deployment_type',
      'failure_code',
      'health_status',
      'infrastructure_component_kind',
      'infrastructure_component_status',
      'infrastructure_lifecycle',
      'infrastructure_resource_role',
      'infrastructure_size_tier',
      'job_state',
      'job_type',
      'region',
      'region_selection',
      'relay_status',
      'release_status',
    ]);
  });

  it('starts event_logs empty', async () => {
    const { rows } = await client!.query<{ c: number }>(
      `SELECT count(*)::int AS c FROM event_logs`,
    );
    expect(rows[0]?.c).toBe(0);
  });

  // Redis MVP task 3: applications.redis_required mirrors database_required
  // exactly — same shape, same default, so existing apps (redisRequired
  // absent from analysis) stay false without a backfill.
  it('applications has redis_required: boolean, not null, default false', async () => {
    const { rows } = await client!.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'applications' AND column_name = 'redis_required'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe('boolean');
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toBe('false');
  });

  // Included production deployments: an additive column with a default, so
  // every existing organization keeps plain billing (allowance 0).
  it('organization has included_production_deployments: integer, not null, default 0', async () => {
    const { rows } = await client!.query<{
      data_type: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organization'
         AND column_name = 'included_production_deployments'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data_type).toBe('integer');
    expect(rows[0]?.is_nullable).toBe('NO');
    expect(rows[0]?.column_default).toBe('0');
  });

  // §61 taxonomy extension: two Redis failure codes must exist as real enum
  // labels in the migrated catalog, not just in the TypeScript source.
  it('failure_code enum includes the two Redis failure codes', async () => {
    const { rows } = await client!.query<{ enumlabel: string }>(
      `SELECT enumlabel FROM pg_enum
       JOIN pg_type ON pg_type.oid = pg_enum.enumtypid
       WHERE pg_type.typname = 'failure_code'
       ORDER BY enumsortorder`,
    );
    const labels = rows.map((r) => r.enumlabel);
    expect(labels).toContain('REDIS_PROVISIONING_FAILED');
    expect(labels).toContain('REDIS_CONNECTION_FAILED');
  });
});
