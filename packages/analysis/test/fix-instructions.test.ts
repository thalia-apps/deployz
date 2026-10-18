import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  SpendLimitExceededError,
  type AiGateway,
  type AiGatewayResponse,
  type AiGenerateOptions,
} from '../src/ai-gateway.js';
import {
  FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS,
  FIX_INSTRUCTIONS_GUARDRAIL,
  FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS,
  FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS,
  FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS,
  FIX_INSTRUCTIONS_TIMEOUT_MS,
  assembleFixInstructions,
  buildFixInstructionsAiPrompt,
  generateFixInstructions,
  guidanceVerdict,
  isSafeGuidance,
  planRemediation,
  summariseEnvRequirements,
  type DroppedGuidance,
  type FixInstructionsAiOutput,
  type FixInstructionsContext,
  type FixInstructionsFacts,
} from '../src/fix-instructions.js';
import type { ReadinessFinding } from '../src/readiness-report.js';

// ==========================================================================
// Fixtures
// ==========================================================================

const facts: FixInstructionsFacts = {
  runtime: 'node',
  framework: 'express',
  packageManager: 'pnpm',
  buildCommand: 'pnpm build',
  startCommand: 'node dist/index.js',
  port: '3000',
  dockerfilePath: 'Dockerfile',
  database: 'postgres',
  migrationCommand: null,
  suggestedMigrationCommand: null,
  healthPath: null,
  healthPathSetByVendor: false,
  redisRequired: false,
  workerCommands: [],
  workingDirectory: null,
  envRequirements: null,
};

function finding(id: string, overrides: Partial<ReadinessFinding> = {}): ReadinessFinding {
  return {
    id,
    category: 'test',
    title: `Title of ${id}`,
    severity: 'required',
    blocking: false,
    plainEnglishExplanation: `Explanation of ${id}.`,
    whyItMatters: 'It matters.',
    technicalEvidence: `Evidence for ${id}.`,
    suggestedOutcome: `Outcome for ${id}.`,
    confidence: 'confirmed',
    ...overrides,
  };
}

function context(findings: ReadinessFinding[], factOverrides: Partial<FixInstructionsFacts> = {}): FixInstructionsContext {
  return { repoFullName: 'acme/widget-api', commitSha: 'abc123def456', facts: { ...facts, ...factOverrides }, findings };
}

const NO_AI: FixInstructionsAiOutput = { items: [] };

function classOf(ctx: FixInstructionsContext, id: string): string | undefined {
  return planRemediation(ctx).find((item) => item.findingIds.includes(id))?.classification;
}

function fixtureGateway(response: AiGatewayResponse): AiGateway {
  return { async generate() { return response; } };
}

// ==========================================================================
// summariseEnvRequirements
// ==========================================================================

describe('summariseEnvRequirements', () => {
  it('returns null for a missing or non-array model', () => {
    expect(summariseEnvRequirements(undefined)).toBeNull();
    expect(summariseEnvRequirements(null)).toBeNull();
    expect(summariseEnvRequirements('nope')).toBeNull();
    expect(summariseEnvRequirements([])).toBeNull();
  });

  it('puts required vars read in code or required by a service at runtime', () => {
    const summary = summariseEnvRequirements([
      { key: 'STRIPE_SECRET_KEY', required: true, source: ['read in src/billing.ts'] },
      { key: 'SMTP_URL', required: true, source: ['smtp requires SMTP_URL'] },
    ]);
    expect(summary).toEqual({
      buildTime: [],
      runtime: ['SMTP_URL', 'STRIPE_SECRET_KEY'],
      platformInjected: [],
    });
  });

  it('puts required vars declared only in a build-context file at build time', () => {
    const summary = summariseEnvRequirements([
      { key: 'NPM_TOKEN', required: true, source: ['Dockerfile declares NPM_TOKEN'] },
    ]);
    expect(summary?.buildTime).toEqual(['NPM_TOKEN']);
    expect(summary?.runtime).toEqual([]);
  });

  it('keeps a Dockerfile-declared var at runtime when the code also reads it', () => {
    const summary = summariseEnvRequirements([
      {
        key: 'GA_ID',
        required: true,
        source: ['Dockerfile declares GA_ID', 'read in src/analytics.ts'],
      },
    ]);
    expect(summary?.runtime).toEqual(['GA_ID']);
    expect(summary?.buildTime).toEqual([]);
  });

  it('fails safe: a required var declared only outside build context lands at runtime', () => {
    const summary = summariseEnvRequirements([
      { key: 'FEATURE_TOKEN', required: true, source: ['.env declares FEATURE_TOKEN'] },
    ]);
    expect(summary?.runtime).toEqual(['FEATURE_TOKEN']);
  });

  it('routes platform-managed and platform-generated names to platformInjected', () => {
    const summary = summariseEnvRequirements([
      { key: 'DATABASE_URL', required: true, source: ['read in src/db.ts'], classification: 'deployz_managed' },
      { key: 'SESSION_SECRET', required: true, source: ['read in src/auth.ts'], classification: 'deployz_generated' },
      { key: 'STRIPE_KEY', required: true, source: ['read in src/billing.ts'] },
    ]);
    expect(summary).toEqual({
      buildTime: [],
      runtime: ['STRIPE_KEY'],
      platformInjected: ['DATABASE_URL', 'SESSION_SECRET'],
    });
  });
});

// ==========================================================================
// planRemediation — classification, merging, ordering
// ==========================================================================

describe('planRemediation — classification', () => {
  it.each([
    ['container-setup', 'CONFIGURATION_FIX'],
    ['unsupported-no-dockerfile', 'CONFIGURATION_FIX'],
    ['build-context-git-metadata', 'CONFIGURATION_FIX'],
    ['start-command-missing', 'CONFIGURATION_FIX'],
    ['port-unresolved', 'CONFIGURATION_FIX'],
    ['health-check', 'APPLICATION_FIX'],
    ['local-file-storage', 'APPLICATION_FIX'],
    ['unsupported-persistent-volume', 'APPLICATION_FIX'],
    ['database-migrations', 'CONFIGURATION_FIX'],
    ['migration-command-needs-input', 'NEEDS_INPUT'],
    ['worker-command', 'NEEDS_INPUT'],
    ['async-question-queue-orders', 'NEEDS_INPUT'],
    ['unsupported-database-mariadb', 'DEPLOYZ_LIMITATION'],
    ['unsupported-database-sqlite', 'DEPLOYZ_LIMITATION'],
    ['unsupported-database-mongo', 'DEPLOYZ_LIMITATION'],
    ['unsupported-database-elasticsearch', 'DEPLOYZ_LIMITATION'],
    ['unsupported-database-other', 'DEPLOYZ_LIMITATION'],
    ['unsupported-redis-setup', 'DEPLOYZ_LIMITATION'],
    ['unsupported-message-queue', 'DEPLOYZ_LIMITATION'],
    ['unsupported-gpu', 'DEPLOYZ_LIMITATION'],
    ['unsupported-architecture', 'UNSUPPORTED'],
    ['some-future-finding', 'NEEDS_INPUT'],
  ])('%s → %s', (id, expected) => {
    expect(classOf(context([finding(id)]), id)).toBe(expected);
  });

  it('a *_CONFIG_DIR in the persistent-volume evidence is CONFIGURATION_FIX with a COPY action', () => {
    const ctx = context([
      finding('unsupported-persistent-volume', { technicalEvidence: 'The app declares durable local state (HOMEPAGE_CONFIG_DIR (runtime source)).' }),
    ]);
    expect(classOf(ctx, 'unsupported-persistent-volume')).toBe('CONFIGURATION_FIX');
    const doc = assembleFixInstructions(ctx, NO_AI);
    expect(doc).toContain('COPY them into the image; do not move them to object storage');
  });

  it('other persistent-volume evidence stays APPLICATION_FIX without the COPY action', () => {
    const ctx = context([
      finding('unsupported-persistent-volume', { technicalEvidence: 'The app declares durable local state (APP_DATA_DIR (runtime source)).' }),
    ]);
    expect(classOf(ctx, 'unsupported-persistent-volume')).toBe('APPLICATION_FIX');
    expect(assembleFixInstructions(ctx, NO_AI)).not.toContain('COPY them into the image');
  });

  // Regression: informational findings ("No change needed — Deployz will
  // start the worker…") reached the prompt as blockers, because only the
  // "No action needed" wording was filtered.
  it.each([
    finding('worker-process', { severity: 'recommended', suggestedOutcome: 'No change needed — Deployz will start the worker process alongside your app.' }),
    finding('async-workloads', { severity: 'recommended', suggestedOutcome: 'No action needed — Deployz provisions the queues.' }),
    finding('database-migrations', { severity: 'recommended', suggestedOutcome: 'No action needed — migrations run on application startup.' }),
  ])('$id with a no-change outcome is ALREADY_SUPPORTED', (informational) => {
    expect(classOf(context([informational]), informational.id)).toBe('ALREADY_SUPPORTED');
  });

  it('splits a supervisor image (configuration) from independent compose services (limitation)', () => {
    const supervisor = finding('unsupported-multi-service', {
      technicalEvidence: 'Unsupported container setup: Dockerfile runs supervisord with 3 programs (supervisord.conf) in one container.',
    });
    const compose = finding('unsupported-multi-service', {
      technicalEvidence: 'Unsupported architecture: docker-compose.yml defines 2 application services (web, api).',
    });
    expect(classOf(context([supervisor]), 'unsupported-multi-service')).toBe('CONFIGURATION_FIX');
    expect(classOf(context([compose]), 'unsupported-multi-service')).toBe('DEPLOYZ_LIMITATION');
  });

  it('treats a bind address set in configuration as a configuration fix', () => {
    const configured = finding('localhost-binding', { technicalEvidence: 'Server binds only to a loopback address: Dockerfile CMD gunicorn --bind 127.0.0.1:8000' });
    const inCode = finding('localhost-binding', { technicalEvidence: "Server binds only to a loopback address: src/server.ts app.listen(3000, '127.0.0.1')" });
    expect(classOf(context([configured]), 'localhost-binding')).toBe('CONFIGURATION_FIX');
    expect(classOf(context([inCode]), 'localhost-binding')).toBe('APPLICATION_FIX');
  });

  it('treats a health path the vendor set as already supported, so no route is added', () => {
    const plan = planRemediation(context([finding('health-check', { confidence: 'likely' })], { healthPath: '/api/status', healthPathSetByVendor: true }));
    expect(plan[0]!.classification).toBe('ALREADY_SUPPORTED');
    expect(plan[0]!.evidence[0]).toContain('`/api/status`');
  });

  // Review: an earlier analysis's detected path stays in the column after the
  // route is removed; only a vendor-owned path means "set in Deployz".
  it('does not trust a detected health path that the finding contradicts', () => {
    const plan = planRemediation(context([finding('health-check', { confidence: 'likely' })], { healthPath: '/healthz' }));
    expect(plan[0]!.classification).toBe('APPLICATION_FIX');
  });

  // Holdout regression (CTFd): "server host set to a loopback address" in
  // Python source matched a case-insensitive HOST and read as configuration.
  it('reads HOST as a variable name only, never the word "host"', () => {
    const word = finding('localhost-binding', { technicalEvidence: 'Server binds only to a loopback address: server host set to a loopback address (serve.py)' });
    const variable = finding('localhost-binding', { technicalEvidence: 'Server binds only to a loopback address: APP_HOST defaults to 127.0.0.1 (src/config.ts)' });
    expect(classOf(context([word]), 'localhost-binding')).toBe('APPLICATION_FIX');
    expect(classOf(context([variable]), 'localhost-binding')).toBe('CONFIGURATION_FIX');
  });

  it('asks the vendor when the database itself is unconfirmed', () => {
    const unconfirmed = finding('database-migrations', { severity: 'recommended', confidence: 'needs_confirmation' });
    expect(classOf(context([unconfirmed]), 'database-migrations')).toBe('NEEDS_INPUT');
  });

  it('reads a compose "service" that is only a managed database as configuration', () => {
    const managed = finding('unsupported-multi-service', {
      technicalEvidence: 'Unsupported architecture: docker-compose.yml defines 2 application services (lobe, postgresql). Deployz runs ONE web process per deployment plus declared background workers.',
    });
    expect(classOf(context([managed]), 'unsupported-multi-service')).toBe('CONFIGURATION_FIX');
  });

  it('resolves a suggested migration command through the Deployz settings, not a new script', () => {
    const plan = planRemediation(
      context([finding('database-migrations', { severity: 'recommended' })], { suggestedMigrationCommand: 'python manage.py migrate --noinput' }),
    );
    expect(plan[0]!.classification).toBe('CONFIGURATION_FIX');
    expect(plan[0]!.settings.join(' ')).toContain('python manage.py migrate --noinput');
    expect(plan[0]!.actions.join(' ')).not.toMatch(/add a (?:package )?script/i);
  });

  it('maps finding confidence and never raises it above the finding', () => {
    const plan = planRemediation(context([
      finding('health-check', { confidence: 'likely' }),
      finding('worker-command', { confidence: 'needs_confirmation', severity: 'recommended' }),
      finding('port-unresolved', { confidence: 'confirmed' }),
    ]));
    const byId = new Map(plan.map((item) => [item.id, item.confidence]));
    expect(byId.get('health-check')).toBe('medium');
    expect(byId.get('worker-command')).toBe('low');
    expect(byId.get('port-unresolved')).toBe('high');
  });
});

describe('planRemediation — merging and ordering', () => {
  // Regression: "add a migration script" and "a migration script exists but
  // the image cannot run it" reached the agent as two contradicting blockers.
  it('merges the generic migration finding into the migration question', () => {
    const plan = planRemediation(context([
      finding('migration-command-needs-input', { confidence: 'needs_confirmation' }),
      finding('database-migrations', { severity: 'recommended', confidence: 'likely' }),
    ]));
    expect(plan).toHaveLength(1);
    expect(plan[0]!.findingIds).toEqual(['migration-command-needs-input', 'database-migrations']);
    expect(plan[0]!.classification).toBe('NEEDS_INPUT');
    expect(plan[0]!.evidence).toHaveLength(2);
  });

  // Review: a supervisor image and independent compose services share the
  // finding id but need different remediations.
  it('keeps a supervisor image and independent compose services as two items', () => {
    const plan = planRemediation(context([
      finding('unsupported-multi-service', { technicalEvidence: 'Unsupported architecture: docker-compose.yml defines 2 application services (web, api).' }),
      finding('unsupported-multi-service', { technicalEvidence: 'Unsupported container setup: Dockerfile runs supervisord with 2 programs (supervisord.conf) in one container.' }),
    ]));
    expect(plan.map((item) => item.classification).sort()).toEqual(['CONFIGURATION_FIX', 'DEPLOYZ_LIMITATION']);
  });

  it('drops an exact duplicate finding', () => {
    expect(planRemediation(context([finding('health-check'), finding('health-check')]))).toHaveLength(1);
  });

  it('orders by dependency: packaging, start, port, binding, health, storage, data, workers, limitations', () => {
    const ids = planRemediation(context([
      finding('unsupported-architecture'),
      finding('worker-command', { severity: 'recommended' }),
      finding('database-migrations', { severity: 'recommended' }),
      finding('health-check'),
      finding('local-file-storage'),
      finding('localhost-binding'),
      finding('port-unresolved'),
      finding('start-command-missing'),
    ])).map((item) => item.id);
    expect(ids).toEqual([
      'start-command-missing', 'port-unresolved', 'localhost-binding', 'health-check',
      'local-file-storage', 'database-migrations', 'worker-command', 'unsupported-architecture',
    ]);
  });

  it('lists the files named in the evidence', () => {
    const plan = planRemediation(context([
      finding('local-file-storage', { technicalEvidence: 'Persistent local filesystem operations detected: src/uploads/store.ts, config/storage.yml.' }),
    ]));
    expect(plan[0]!.files).toEqual(expect.arrayContaining(['src/uploads/store.ts', 'config/storage.yml']));
  });

  it('never lists a package name or a word pair as a file', () => {
    const plan = planRemediation(context([
      finding('unsupported-database-elasticsearch', { technicalEvidence: 'Unsupported search engine: @elastic/elasticsearch, and ELASTIC_URL is required. Deployz does not support Elasticsearch/OpenSearch.' }),
    ]));
    expect(plan[0]!.files).toEqual([]);
  });
});

// ==========================================================================
// Safety: the deterministic plan never prescribes an unsafe change
// ==========================================================================

const ALL_IDS = [
  'container-setup', 'unsupported-no-dockerfile', 'build-context-git-metadata', 'unsupported-multi-service',
  'start-command-missing', 'port-unresolved', 'localhost-binding', 'health-check', 'local-file-storage',
  'unsupported-persistent-volume', 'unsupported-database-sqlite', 'unsupported-database-mariadb',
  'unsupported-database-mongo', 'unsupported-database-elasticsearch', 'unsupported-database-other',
  'unsupported-redis-setup', 'migration-command-needs-input', 'database-migrations', 'worker-command',
  'unsupported-message-queue', 'async-question-x', 'unsupported-gpu', 'unsupported-architecture',
];

describe('planRemediation — safety', () => {
  const plan = planRemediation(context(ALL_IDS.map((id) => finding(id))));
  const actionText = plan.flatMap((item) => [...item.actions, ...item.settings]).join('\n');

  // Regressions from the previous generator's per-blocker steps.
  it.each([
    [/process background jobs inside the web process/i],
    [/move the worker processing into the web process/i],
    [/remove the job-runner code/i],
    [/replace the queue with (?:jobs|background jobs)/i],
    [/remove the self-managed infrastructure files/i],
    [/one container per deployment/i],
    [/hosts PostgreSQL only/i],
  ])('no action says %s', (pattern) => {
    expect(actionText).not.toMatch(pattern);
  });

  it('every non-supported item has at least one action, constraint-free items excepted, and a completion criterion', () => {
    for (const item of plan) {
      expect(item.actions.length, item.id).toBeGreaterThan(0);
      expect(item.doneWhen.length, item.id).toBeGreaterThan(0);
    }
  });

  it('decision items only verify and report: they never tell the agent to rewrite the data layer', () => {
    for (const item of plan.filter((entry) => ['DEPLOYZ_LIMITATION', 'UNSUPPORTED', 'NEEDS_INPUT'].includes(entry.classification))) {
      expect(item.actions.join(' '), item.id).not.toMatch(/\b(?:migrate the data layer|(?<!not )rewrite|replace \w+ with)\b/i);
      expect(item.actions.join(' ').toLowerCase(), item.id).toMatch(/report/);
    }
  });

  // Execution regressions (netbox, no Dockerfile): the agent defaulted the
  // allowed hosts to `*`, dropped the frozen lockfile install, and packaged a
  // Django app without the nginx that served its static files.
  it.each(['container-setup', 'unsupported-no-dockerfile'])('%s keeps security defaults closed and static files served', (id) => {
    const item = planRemediation(context([finding(id)]))[0]!;
    expect(item.constraints.join(' ')).toContain('no wildcard allowed hosts');
    expect(item.actions.join(' ')).toContain('serve them itself');
  });

  it.each(['container-setup', 'unsupported-no-dockerfile'])('%s installs from the lockfile in frozen mode', (id) => {
    expect(planRemediation(context([finding(id)]))[0]!.actions.join(' ')).toContain('do not drop the frozen flag');
  });

  it('protects separate workers wherever workers are involved', () => {
    const worker = plan.find((item) => item.id === 'worker-command')!;
    expect(worker.constraints.join(' ')).toContain('Do not move the worker into the web process');
    expect(worker.actions.join(' ')).toContain('Procfile');
  });
});

// ==========================================================================
// Safety: the rendered document never carries a critical unsafe instruction
// ==========================================================================

/**
 * Instructions that, executed as written, remove working architecture,
 * rewrite the data layer without the vendor's approval, bypass security,
 * invent secrets, or suppress errors. They are matched only against
 * instruction lines: the constraint and rule lines that forbid them are
 * excluded.
 */
const CRITICAL_UNSAFE: readonly { id: string; pattern: RegExp; example: string }[] = [
  {
    id: 'worker-into-web',
    pattern: /\b(?:process|run|move)\b[^.\n]{0,40}\b(?:background jobs|worker(?: processing)?)\b[^.\n]{0,30}\binside the web process|\bmove the worker processing into the web process/i,
    example: '   - Process background jobs inside the web process (an in-process scheduler or queue worker).',
  },
  {
    id: 'remove-worker-entrypoint',
    pattern: /\bremove the separate worker entrypoint\b/i,
    example: '   - Remove the separate worker entrypoint.',
  },
  {
    id: 'queue-into-web',
    pattern: /\breplace the queue with (?:background )?jobs (?:that )?run(?:ning)? inside the (?:web process|deployz container)/i,
    example: '   - Replace the queue with jobs that run inside the web process.',
  },
  {
    id: 'delete-infrastructure',
    pattern: /\bremove the (?:self-managed|third-party) infrastructure(?: files)?\b/i,
    example: '   - Remove the self-managed infrastructure files and dependencies.',
  },
  {
    id: 'unapproved-data-rewrite',
    pattern: /^(?:[-\d.\s]*)(?:inspect actual usage first\. )?move the data layer to postgres/im,
    example: '   - Inspect actual usage first. Move the data layer to PostgreSQL reusing the existing schema.',
  },
  {
    id: 'disable-security',
    pattern: /\b(?:disable|bypass|turn off)\b[^.\n]{0,30}\b(?:auth\w*|csrf|tls|ssl|security)\b/i,
    example: '   - Disable CSRF protection for the health route.',
  },
  {
    id: 'invent-secret',
    pattern: /\b(?:hard-?code|commit)\b[^.\n]{0,40}\b(?:secret|password|api[ _-]?key|token)\b/i,
    example: '   - Hardcode the API key in config.ts.',
  },
  {
    id: 'suppress-errors',
    pattern: /\b(?:swallow|suppress|ignore)\b[^.\n]{0,20}\b(?:all )?(?:errors|exceptions)\b/i,
    example: '   - Swallow all errors in the startup code.',
  },
];

/** The document's instruction lines: everything except constraint blocks and the general rules. */
function instructionLines(document: string): string[] {
  const lines: string[] = [];
  let inConstraints = false;
  let inRules = false;
  for (const line of document.split('\n')) {
    if (/^## /.test(line)) inRules = /^## Rules for every change/.test(line);
    if (/^- (?:Do not|Rules for every change):?$/.test(line) || /^Rules for every change:$/.test(line)) {
      inConstraints = true;
      if (/^Rules for every change:$/.test(line)) inRules = true;
      continue;
    }
    if (inConstraints && !/^ {2}- /.test(line)) inConstraints = false;
    if (inConstraints || inRules) continue;
    if (/^\s*-?\s*(?:Do not|Never)\b/i.test(line)) continue;
    lines.push(line);
  }
  return lines;
}

function unsafeInstructions(document: string): string[] {
  const text = instructionLines(document).join('\n');
  return CRITICAL_UNSAFE.filter((rule) => rule.pattern.test(text)).map((rule) => rule.id);
}

describe('assembleFixInstructions — critical unsafe instructions', () => {
  const allFindings = ALL_IDS.map((id) => finding(id));

  it.each([
    ['a Node app with a worker', {}],
    ['a MySQL app with Redis and two workers', { database: 'mysql', redisRequired: true, workerCommands: ['node worker.js', 'celery -A app worker'] }],
    ['an app with no database and no Dockerfile', { database: 'none', dockerfilePath: null }],
  ] as const)('the document for every finding of %s has none', (_name, factOverrides) => {
    const document = assembleFixInstructions(context(allFindings, { workerCommands: ['node worker.js'], ...factOverrides }), NO_AI);
    expect(document).toContain('## Fixes, in order');
    expect(unsafeInstructions(document)).toEqual([]);
  });

  it('the document for recommended findings has none', () => {
    const document = assembleFixInstructions(context(ALL_IDS.map((id) => finding(id, { severity: 'recommended' }))), NO_AI);
    expect(unsafeInstructions(document)).toEqual([]);
  });

  it.each(CRITICAL_UNSAFE.map((rule) => [rule.id, rule.example] as const))('the check flags %s', (id, example) => {
    expect(unsafeInstructions(`## Fixes\n${example}`)).toEqual([id]);
  });

  it('the check does not flag the constraints and rules that forbid those changes', () => {
    const document = [
      '### 1. Worker',
      '- Do not:',
      '  - Do not move the worker into the web process, and do not remove worker, queue, or scheduler code.',
      '- Done when:',
      '  - One command starts the worker.',
      '## Rules for every change',
      '- Never delete working code, disable security, skip tests, or suppress errors to pass a Deployz check.',
    ].join('\n');
    expect(unsafeInstructions(document)).toEqual([]);
    expect(instructionLines(document)).toContain('  - One command starts the worker.');
  });

  it.each(CRITICAL_UNSAFE.map((rule) => [rule.id, rule.example.replace(/^\s*-\s*/, '')] as const))('the guidance filter drops %s', (_id, guidance) => {
    expect(isSafeGuidance(guidance)).toBe(false);
  });

  it('drops model guidance that carries one of those instructions', () => {
    const items = CRITICAL_UNSAFE.map((rule, index) => ({ id: ALL_IDS[index]!, guidance: rule.example.replace(/^\s*-\s*/, '') }));
    const document = assembleFixInstructions(context(allFindings, { workerCommands: ['node worker.js'] }), { items });
    for (const item of items) expect(document).not.toContain(item.guidance);
    expect(unsafeInstructions(document)).toEqual([]);
  });
});

describe('guidanceVerdict', () => {
  it('names the rule of unsafe guidance and never carries the text', () => {
    expect(guidanceVerdict('Delete the worker entry point and run jobs in the web process.')).toEqual({
      ok: false,
      reason: 'unsafe',
      rule: 'remove-job-code',
      length: 'Delete the worker entry point and run jobs in the web process.'.length,
    });
  });

  it('reports empty and too_long without a rule', () => {
    expect(guidanceVerdict('  ')).toEqual({ ok: false, reason: 'empty', length: 0 });
    expect(guidanceVerdict('a'.repeat(FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS + 1))).toEqual({
      ok: false,
      reason: 'too_long',
      length: FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS + 1,
    });
  });

  it('accepts safe guidance', () => {
    expect(guidanceVerdict('For gunicorn, set --bind 0.0.0.0:$PORT in the Dockerfile CMD.')).toEqual({ ok: true });
  });
});

describe('isSafeGuidance', () => {
  it.each([
    'Delete the worker entry point and run jobs in the web process.',
    'Move the BullMQ worker into the web server process.',
    'Disable CSRF protection for the health route.',
    'Hardcode the API key in config.ts for now.',
    'Wrap the startup in try/catch and swallow all errors.',
    'Start the container with npm run dev.',
    'Skip tests to speed up the build.',
    'Use the key AKIAABCDEFGHIJKLMNOP for S3.',
    'Keep the API as is; move the worker into the web process.',
    'If the app does not use Redis, remove the queue code.',
  ])('rejects: %s', (guidance) => {
    expect(isSafeGuidance(guidance)).toBe(false);
  });

  it('rejects empty and overlong guidance', () => {
    expect(isSafeGuidance('   ')).toBe(false);
    expect(isSafeGuidance('a'.repeat(FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS + 1))).toBe(false);
  });

  it.each([
    'Express registers routes in order: add GET /health before the session middleware in src/app.ts if that file creates the app.',
    'If the app uses Knex, `npx knex migrate:latest` is the non-interactive migration command.',
    'For gunicorn, set --bind 0.0.0.0:$PORT in the Dockerfile CMD.',
    'Do not move the worker into the web process, and do not remove worker, queue, or scheduler code.',
    'Never delete working code, disable security, skip tests, or suppress errors to pass a Deployz check.',
    'Keep the worker as its own process; do not run jobs inside the web process.',
    'Run the worker as a separate process instead of inside the web server.',
    'Keep the self-managed infrastructure files and do not remove the infrastructure.',
  ])('accepts: %s', (guidance) => {
    expect(isSafeGuidance(guidance)).toBe(true);
  });
});

// ==========================================================================
// buildFixInstructionsAiPrompt
// ==========================================================================

describe('buildFixInstructionsAiPrompt', () => {
  const ctx = context([
    finding('health-check', { technicalEvidence: 'No health endpoint was found (no /health-style route).' }),
    finding('worker-process', { severity: 'recommended', suggestedOutcome: 'No change needed — Deployz will start the worker process alongside your app.' }),
  ]);
  const prompt = buildFixInstructionsAiPrompt(ctx);

  it('carries the facts, the plan item, its class and its evidence', () => {
    expect(prompt).toContain('- Framework: express');
    expect(prompt).toContain('- id: health-check');
    expect(prompt).toContain('class: APPLICATION_FIX');
    expect(prompt).toContain('No health endpoint was found');
  });

  it('never asks for guidance on already-supported items', () => {
    expect(prompt).not.toContain('- id: worker-process');
  });

  it('states the safety rules and the bounded output shape', () => {
    expect(prompt).toContain('Never suggest deleting working code, moving a worker into the web process');
    expect(prompt).toContain('{"items": [{"id": string, "guidance": string}]}');
    expect(prompt).toContain('70 words');
  });

  it('does not contain repository file contents', () => {
    expect(prompt).not.toMatch(/```/);
  });
});

// ==========================================================================
// assembleFixInstructions
// ==========================================================================

describe('assembleFixInstructions — onDropped', () => {
  const ctx = context([finding('health-check')]);
  const unsafe = 'Disable CSRF protection for the health route.';

  it('reports each dropped entry without any guidance text', () => {
    const dropped: DroppedGuidance[] = [];
    const ai: FixInstructionsAiOutput = {
      items: [
        { id: 'health-check', guidance: unsafe },
        { id: 'not-in-plan', guidance: 'Check the Express router file.' },
        { id: 'health-check', guidance: '   ' },
      ],
    };
    assembleFixInstructions(ctx, ai, undefined, { onDropped: (entry) => dropped.push(entry) });

    expect(dropped).toEqual([
      { itemId: 'health-check', reason: 'unsafe', rule: 'disable-security', length: unsafe.length },
      { itemId: 'not-in-plan', reason: 'unknown_item', length: 'Check the Express router file.'.length },
      { itemId: 'health-check', reason: 'empty', length: 0 },
    ]);
    const payload = JSON.stringify(dropped);
    for (const word of ['Disable', 'CSRF', 'protection', 'Express', 'router']) expect(payload).not.toContain(word);
  });

  it('does not call back for safe guidance and renders it', () => {
    const dropped: DroppedGuidance[] = [];
    const doc = assembleFixInstructions(
      ctx,
      { items: [{ id: 'health-check', guidance: 'Register GET /health in src/app.ts.' }] },
      undefined,
      { onDropped: (entry) => dropped.push(entry) },
    );
    expect(dropped).toEqual([]);
    expect(doc).toContain('Repository detail: Register GET /health in src/app.ts.');
  });

  it('renders the same document with and without the callback', () => {
    const ai: FixInstructionsAiOutput = {
      items: [
        { id: 'health-check', guidance: unsafe },
        { id: 'not-in-plan', guidance: 'Check the Express router file.' },
      ],
    };
    expect(assembleFixInstructions(ctx, ai, undefined, { onDropped: () => undefined })).toBe(assembleFixInstructions(ctx, ai));
  });

  it('generateFixInstructions passes onDropped through', async () => {
    const dropped: DroppedGuidance[] = [];
    await generateFixInstructions(
      ctx,
      fixtureGateway({ object: { items: [{ id: 'health-check', guidance: unsafe }] }, usage: { promptTokens: 10, completionTokens: 5 } }),
      { onDropped: (entry) => dropped.push(entry) },
    );
    expect(dropped.map((entry) => entry.rule)).toEqual(['disable-security']);
  });
});

describe('assembleFixInstructions', () => {
  const ctx = context([
    finding('unsupported-database-mongo', { blocking: true, technicalEvidence: 'Unsupported database dependency: mongoose, and MONGO_URL is required.' }),
    finding('health-check', { confidence: 'likely' }),
    finding('worker-process', { severity: 'recommended', technicalEvidence: 'Procfile declares worker.', suggestedOutcome: 'No change needed — Deployz will start the worker process alongside your app.' }),
  ], { workerCommands: ['node worker.js'] });

  it('contains the guardrail and the sections in order', () => {
    const doc = assembleFixInstructions(ctx, NO_AI);
    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
    const order = ['## Context', '## Fixes, in order', '## Vendor decisions', '## Already supported — keep as is', '## Rules for every change', '## Validation', '## Completion report']
      .map((heading) => doc.indexOf(heading));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('renders class, confidence, evidence, actions, constraints and completion criteria per item', () => {
    const doc = assembleFixInstructions(ctx, NO_AI);
    expect(doc).toContain('- Class: APPLICATION_FIX — application code change');
    expect(doc).toContain('- Confidence: medium — verify first');
    expect(doc).toContain('- Evidence: Evidence for health-check.');
    expect(doc).toContain('- Done when:');
    expect(doc).toContain('Do not add a Dockerfile HEALTHCHECK');
    expect(doc).not.toContain('reference it from the container health check');
  });

  it('warns that the fixes alone do not make the app deployable when a blocking decision exists', () => {
    expect(assembleFixInstructions(ctx, NO_AI)).toContain('A blocking vendor decision is listed under "Vendor decisions"');
    expect(assembleFixInstructions(context([finding('health-check')]), NO_AI)).not.toContain('A blocking vendor decision');
  });

  it('keeps declared workers as their own process', () => {
    const doc = assembleFixInstructions(ctx, NO_AI);
    expect(doc).toContain('- Declared workers: `node worker.js`');
    expect(doc).toContain('Keep every declared worker as its own process');
    expect(doc).not.toMatch(/### \d+\. .*worker/i);
  });

  it('renders safe AI guidance under its item and drops unsafe, unknown or overlong guidance', () => {
    const doc = assembleFixInstructions(ctx, {
      items: [
        { id: 'health-check', guidance: 'Register GET /health before the auth middleware.' },
        { id: 'unsupported-database-mongo', guidance: 'Remove the auth middleware so the probe passes.' },
        { id: 'not-an-item', guidance: 'Stray advice.' },
        { id: 'worker-process', guidance: 'x'.repeat(FIX_INSTRUCTIONS_MAX_GUIDANCE_CHARS + 1) },
      ],
    });
    expect(doc).toContain('  - Repository detail: Register GET /health before the auth middleware.');
    expect(doc).not.toContain('Remove the auth middleware');
    expect(doc).not.toContain('Stray advice.');
  });

  it('names the managed database engine and only relevant capabilities', () => {
    const mysql = assembleFixInstructions(context([finding('database-migrations', { severity: 'recommended' })], { database: 'mysql' }), NO_AI);
    expect(mysql).toContain('(this app: MySQL)');
    expect(mysql).toContain('disposable local database');
    expect(mysql).not.toContain('S3 bucket');

    const storage = assembleFixInstructions(context([finding('local-file-storage')], { database: 'none' }), NO_AI);
    expect(storage).toContain('`STORAGE_BUCKET`');
    expect(storage).toContain('access keys are never needed');
    expect(storage).not.toContain('Managed PostgreSQL');
  });

  it('marks recommended items and keeps the completion report honest', () => {
    const doc = assembleFixInstructions(context([finding('worker-command', { severity: 'recommended' })]), NO_AI);
    expect(doc).toMatch(/### 1\. .* \(recommended\)/);
    expect(doc).toContain('do not claim success for steps not run');
    expect(doc).toContain('A successful build alone does not prove a fix');
  });

  it('renders only the env-var names, under the packaging item', () => {
    const doc = assembleFixInstructions(
      context([finding('container-setup')], {
        dockerfilePath: null,
        envRequirements: { buildTime: ['NPM_TOKEN'], runtime: ['STRIPE_KEY'], platformInjected: ['DATABASE_URL'] },
      }),
      NO_AI,
    );
    expect(doc).toContain('- Required at build time (names only): NPM_TOKEN');
    expect(doc).toContain('- Provided by Deployz at runtime (names only): DATABASE_URL');
  });
});

// ==========================================================================
// generateFixInstructions
// ==========================================================================

const baseContext = context([finding('container-setup'), finding('database-migrations', { severity: 'recommended' })], { dockerfilePath: null });
const validAiObject: FixInstructionsAiOutput = {
  items: [{ id: 'container-setup', guidance: 'Use a multi-stage build that copies only the build output.' }],
};

describe('generateFixInstructions', () => {
  it('happy path: assembles the document via the injected gateway', async () => {
    let seenOptions: AiGenerateOptions | undefined;
    const gateway: AiGateway = {
      async generate(_prompt, _schema, options) {
        seenOptions = options;
        return { object: validAiObject, usage: { promptTokens: 500, completionTokens: 100 } };
      },
    };

    const doc = await generateFixInstructions(baseContext, gateway);

    expect(doc).toContain(FIX_INSTRUCTIONS_GUARDRAIL);
    expect(doc).toContain('Use a multi-stage build that copies only the build output.');
    expect(seenOptions?.label).toBe('fix-instructions');
    expect(seenOptions?.maxOutputTokens).toBe(FIX_INSTRUCTIONS_MAX_OUTPUT_TOKENS);
    expect(seenOptions?.reasoning).toBe(false);
    expect(seenOptions?.attemptTimeoutMs).toBe(FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS);
  });

  it('makes no model call when every finding is already supported', async () => {
    const gateway: AiGateway = {
      async generate() {
        throw new Error('the model must not be called');
      },
    };
    const informational = context([
      finding('worker-process', { severity: 'recommended', suggestedOutcome: 'No change needed — Deployz will start the worker process alongside your app.' }),
    ]);

    const doc = await generateFixInstructions(informational, gateway);

    expect(doc).toContain('## Already supported — keep as is');
    expect(doc).not.toContain('## Fixes, in order');
  });

  it('throws on a schema-violating response', async () => {
    await expect(
      generateFixInstructions(
        baseContext,
        fixtureGateway({ object: { items: 'nope', extra: true }, usage: { promptTokens: 500, completionTokens: 100 } }),
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
  });

  it('throws SpendLimitExceededError when reported usage exceeds the total-token budget', async () => {
    await expect(
      generateFixInstructions(
        baseContext,
        fixtureGateway({ object: validAiObject, usage: { promptTokens: FIX_INSTRUCTIONS_MAX_TOTAL_TOKENS, completionTokens: 1 } }),
      ),
    ).rejects.toBeInstanceOf(SpendLimitExceededError);
  });

  it('propagates a gateway failure unchanged', async () => {
    const networkError = new Error('fetch failed');
    const gateway: AiGateway = {
      async generate() {
        throw networkError;
      },
    };

    await expect(generateFixInstructions(baseContext, gateway)).rejects.toBe(networkError);
  });
});

// ==========================================================================
// Synchronous request budget
// ==========================================================================

describe('FIX_INSTRUCTIONS_TIMEOUT_MS', () => {
  it('abandons generation before the API Lambda and HTTP API 30-second limits', () => {
    // The route runs inside a 30s Lambda behind a 30s HTTP API integration.
    // An abort at or above that mark never fires: the platform kills the
    // request first, the vendor gets an opaque gateway error, and the
    // 'fix-instructions generation failed' log line is never written.
    expect(FIX_INSTRUCTIONS_TIMEOUT_MS).toBeLessThan(30_000);
  });

  it('gives one attempt nearly the whole budget, so a thinking model can answer', () => {
    expect(FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(FIX_INSTRUCTIONS_TIMEOUT_MS);
    expect(FIX_INSTRUCTIONS_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
  });
});
