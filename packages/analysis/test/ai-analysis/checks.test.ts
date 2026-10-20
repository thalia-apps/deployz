import { describe, expect, it } from 'vitest';

import type { AnalystOutput } from '../../src/ai-analysis/analyst.js';
import {
  checkEvidence,
  checkFacts,
  checkPort,
  checkRequiredVariable,
  citedLine,
  dockerfilePorts,
  guardedRead,
  type CheckContext,
} from '../../src/ai-analysis/checks.js';
import type { FileTree } from '../../src/detectors.js';
import { cite, factsOf, packOf } from './helpers.js';

const ctxOf = (tree: FileTree): CheckContext => ({ tree, pack: packOf(tree) });
const anything = () => true;

describe('citedLine and checkEvidence', () => {
  const pack = packOf({ 'app.js': ['one', 'const a  =   require("x");', 'three', 'four', 'five'].join('\n') });

  it('accepts a citation whose line holds the quote', () => {
    expect(citedLine(pack, { path: 'app.js', line: 3, quote: 'three' })).toBe('three');
  });

  it('ignores whitespace differences', () => {
    expect(citedLine(pack, { path: 'app.js', line: 2, quote: 'const a = require("x");' })).not.toBeNull();
  });

  it('allows one line of tolerance either way and returns the line that holds the quote', () => {
    expect(citedLine(pack, { path: 'app.js', line: 2, quote: 'three' })).toBe('three');
    expect(citedLine(pack, { path: 'app.js', line: 4, quote: 'three' })).toBe('three');
  });

  it('rejects a line two lines away', () => {
    expect(citedLine(pack, { path: 'app.js', line: 5, quote: 'three' })).toBeNull();
    expect(citedLine(pack, { path: 'app.js', line: 1, quote: 'three' })).toBeNull();
  });

  it('rejects a missing file, a line outside the file and a quote that is not on the line', () => {
    expect(citedLine(pack, { path: 'missing.js', line: 1, quote: 'one' })).toBeNull();
    expect(citedLine(pack, { path: 'app.js', line: 99, quote: 'one' })).toBeNull();
    expect(citedLine(pack, { path: 'app.js', line: 3, quote: 'nowhere' })).toBeNull();
  });

  it('rejects a one-character quote', () => {
    expect(citedLine(pack, { path: 'app.js', line: 3, quote: 't' })).toBeNull();
  });

  it('needs at least one evidence item', () => {
    expect(checkEvidence(pack, [], anything)).toEqual(['no evidence']);
  });

  it('reports a bad citation and a line that does not support the claim', () => {
    expect(checkEvidence(pack, cite('missing.js', 1, 'one'), anything)[0]).toContain('does not exist in the evidence');
    expect(checkEvidence(pack, cite('app.js', 3, 'three'), (line) => line.includes('zzz'))[0]).toContain('no cited line supports the claim');
    expect(checkEvidence(pack, cite('app.js', 3, 'three'), anything)).toEqual([]);
  });

  it('accepts a reasoning chain: one supporting line is enough when every cited line exists', () => {
    const chain = [...cite('app.js', 3, 'three'), ...cite('app.js', 1, 'one')];
    expect(checkEvidence(pack, chain, (line) => line.includes('three'))).toEqual([]);
    expect(checkEvidence(pack, chain, (line) => line.includes('zzz'))).toHaveLength(1);
  });

  it('fails when any one of several citations is bad', () => {
    const evidence = [...cite('app.js', 3, 'three'), ...cite('app.js', 3, 'nowhere')];
    expect(checkEvidence(pack, evidence, anything)).toHaveLength(1);
  });
});

describe('required variables', () => {
  const variable = (name: string, path: string, line: number, quote: string, confidence: 'high' | 'medium' | 'low' = 'high') => ({
    name,
    confidence,
    evidence: cite(path, line, quote),
  });

  it.each([
    ['process.env.X', 'const v = process.env.X;'],
    ['os.environ["X"]', 'v = os.environ["X"]'],
    ['ENV.fetch("X")', 'v = ENV.fetch("X")'],
    ['System.fetch_env!("X")', 'v = System.fetch_env!("X")'],
  ])('passes for an unguarded read: %s', (_label, source) => {
    const ctx = ctxOf({ 'src/config.txt': `first\n${source}\n` });
    const result = checkRequiredVariable(ctx, variable('X', 'src/config.txt', 2, source));
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.fact).toBe('requiredVariables');
    expect(result.subject).toBe('X');
  });

  it.each([
    ['process.env.X || "a"', 'const v = process.env.X || "a";'],
    ['process.env.X ?? "a"', 'const v = process.env.X ?? "a";'],
    ['os.getenv("X", "d")', 'v = os.getenv("X", "d")'],
    ['${X:-d}', 'v=${X:-d}'],
    ['if (process.env.X)', 'if (process.env.X) { start(); }'],
  ])('fails for a default or a guard: %s', (_label, source) => {
    const ctx = ctxOf({ 'src/config.txt': `first\n${source}\n` });
    const result = checkRequiredVariable(ctx, variable('X', 'src/config.txt', 2, source));
    expect(result.ok).toBe(false);
  });

  it('fails when another pack file reads the variable with a default', () => {
    const ctx = ctxOf({
      'src/a.js': 'const v = process.env.X;',
      'src/b.js': 'const w = process.env.X || "fallback";',
    });
    const result = checkRequiredVariable(ctx, variable('X', 'src/a.js', 1, 'process.env.X'));
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('src/b.js:1 reads it with a default or a guard');
  });

  it('does not count an env sample as a guarded read', () => {
    const ctx = ctxOf({ 'src/a.js': 'const v = process.env.X;', '.env.example': 'X=\nY=${X:-d}' });
    expect(checkRequiredVariable(ctx, variable('X', 'src/a.js', 1, 'process.env.X')).ok).toBe(true);
  });

  it('fails for low confidence', () => {
    const ctx = ctxOf({ 'src/a.js': 'const v = process.env.X;' });
    const result = checkRequiredVariable(ctx, variable('X', 'src/a.js', 1, 'process.env.X', 'low'));
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('low confidence');
  });

  it('fails when the cited line does not name the variable', () => {
    const ctx = ctxOf({ 'src/a.js': 'const a = 1;\nconst v = process.env.X;' });
    expect(checkRequiredVariable(ctx, variable('X', 'src/a.js', 1, 'const a = 1;')).ok).toBe(false);
  });

  it('does not match a longer name that contains the variable', () => {
    const ctx = ctxOf({ 'src/a.js': 'const v = process.env.X_EXTRA;' });
    expect(checkRequiredVariable(ctx, variable('X', 'src/a.js', 1, 'process.env.X_EXTRA')).ok).toBe(false);
  });

  it('fails without a citation to a missing file or line', () => {
    const ctx = ctxOf({ 'src/a.js': 'const v = process.env.X;' });
    expect(checkRequiredVariable(ctx, variable('X', 'nope.js', 1, 'process.env.X')).ok).toBe(false);
    expect(checkRequiredVariable(ctx, variable('X', 'src/a.js', 9, 'process.env.X')).ok).toBe(false);
    expect(checkRequiredVariable(ctx, { name: 'X', confidence: 'high', evidence: [] }).ok).toBe(false);
  });

  describe('guardedRead', () => {
    it('detects defaults and guards', () => {
      expect(guardedRead('x = ENV["X"] || 1', 'X')).toBe(true);
      expect(guardedRead('x = ENV.fetch("X", "d")', 'X')).toBe(true);
      expect(guardedRead('x = $X or "d"', 'X')).toBe(true);
      expect(guardedRead('x = process.env.X', 'X')).toBe(false);
      expect(guardedRead('x = os.environ["X"]', 'X')).toBe(false);
    });
  });
});

describe('port', () => {
  const portFact = (value: number | null, path: string, line: number, quote: string, confidence: 'high' | 'low' = 'high') => ({
    value,
    confidence,
    evidence: cite(path, line, quote),
  });

  it('passes for a null port', () => {
    expect(checkPort(ctxOf({}), factsOf().port, null).ok).toBe(true);
  });

  it.each([
    ['EXPOSE', 'FROM node:20\nEXPOSE 8080\nCMD ["node","a.js"]', 2, 'EXPOSE 8080'],
    ['ENV PORT', 'FROM node:20\nENV PORT=8080\nCMD ["node","a.js"]', 2, 'ENV PORT=8080'],
    ['HEALTHCHECK', 'FROM node:20\nHEALTHCHECK CMD curl -f http://localhost:8080/health\nCMD ["node","a.js"]', 2, 'localhost:8080'],
  ])('passes when it matches %s', (_label, dockerfile, line, quote) => {
    const ctx = ctxOf({ Dockerfile: dockerfile });
    const result = checkPort(ctx, portFact(8080, 'Dockerfile', line, quote), 'Dockerfile');
    expect(result.reasons).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('fails when the Dockerfile declares another port and the app does not read PORT', () => {
    const ctx = ctxOf({ Dockerfile: 'FROM node:20\nEXPOSE 3000\n', 'src/server.js': 'server.listen(8080);' });
    const result = checkPort(ctx, portFact(8080, 'src/server.js', 1, 'server.listen(8080)'), 'Dockerfile');
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('the Dockerfile declares 3000 and the app does not read PORT');
  });

  it('passes when the app reads PORT, whatever the Dockerfile declares', () => {
    const ctx = ctxOf({
      Dockerfile: 'FROM node:20\nEXPOSE 3000\n',
      'src/server.js': 'const p = process.env.PORT;\nserver.listen(p); // 8080',
    });
    expect(checkPort(ctx, portFact(8080, 'src/server.js', 2, 'server.listen(p); // 8080'), 'Dockerfile').ok).toBe(true);
  });

  it('passes when the Dockerfile declares no port', () => {
    const ctx = ctxOf({ Dockerfile: 'FROM node:20\nCMD ["node","a.js"]', 'src/server.js': 'server.listen(8080);' });
    expect(checkPort(ctx, portFact(8080, 'src/server.js', 1, 'server.listen(8080)'), 'Dockerfile').ok).toBe(true);
  });

  it('fails for low confidence and for a line without the port', () => {
    const ctx = ctxOf({ 'src/server.js': 'server.listen(8080);\nconsole.log("up");' });
    expect(checkPort(ctx, portFact(8080, 'src/server.js', 1, 'server.listen(8080)', 'low'), null).reasons).toContain('low confidence');
    expect(checkPort(ctx, portFact(8080, 'src/server.js', 2, 'console.log("up");'), null).ok).toBe(false);
  });

  it('does not match a longer number', () => {
    const ctx = ctxOf({ 'src/server.js': 'server.listen(18080);' });
    expect(checkPort(ctx, portFact(8080, 'src/server.js', 1, 'server.listen(18080)'), null).ok).toBe(false);
  });

  describe('dockerfilePorts', () => {
    it('reads the last stage only', () => {
      const content = 'FROM node:20 AS build\nEXPOSE 1111\nFROM node:20-slim\nEXPOSE 2222 3333/tcp\nENV PORT=4444';
      expect(dockerfilePorts(content).sort()).toEqual([2222, 3333, 4444]);
    });
  });
});

describe('dockerfile', () => {
  const dockerfileFact = (value: { path: string; context: string } | null, confidence: 'high' | 'low' = 'high') => ({ value, confidence, evidence: [] });
  const tree: FileTree = { Dockerfile: 'FROM node:20\n', 'README.md': 'docs', 'app/main.js': 'x' };
  const dockerfileCheck = (value: { path: string; context: string } | null, confidence: 'high' | 'low' = 'high') =>
    checkFacts(ctxOf(tree), factsOf({ dockerfile: dockerfileFact(value, confidence) }), null).find((c) => c.fact === 'dockerfile')!;

  it('passes for a candidate with an existing context', () => {
    expect(dockerfileCheck({ path: 'Dockerfile', context: '.' }).ok).toBe(true);
    expect(dockerfileCheck({ path: 'Dockerfile', context: './app/' }).ok).toBe(true);
  });

  it('fails for a path that does not exist', () => {
    const result = dockerfileCheck({ path: 'docker/Dockerfile', context: '.' });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('does not exist');
  });

  it('fails for an existing file that is not a Dockerfile candidate', () => {
    const result = dockerfileCheck({ path: 'README.md', context: '.' });
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('not a Dockerfile candidate');
  });

  it('fails for a context directory that does not exist and for low confidence', () => {
    expect(dockerfileCheck({ path: 'Dockerfile', context: 'missing' }).ok).toBe(false);
    expect(dockerfileCheck({ path: 'Dockerfile', context: '.' }, 'low').ok).toBe(false);
  });

  it('passes for a null Dockerfile', () => {
    expect(dockerfileCheck(null).ok).toBe(true);
  });
});

describe('migration', () => {
  const tree: FileTree = {
    'package.json': '{\n  "scripts": { "migrate": "prisma migrate deploy" }\n}',
    'schema.sql': 'create table a (id int);',
    Procfile: 'web: npx prisma migrate deploy && node server.js\nworker: node worker.js\n',
  };
  it('accepts a migrate flag of the binary from the line that defines the flag', () => {
    const cli = ctxOf({ 'internal/cli/cli.go': 'flag.BoolVar(&flagMigrate, "migrate", false, flagMigrateHelp)\nflag.BoolVar(&flagInfo, "info", false, "")' });
    const command = (line: number, quote: string) =>
      checkFacts(
        cli,
        factsOf({
          database: { value: 'postgres', confidence: 'high', evidence: [] },
          migration: { value: { mode: 'pre_deploy', command: '/usr/bin/app -migrate' }, confidence: 'high', evidence: cite('internal/cli/cli.go', line, quote) },
        }),
        null,
      ).find((c) => c.fact === 'migration')!;
    expect(command(1, 'flag.BoolVar(&flagMigrate, "migrate", false, flagMigrateHelp)').ok).toBe(true);
    expect(command(2, 'flag.BoolVar(&flagInfo, "info", false, "")').ok).toBe(false);
  });

  const migrationCheck = (
    migration: AnalystOutput['migration']['value'],
    database: AnalystOutput['database']['value'],
    evidence = cite('package.json', 2, 'prisma migrate deploy'),
  ) =>
    checkFacts(
      ctxOf(tree),
      factsOf({ database: { value: database, confidence: 'high', evidence: [] }, migration: { value: migration, confidence: 'high', evidence } }),
      null,
    ).find((c) => c.fact === 'migration')!;

  it('fails for mode none with a database', () => {
    const result = migrationCheck({ mode: 'none', command: null }, 'postgres');
    expect(result.ok).toBe(false);
    expect(result.reasons.join(' ')).toContain('mode none with a database needs a vendor decision');
  });

  it('passes for mode none without a database', () => {
    expect(migrationCheck({ mode: 'none', command: null }, 'none').ok).toBe(true);
  });

  it('fails for pre_deploy without a command', () => {
    const result = migrationCheck({ mode: 'pre_deploy', command: null }, 'postgres');
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('pre_deploy without a command');
  });

  it('passes for pre_deploy with a command that the cited line holds', () => {
    expect(migrationCheck({ mode: 'pre_deploy', command: 'npx prisma migrate deploy' }, 'postgres').ok).toBe(true);
  });

  it('fails for a command that the cited line does not hold', () => {
    expect(migrationCheck({ mode: 'pre_deploy', command: 'php artisan migrate --force' }, 'postgres').ok).toBe(false);
  });

  it('passes for unknown without a command, even without evidence', () => {
    expect(migrationCheck({ mode: 'unknown', command: null }, 'postgres', []).ok).toBe(true);
  });

  it('checks a startup mode without a command against a migration-like line on the start path', () => {
    expect(migrationCheck({ mode: 'startup', command: null }, 'postgres', cite('Procfile', 1, 'prisma migrate deploy')).ok).toBe(true);
    expect(migrationCheck({ mode: 'startup', command: null }, 'postgres', cite('Procfile', 2, 'node worker.js')).ok).toBe(false);
  });

  it('fails a startup mode whose evidence is off the start path (a package script, a README)', () => {
    const check = migrationCheck({ mode: 'startup', command: null }, 'postgres', cite('package.json', 2, 'prisma migrate deploy'));
    expect(check.ok).toBe(false);
    expect(check.reasons).toContain('package.json is not on the image start path');
  });
});

describe('checkFacts: the other facts', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM node:20\nCMD ["node", "dist/server.js"]\n',
    Procfile: 'web: node dist/server.js\nworker: node dist/queue-worker.js\n',
    'src/health.js': "app.get('/healthz', handler);",
    'package.json': '{ "dependencies": { "pg": "^8", "ioredis": "^5", "@aws-sdk/client-s3": "^3" } }',
  };
  const ctx = ctxOf(tree);
  const high = <T>(value: T, evidence: AnalystOutput['port']['evidence']) => ({ value, confidence: 'high' as const, evidence });
  const find = (checks: ReturnType<typeof checkFacts>, fact: string, subject: string | null = null) =>
    checks.find((c) => c.fact === fact && c.subject === subject)!;

  it('accepts "no database" only from an embedded-store line, never from a generic word such as default', () => {
    const local = ctxOf({ 'config.js': "const db = process.env.DB_DRIVER || 'default';\nconst file = 'data/app.sqlite';" });
    const none = (line: number, quote: string) => factsOf({ database: high('none' as const, cite('config.js', line, quote)) });
    expect(find(checkFacts(local, none(1, "'default'"), null), 'database').ok).toBe(false);
    expect(find(checkFacts(local, none(2, 'app.sqlite'), null), 'database').ok).toBe(true);
  });

  it('returns one check per fact, then per worker and per variable', () => {
    const checks = checkFacts(
      ctx,
      factsOf({
        workers: [{ id: 'queue', command: 'node dist/queue-worker.js', confidence: 'high', evidence: cite('Procfile', 2, 'node dist/queue-worker.js') }],
        requiredVariables: [{ name: 'API_TOKEN', confidence: 'high', evidence: cite('src/health.js', 1, 'handler') }],
      }),
      null,
    );
    expect(checks.map((c) => c.fact)).toEqual([
      'dockerfile',
      'port',
      'startCommand',
      'healthPath',
      'database',
      'redis',
      'storage',
      'migration',
      'workers',
      'requiredVariables',
    ]);
    expect(find(checks, 'workers', 'queue').ok).toBe(true);
    expect(find(checks, 'requiredVariables', 'API_TOKEN').ok).toBe(false);
  });

  it('checks start command, health path, database, redis and storage against the cited line', () => {
    const checks = checkFacts(
      ctx,
      factsOf({
        startCommand: high('node dist/server.js', cite('Dockerfile', 2, 'dist/server.js')),
        healthPath: high('/healthz', cite('src/health.js', 1, '/healthz')),
        database: high('postgres' as const, cite('package.json', 1, '"pg"')),
        redis: high(true, cite('package.json', 1, 'ioredis')),
        storage: high(true, cite('package.json', 1, '@aws-sdk/client-s3')),
      }),
      null,
    );
    for (const fact of ['startCommand', 'healthPath', 'database', 'redis', 'storage']) expect(find(checks, fact).reasons).toEqual([]);
  });

  it('fails each of them when the cited line does not support it', () => {
    const wrong = cite('Procfile', 1, 'web: node dist/server.js');
    const checks = checkFacts(
      ctx,
      factsOf({
        startCommand: high('gunicorn app:app', wrong),
        healthPath: high('/healthz', wrong),
        database: high('mysql' as const, wrong),
        redis: high(true, wrong),
        storage: high(true, wrong),
      }),
      null,
    );
    for (const fact of ['startCommand', 'healthPath', 'database', 'redis', 'storage']) expect(find(checks, fact).ok).toBe(false);
  });

  it('accepts "/" from the request pipeline of a server-rendered app, never from an unrelated line', () => {
    const site = ctxOf({ 'Server/Program.cs': 'var app = builder.Build();\napp.UseOqtane(configuration);\nvar name = "site";' });
    const root = (line: number, quote: string) => factsOf({ healthPath: high('/', cite('Server/Program.cs', line, quote)) });
    expect(find(checkFacts(site, root(2, 'app.UseOqtane(configuration);'), null), 'healthPath').ok).toBe(true);
    expect(find(checkFacts(site, root(3, 'var name = "site";'), null), 'healthPath').ok).toBe(false);
  });

  it('fails a low-confidence fact even with good evidence', () => {
    const checks = checkFacts(
      ctx,
      factsOf({ healthPath: { value: '/healthz', confidence: 'low', evidence: cite('src/health.js', 1, '/healthz') } }),
      null,
    );
    expect(find(checks, 'healthPath').reasons).toContain('low confidence');
  });

  it('fails a worker whose command is not on the cited line, and a duplicate worker id', () => {
    const worker = (id: string, command: string, line: number, quote: string) => ({ id, command, confidence: 'high' as const, evidence: cite('Procfile', line, quote) });
    const checks = checkFacts(
      ctx,
      factsOf({
        workers: [
          worker('queue', 'node dist/queue-worker.js', 2, 'queue-worker.js'),
          worker('queue', 'node dist/queue-worker.js', 2, 'queue-worker.js'),
          worker('mail', 'node dist/mailer.js', 2, 'queue-worker.js'),
        ],
      }),
      null,
    );
    const workers = checks.filter((c) => c.fact === 'workers');
    expect(workers.map((c) => c.ok)).toEqual([true, false, false]);
    expect(workers[1]!.reasons).toContain('duplicate worker id');
  });
});
