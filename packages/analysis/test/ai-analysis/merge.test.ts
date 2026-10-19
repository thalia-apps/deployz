import { describe, expect, it } from 'vitest';

import { analyseRepo, type AnalysisResult } from '../../src/analyser.js';
import type { AnalystOutput, FactName } from '../../src/ai-analysis/analyst.js';
import { checkFacts } from '../../src/ai-analysis/checks.js';
import { mergeAiFacts, type MergeResult } from '../../src/ai-analysis/merge.js';
import type { FileTree } from '../../src/detectors.js';
import { cite, factsOf, packOf } from './helpers.js';

const NOTES = [
  'Notes',
  'Uploads go to the s3 bucket.',
  'The queue worker runs node dist/queue.js.',
  'Run prisma migrate deploy before the app starts.',
  'Jobs use bullmq with redis.',
  'Local runs use a sqlite file.',
  'Migrations run at startup.',
  'The app needs process.env.LICENSE_CODE to start.',
  'The app needs process.env.LICENSE_KEY to start.',
  'The app needs a mysql server.',
].join('\n');

const baseTree: FileTree = {
  Dockerfile: [
    'FROM node:20',
    'EXPOSE 3000',
    'HEALTHCHECK CMD curl -f http://localhost:3000/health || exit 1',
    'CMD ["node", "dist/index.js"]',
  ].join('\n'),
  'deploy/Dockerfile': 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    name: 'a',
    scripts: { start: 'node dist/index.js' },
    dependencies: { express: '^4', pg: '^8' },
  }),
  '.env.example': 'DATABASE_URL=postgres://u:p@h/db\n',
  'src/index.ts': [
    "app.get('/health', r);",
    'app.listen(process.env.PORT || 3000);',
    'const k = process.env.SECRET_KEY;',
    'const t = process.env.API_TOKEN;',
    'const u = process.env.WEBHOOK_URL;',
    "const o = process.env.OPT_FLAG || 'x';",
  ].join('\n'),
  'src/routes.ts': "router.get('/healthz', ok);",
  'src/config.ts': 'export const PUBLIC_PORT = 8080;',
  'docs/notes.md': NOTES,
};

/** The app does not read PORT: the Dockerfile port is the only port signal. */
const noPortReadTree: FileTree = {
  ...baseTree,
  'src/index.ts': baseTree['src/index.ts']!.replace('app.listen(process.env.PORT || 3000);', 'app.listen(3000);'),
};

const NOTE = { s3: 2, worker: 3, migrate: 4, redis: 5, sqlite: 6, startup: 7, mysql: 10 } as const;

interface Run {
  readonly rules: AnalysisResult;
  readonly merged: MergeResult;
}

function run(tree: FileTree, facts: AnalystOutput, questions: Array<{ fact: FactName; subject: string | null; reason: string }> = [], packTree: FileTree = tree): Run {
  const rules = analyseRepo(tree);
  const pack = packOf(packTree);
  const checks = checkFacts({ pack, tree }, facts, typeof rules.metadata['dockerfilePath'] === 'string' ? rules.metadata['dockerfilePath'] : null);
  return { rules, merged: mergeAiFacts({ tree, rules, pack, facts, checks, questions }) };
}

const high = <T>(value: T, evidence: AnalystOutput['port']['evidence']) => ({ value, confidence: 'high' as const, evidence });
const decision = (merged: MergeResult, fact: string, subject: string | null = null) =>
  merged.facts.find((item) => item.fact === fact && item.subject === subject);
const envEntry = (result: AnalysisResult, key: string) =>
  (result.metadata['envVarModel'] as Array<Record<string, unknown>>).find((entry) => entry['key'] === key);
const finding = (result: AnalysisResult, detector: string) => result.findings.find((item) => item.detector === detector);

describe('the fixture', () => {
  it('has the rules values the tests rely on', () => {
    const { metadata } = analyseRepo(baseTree);
    expect(metadata['port']).toBe('3000');
    expect(metadata['healthPath']).toBe('/health');
    expect(metadata['dockerfilePath']).toBe('Dockerfile');
    expect((metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect((metadata['redis'] as { required: boolean }).required).toBe(false);
    expect(metadata['usesS3']).toBe(false);
    expect(metadata['migrationMode']).toBe('unknown');
    expect(metadata['resolvedWorkerCommands']).toEqual([]);
    expect(analyseRepo(noPortReadTree).metadata['port']).toBe('3000');
  });
});

describe('mergeAiFacts: agree', () => {
  it('changes nothing when the AI agrees with the rules', () => {
    const facts = factsOf({
      dockerfile: high({ path: 'Dockerfile', context: '.' }, []),
      port: high(3000, cite('Dockerfile', 2, 'EXPOSE 3000')),
      healthPath: high('/health', cite('src/index.ts', 1, '/health')),
      database: high('postgres' as const, cite('package.json', 1, '"pg"')),
      requiredVariables: [{ name: 'API_TOKEN', confidence: 'high', evidence: cite('src/index.ts', 4, 'process.env.API_TOKEN') }],
    });
    const { rules, merged } = run(baseTree, facts);
    expect(merged.analysis.metadata).toEqual(rules.metadata);
    expect(merged.analysis.findings).toEqual(rules.findings);
    expect(merged.analysis.rejections).toEqual(rules.rejections);
    expect(merged.aiResolved).toEqual([]);
    expect(merged.migration).toBeNull();
    expect(merged.workers).toBeNull();
    expect(merged.facts.every((item) => item.decision === 'agree')).toBe(true);
  });
});

describe('mergeAiFacts: a differing fact that passes', () => {
  it('port: the AI value enters the metadata and the port finding', () => {
    const { merged } = run(baseTree, factsOf({ port: high(8080, cite('src/config.ts', 1, 'PUBLIC_PORT = 8080')) }));
    expect(decision(merged, 'port')?.decision).toBe('ai');
    expect(merged.analysis.metadata['port']).toBe('8080');
    expect(merged.analysis.metadata['portSource']).toBe('ai');
    expect(merged.analysis.metadata['portConfidence']).toBe('high');
    expect(finding(merged.analysis, 'port')).toMatchObject({ detected: true, value: '8080', portSource: 'ai', portConfidence: 'high' });
  });

  it('health path: the AI value enters the metadata and the health-endpoint finding', () => {
    const { merged } = run(baseTree, factsOf({ healthPath: high('/healthz', cite('src/routes.ts', 1, "'/healthz'")) }));
    expect(decision(merged, 'healthPath')?.decision).toBe('ai');
    expect(merged.analysis.metadata).toMatchObject({ healthPath: '/healthz', healthMode: 'explicit', hasHealthEndpoint: true });
    expect(finding(merged.analysis, 'health-endpoint')).toMatchObject({ detected: true, path: '/healthz', mode: 'explicit' });
  });

  it('start command: the AI value replaces the startup commands', () => {
    const { merged } = run(baseTree, factsOf({ startCommand: high('node dist/server.js', cite('docs/notes.md', NOTE.worker, 'node dist/queue.js')) }));
    // The rules know the image command, so a failed description keeps it instead of asking.
    expect(decision(merged, 'startCommand')?.decision).toBe('rules');
    const passing = run(
      { ...baseTree, 'docs/start.md': 'Start with node dist/server.js' },
      factsOf({ startCommand: high('node dist/server.js', cite('docs/start.md', 1, 'node dist/server.js')) }),
    ).merged;
    expect(decision(passing, 'startCommand')?.decision).toBe('ai');
    expect(passing.analysis.metadata).toMatchObject({ startupCommands: ['node dist/server.js'], hasStartupCommand: true });
  });

  it('dockerfile: the AI path and build context enter the metadata and the dockerfile finding', () => {
    const { merged } = run(baseTree, factsOf({ dockerfile: high({ path: 'deploy/Dockerfile', context: 'deploy' }, []) }));
    expect(decision(merged, 'dockerfile')?.decision).toBe('ai');
    expect(merged.analysis.metadata['dockerfilePath']).toBe('deploy/Dockerfile');
    expect(merged.analysis.metadata['dockerfileBuildContext']).toBe('deploy');
    expect(merged.analysis.metadata).not.toHaveProperty('dockerfileMissingSources');
    expect(finding(merged.analysis, 'dockerfile')).toMatchObject({ detected: true, value: 'deploy/Dockerfile' });
  });

  it('dockerfile: a root build context removes the context entry', () => {
    const { merged } = run(baseTree, factsOf({ dockerfile: high({ path: 'deploy/Dockerfile', context: '.' }, []) }));
    expect(merged.analysis.metadata['dockerfilePath']).toBe('deploy/Dockerfile');
    expect(merged.analysis.metadata).not.toHaveProperty('dockerfileBuildContext');
  });

  it('storage: the s3 finding and usesS3 follow the AI value', () => {
    const { rules, merged } = run(baseTree, factsOf({ storage: high(true, cite('docs/notes.md', NOTE.s3, 's3 bucket')) }));
    expect(rules.metadata['usesS3']).toBe(false);
    expect(decision(merged, 'storage')?.decision).toBe('ai');
    expect(merged.analysis.metadata['usesS3']).toBe(true);
    expect(finding(merged.analysis, 's3')?.detected).toBe(true);
    expect(merged.analysis.metadata['usesS3']).toBe(analyseRepo(baseTree, { storage: true }).metadata['usesS3']);
  });

  it('database: re-runs the rules with the override', () => {
    const { rules, merged } = run(baseTree, factsOf({ database: high('mysql' as const, cite('docs/notes.md', NOTE.mysql, 'mysql server')) }));
    const expected = analyseRepo(baseTree, { database: 'mysql' });
    expect(decision(merged, 'database')?.decision).toBe('ai');
    expect((rules.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect((merged.analysis.metadata['mysql'] as { required: boolean }).required).toBe(true);
    expect(merged.analysis.metadata['envVarModel']).toEqual(expected.metadata['envVarModel']);
    expect(merged.analysis.metadata['migrationMode']).toBe(expected.metadata['migrationMode']);
  });

  it('database: never removes a database that the rules require (PostgreSQL wins)', () => {
    const { rules, merged } = run(baseTree, factsOf({ database: high('none' as const, cite('docs/notes.md', NOTE.sqlite, 'sqlite file')) }));
    expect(decision(merged, 'database')).toMatchObject({ decision: 'rules', reasons: ['the rules require a database; the AI never removes one'] });
    expect((merged.analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(merged.analysis.metadata['envVarModel']).toEqual(rules.metadata['envVarModel']);
  });

  it('redis: re-runs the rules with the override', () => {
    const { merged } = run(baseTree, factsOf({ redis: high(true, cite('docs/notes.md', NOTE.redis, 'bullmq with redis')) }));
    const expected = analyseRepo(baseTree, { redis: true });
    expect(decision(merged, 'redis')?.decision).toBe('ai');
    expect((merged.analysis.metadata['redis'] as { required: boolean }).required).toBe(true);
    expect(merged.analysis.metadata['envVarModel']).toEqual(expected.metadata['envVarModel']);
  });
});

describe('mergeAiFacts: port, health and start that fail become questions', () => {
  it('port', () => {
    const { merged } = run(noPortReadTree, factsOf({ port: high(8080, cite('src/config.ts', 1, 'PUBLIC_PORT = 8080')) }));
    const item = decision(merged, 'port');
    expect(item?.decision).toBe('question');
    expect(item?.reasons.join(' ')).toContain('does not read PORT');
    expect(merged.analysis.metadata['port']).toBeNull();
    expect(merged.analysis.metadata).not.toHaveProperty('portSource');
    expect(merged.analysis.metadata).not.toHaveProperty('portConfidence');
    expect(finding(merged.analysis, 'port')?.detected).toBe(false);
  });

  it('health path', () => {
    const { merged } = run(baseTree, factsOf({ healthPath: high('/ready', cite('src/routes.ts', 1, "'/healthz'")) }));
    expect(decision(merged, 'healthPath')?.decision).toBe('question');
    expect(merged.analysis.metadata['healthPath']).toBeNull();
    expect(merged.analysis.metadata['healthMode']).toBe('vendor_required');
    expect(finding(merged.analysis, 'health-endpoint')).toMatchObject({ detected: false, mode: 'vendor_required' });
  });

  it('start command, when the rules found no command either', () => {
    const tree: FileTree = {
      ...baseTree,
      Dockerfile: 'FROM node:20\nEXPOSE 3000',
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4', pg: '^8' } }),
    };
    const { rules, merged } = run(tree, factsOf({ startCommand: high('gunicorn app:app', cite('Dockerfile', 2, 'EXPOSE 3000')) }));
    expect(rules.metadata['startupCommands'] ?? []).toEqual([]);
    expect(decision(merged, 'startCommand')?.decision).toBe('question');
    expect(merged.analysis.metadata['startupCommands']).toEqual([]);
    expect(merged.analysis.metadata['hasStartupCommand']).toBe(false);
  });

  it('start command: a failed description keeps the command the rules found', () => {
    const { rules, merged } = run(baseTree, factsOf({ startCommand: high('gunicorn app:app', cite('Dockerfile', 4, 'dist/index.js')) }));
    expect(decision(merged, 'startCommand')?.decision).toBe('rules');
    expect(merged.analysis.metadata['startupCommands']).toEqual(rules.metadata['startupCommands']);
  });

  it('an open reviewer objection makes a question even when the AI agrees with the rules', () => {
    const { merged } = run(
      baseTree,
      factsOf({ port: high(3000, cite('Dockerfile', 2, 'EXPOSE 3000')) }),
      [{ fact: 'port', subject: null, reason: 'the port looks wrong' }],
    );
    const item = decision(merged, 'port');
    expect(item?.decision).toBe('question');
    expect(item?.reasons).toContain('reviewer: the port looks wrong');
    expect(merged.analysis.metadata['port']).toBeNull();
  });
});

describe('mergeAiFacts: database, redis and storage that fail keep the rules value', () => {
  const bad = cite('docs/notes.md', 1, 'Notes');

  it.each([
    ['database', factsOf({ database: high('mysql' as const, bad) })],
    ['redis', factsOf({ redis: high(true, bad) })],
    ['storage', factsOf({ storage: high(true, bad) })],
  ])('%s', (fact, facts) => {
    const { rules, merged } = run(baseTree, facts);
    expect(decision(merged, fact)?.decision).toBe('rules');
    expect(merged.analysis.metadata).toEqual(rules.metadata);
    expect(merged.analysis.findings).toEqual(rules.findings);
  });
});

describe('mergeAiFacts: rejections never change', () => {
  const rejectedTree: FileTree = {
    ...baseTree,
    'package.json': JSON.stringify({ scripts: { start: 'node dist/index.js' }, dependencies: { express: '^4', pg: '^8', mongodb: '^6' } }),
    'src/mongo.ts': 'const c = new MongoClient(process.env.MONGODB_URI);',
  };

  it('keeps the rejections and the unsupported reasons when the AI says everything is fine', () => {
    const facts = factsOf({
      database: high('none' as const, cite('docs/notes.md', NOTE.sqlite, 'sqlite file')),
      redis: high(false, cite('docs/notes.md', NOTE.sqlite, 'sqlite file')),
      storage: high(true, cite('docs/notes.md', NOTE.s3, 's3 bucket')),
      port: high(8080, cite('src/config.ts', 1, 'PUBLIC_PORT = 8080')),
    });
    const { rules, merged } = run(rejectedTree, facts);
    expect(rules.rejections.some((item) => item.detected)).toBe(true);
    expect(decision(merged, 'storage')?.decision).toBe('ai');
    expect(merged.analysis.rejections).toEqual(rules.rejections);
    expect(merged.analysis.metadata['unsupportedReasons']).toEqual(rules.metadata['unsupportedReasons']);
  });
});

describe('mergeAiFacts: required variables', () => {
  it('never gives the vendor a variable that Deployz provides: a minted secret or a binding of the provisioned database', () => {
    const facts = factsOf({
      requiredVariables: [
        { name: 'SECRET_KEY', confidence: 'high', evidence: cite('src/index.ts', 3, 'process.env.SECRET_KEY') },
        { name: 'DATABASE_URL', confidence: 'high', evidence: cite('.env.example', 1, 'DATABASE_URL=') },
      ],
    });
    const { rules, merged } = run(baseTree, facts);
    expect(rules.metadata['postgres']).toMatchObject({ required: true });
    expect(decision(merged, 'requiredVariables', 'SECRET_KEY')).toBeUndefined();
    expect(decision(merged, 'requiredVariables', 'DATABASE_URL')).toBeUndefined();
    expect(envEntry(merged.analysis, 'SECRET_KEY')?.['classification']).toBe(envEntry(rules, 'SECRET_KEY')?.['classification']);
  });

  it('adds a passing required variable as customer_required', () => {
    const facts = factsOf({
      requiredVariables: [{ name: 'LICENSE_CODE', confidence: 'high', evidence: cite('docs/notes.md', 8, 'process.env.LICENSE_CODE') }],
    });
    const { rules, merged } = run(baseTree, facts);
    expect(envEntry(rules, 'LICENSE_CODE')).toBeUndefined();
    expect(decision(merged, 'requiredVariables', 'LICENSE_CODE')?.decision).toBe('ai');
    expect(envEntry(merged.analysis, 'LICENSE_CODE')).toMatchObject({ required: true, classification: 'customer_required', secret: false, source: ['ai'] });
  });

  it('marks a new variable with a secret-like name as secret', () => {
    const facts = factsOf({
      requiredVariables: [{ name: 'LICENSE_KEY', confidence: 'high', evidence: cite('docs/notes.md', 9, 'process.env.LICENSE_KEY') }],
    });
    expect(envEntry(run(baseTree, facts).merged.analysis, 'LICENSE_KEY')).toMatchObject({ required: true, secret: true });
  });

  it('turns a rules-optional variable into a required one', () => {
    const facts = factsOf({
      requiredVariables: [{ name: 'WEBHOOK_URL', confidence: 'high', evidence: cite('src/index.ts', 5, 'process.env.WEBHOOK_URL') }],
    });
    const { rules, merged } = run(baseTree, facts);
    expect(envEntry(rules, 'WEBHOOK_URL')).toMatchObject({ required: false, classification: 'optional' });
    expect(envEntry(merged.analysis, 'WEBHOOK_URL')?.['required']).toBe(true);
  });

  // Source bug: merge.ts sets `required` on an existing entry but keeps classification 'optional'.
  it('classifies a promoted rules-optional variable as customer_required', () => {
    const facts = factsOf({
      requiredVariables: [{ name: 'WEBHOOK_URL', confidence: 'high', evidence: cite('src/index.ts', 5, 'process.env.WEBHOOK_URL') }],
    });
    expect(envEntry(run(baseTree, facts).merged.analysis, 'WEBHOOK_URL')?.['classification']).toBe('customer_required');
  });

  it('does not add a variable that fails its check', () => {
    const facts = factsOf({
      requiredVariables: [{ name: 'OPT_FLAG', confidence: 'high', evidence: cite('src/index.ts', 6, 'process.env.OPT_FLAG') }],
    });
    const { merged } = run(baseTree, facts);
    expect(decision(merged, 'requiredVariables', 'OPT_FLAG')?.decision).toBe('rules');
    expect(envEntry(merged.analysis, 'OPT_FLAG')?.['required']).not.toBe(true);
  });

  it('makes a rules-required variable optional when the AI omits it and the pack shows a guarded read', () => {
    const guardedPack: FileTree = { ...baseTree, 'extra/settings.py': 'token = os.getenv("API_TOKEN", "dev")' };
    const { rules, merged } = run(baseTree, factsOf(), [], guardedPack);
    expect(envEntry(rules, 'API_TOKEN')).toMatchObject({ required: true, classification: 'customer_required' });
    expect(envEntry(merged.analysis, 'API_TOKEN')).toMatchObject({ required: false, classification: 'optional' });
    expect(decision(merged, 'requiredVariables', 'API_TOKEN')).toMatchObject({ decision: 'ai', value: false });
  });

  it('keeps a rules-required variable when the AI omits it and the pack shows no guarded read', () => {
    const { rules, merged } = run(baseTree, factsOf());
    expect(envEntry(merged.analysis, 'API_TOKEN')).toEqual(envEntry(rules, 'API_TOKEN'));
    expect(decision(merged, 'requiredVariables', 'API_TOKEN')).toBeUndefined();
  });

  it('keeps a rules-required variable that the AI lists, even when the pack shows a guarded read', () => {
    const guardedPack: FileTree = { ...baseTree, 'extra/settings.py': 'token = os.getenv("API_TOKEN", "dev")' };
    const facts = factsOf({
      requiredVariables: [{ name: 'API_TOKEN', confidence: 'high', evidence: cite('src/index.ts', 4, 'process.env.API_TOKEN') }],
    });
    const { merged } = run(baseTree, facts, [], guardedPack);
    expect(envEntry(merged.analysis, 'API_TOKEN')?.['required']).toBe(true);
  });

  it('does not make a deployz_generated variable optional', () => {
    const guardedPack: FileTree = { ...baseTree, 'extra/settings.py': 'k = os.getenv("SECRET_KEY", "dev")' };
    const { merged } = run(baseTree, factsOf(), [], guardedPack);
    expect(envEntry(merged.analysis, 'SECRET_KEY')).toMatchObject({ required: true, classification: 'deployz_generated' });
  });
});

describe('mergeAiFacts: workers', () => {
  const worker = (line: number) => ({ id: 'queue', command: 'node dist/queue.js', confidence: 'high' as const, evidence: cite('docs/notes.md', line, 'node dist/queue.js') });

  it('adds a verified AI worker', () => {
    const { merged } = run(baseTree, factsOf({ workers: [worker(NOTE.worker)] }));
    expect(decision(merged, 'workers', 'queue')?.decision).toBe('ai');
    expect(merged.workers).toEqual([{ id: 'queue', command: 'node dist/queue.js', source: 'docs/notes.md' }]);
    expect(merged.analysis.metadata['resolvedWorkerCommands']).toEqual(merged.workers);
    expect(merged.aiResolved).toContain('workers');
  });

  it('does not add a worker that fails its check', () => {
    const { merged } = run(baseTree, factsOf({ workers: [worker(NOTE.sqlite)] }));
    expect(decision(merged, 'workers', 'queue')?.decision).toBe('rules');
    expect(merged.workers).toBeNull();
    expect(merged.aiResolved).not.toContain('workers');
  });

  it('keeps the workers of the rules and adds the AI worker to them', () => {
    const withProcfile: FileTree = { ...baseTree, Procfile: 'web: node dist/index.js\nworker: node dist/worker.js\n' };
    const { rules, merged } = run(withProcfile, factsOf({ workers: [worker(NOTE.worker)] }));
    expect(rules.metadata['resolvedWorkerCommands']).toEqual([{ id: 'worker', command: 'node dist/worker.js', source: 'Procfile' }]);
    expect(merged.workers?.map((item) => item.id)).toEqual(['worker', 'queue']);
  });

  it('treats a worker that the rules already know as agreed', () => {
    const withProcfile: FileTree = { ...baseTree, Procfile: 'web: node dist/index.js\nworker: node dist/queue.js\n' };
    const { merged } = run(withProcfile, factsOf({ workers: [worker(NOTE.worker)] }));
    expect(decision(merged, 'workers', 'queue')?.decision).toBe('agree');
    expect(merged.workers).toBeNull();
  });
});

describe('mergeAiFacts: migration', () => {
  it('returns {command} for a migration command that passes', () => {
    const facts = factsOf({
      migration: high({ mode: 'pre_deploy' as const, command: 'npx prisma migrate deploy' }, cite('docs/notes.md', NOTE.migrate, 'prisma migrate deploy')),
    });
    const { merged } = run(baseTree, facts);
    expect(merged.migration).toEqual({ command: 'npx prisma migrate deploy' });
    expect(merged.aiResolved).toContain('migrationCommand');
    expect(merged.analysis.metadata).toMatchObject({ migrationMode: 'pre_deploy', migrationCommands: ['npx prisma migrate deploy'] });
  });

  it('returns {candidate, reason} for a migration command that fails', () => {
    const facts = factsOf({
      migration: high({ mode: 'pre_deploy' as const, command: 'npx prisma migrate deploy' }, cite('docs/notes.md', NOTE.s3, 's3 bucket')),
    });
    const { rules, merged } = run(baseTree, facts);
    expect(merged.migration).toMatchObject({ candidate: 'npx prisma migrate deploy' });
    expect((merged.migration as { reason: string }).reason.length).toBeGreaterThan(0);
    expect(merged.aiResolved).not.toContain('migrationCommand');
    expect(merged.analysis.metadata['migrationMode']).toBe(rules.metadata['migrationMode']);
  });

  it('sets the startup mode with its evidence when the mode passes', () => {
    const tree: FileTree = { ...baseTree, Procfile: 'web: node dist/migrate.js && node dist/index.js\n' };
    const facts = factsOf({ migration: high({ mode: 'startup' as const, command: null }, cite('Procfile', 1, 'node dist/migrate.js')) });
    const { merged } = run(tree, facts);
    expect(merged.analysis.metadata['migrationMode']).toBe('startup');
    expect(merged.analysis.metadata['migrationStartupEvidence']).toEqual([{ path: 'Procfile', line: 1, fromDockerCommand: false }]);
    expect(merged.migration).toBeNull();
  });

  it('keeps the rules mode for "no migration" when the deployment keeps a database', () => {
    const facts = factsOf({
      database: high('none' as const, cite('docs/notes.md', NOTE.sqlite, 'sqlite file')),
      migration: high({ mode: 'none' as const, command: null }, []),
    });
    const { rules, merged } = run(baseTree, facts);
    expect((merged.analysis.metadata['postgres'] as { required: boolean }).required).toBe(true);
    expect(decision(merged, 'migration')).toMatchObject({ decision: 'rules', reasons: ['the deployment keeps a database, so its schema is migrated'] });
    expect(merged.analysis.metadata['migrationMode']).toBe(rules.metadata['migrationMode']);
  });

  it('keeps the rules mode when a mode without a command fails', () => {
    const facts = factsOf({ migration: high({ mode: 'startup' as const, command: null }, cite('docs/notes.md', NOTE.s3, 's3 bucket')) });
    const { rules, merged } = run(baseTree, facts);
    expect(decision(merged, 'migration')?.decision).toBe('rules');
    expect(merged.analysis.metadata['migrationMode']).toBe(rules.metadata['migrationMode']);
    expect(merged.migration).toBeNull();
  });
});
