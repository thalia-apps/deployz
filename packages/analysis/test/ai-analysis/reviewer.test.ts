import { describe, expect, it } from 'vitest';

import type { AnalystOutput } from '../../src/ai-analysis/analyst.js';
import type { CheckContext } from '../../src/ai-analysis/checks.js';
import { resolveObjections, type Objection } from '../../src/ai-analysis/reviewer.js';
import type { FileTree } from '../../src/detectors.js';
import { cite, factsOf, packOf } from './helpers.js';

const tree: FileTree = {
  Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/server.js"]',
  'src/server.js': ['server.listen(3000);', 'const t = process.env.API_TOKEN;', 'const m = process.env.MAIL_KEY || "x";'].join('\n'),
  Procfile: 'web: node dist/server.js\nworker: node dist/queue-worker.js',
};
const ctx: CheckContext = { tree, pack: packOf(tree) };

const objection = (patch: Partial<Objection> & Pick<Objection, 'fact'>): Objection => ({
  subject: null,
  reason: 'the reviewer disagrees',
  proposedValue: null,
  evidence: [],
  ...patch,
});

const wrongPort = factsOf({ port: { value: 8080, confidence: 'high', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') } });

describe('resolveObjections: replacements', () => {
  it('confirms a proposal that passes the checks and replaces the fact', () => {
    const result = resolveObjections(
      ctx,
      wrongPort,
      [objection({ fact: 'port', proposedValue: '3000', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') })],
      'Dockerfile',
    );
    expect(result.facts.port.value).toBe(3000);
    expect(result.facts.port.confidence).toBe('high');
    expect(result.questions).toEqual([]);
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed']);
  });

  it('does not change the input facts', () => {
    resolveObjections(ctx, wrongPort, [objection({ fact: 'port', proposedValue: '3000', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') })], 'Dockerfile');
    expect(wrongPort.port.value).toBe(8080);
  });

  it('makes a question of a proposal whose evidence does not support it', () => {
    const result = resolveObjections(
      ctx,
      wrongPort,
      [objection({ fact: 'port', proposedValue: '9999', evidence: cite('Dockerfile', 2, 'EXPOSE 3000'), reason: 'looks like 9999' })],
      'Dockerfile',
    );
    expect(result.facts.port.value).toBe(8080);
    expect(result.questions).toEqual([{ fact: 'port', subject: null, reason: 'looks like 9999' }]);
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['question']);
  });

  it('reads a plain-text proposal, without JSON quotes', () => {
    const facts = factsOf({ healthPath: { value: '/status', confidence: 'high', evidence: cite('src/server.js', 1, 'server.listen') } });
    const health: FileTree = { ...tree, 'src/health.js': "app.get('/healthz', ok);" };
    const result = resolveObjections(
      { tree: health, pack: packOf(health) },
      facts,
      [objection({ fact: 'healthPath', proposedValue: '/healthz', evidence: cite('src/health.js', 1, "'/healthz'") })],
      'Dockerfile',
    );
    expect(result.facts.healthPath.value).toBe('/healthz');
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed']);
  });

  it('makes a question of a proposal that is not a value of the fact', () => {
    const result = resolveObjections(
      ctx,
      wrongPort,
      [objection({ fact: 'port', proposedValue: 'port three thousand', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') })],
      'Dockerfile',
    );
    expect(result.facts.port.value).toBe(8080);
    expect(result.questions).toHaveLength(1);
  });

  it('makes a question of a proposal that does not fit the fact schema', () => {
    const result = resolveObjections(
      ctx,
      wrongPort,
      [objection({ fact: 'port', proposedValue: '"3000"', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') })],
      'Dockerfile',
    );
    expect(result.facts.port.value).toBe(8080);
    expect(result.questions).toHaveLength(1);
  });

  it('makes a question of a proposal without evidence', () => {
    const result = resolveObjections(ctx, wrongPort, [objection({ fact: 'port', proposedValue: '3000', evidence: [] })], 'Dockerfile');
    expect(result.facts.port.value).toBe(8080);
    expect(result.questions).toHaveLength(1);
    expect(result.outcomes[0]!.outcome).toBe('question');
  });

  it('applies confirmed objections one after the other', () => {
    const facts = factsOf({
      port: { value: 8080, confidence: 'high', evidence: [] },
      healthPath: { value: '/old', confidence: 'high', evidence: [] },
    });
    const result = resolveObjections(
      ctx,
      facts,
      [
        objection({ fact: 'port', proposedValue: '3000', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') }),
        objection({ fact: 'healthPath', proposedValue: '"/healthz"', evidence: cite('Dockerfile', 2, 'EXPOSE 3000') }),
      ],
      'Dockerfile',
    );
    expect(result.facts.port.value).toBe(3000);
    expect(result.facts.healthPath.value).toBe('/old');
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed', 'question']);
    expect(result.questions.map((item) => item.fact)).toEqual(['healthPath']);
  });

  it('confirms a migration proposal that passes (mode none without a database)', () => {
    const result = resolveObjections(
      ctx,
      factsOf(),
      [objection({ fact: 'migration', proposedValue: '{"mode":"none","command":null}' })],
      null,
    );
    expect(result.facts.migration.value).toEqual({ mode: 'none', command: null });
    expect(result.questions).toEqual([]);
  });

  it('makes a question of a migration proposal that fails (mode none with a database)', () => {
    const facts = factsOf({ database: { value: 'postgres', confidence: 'high', evidence: [] } });
    const result = resolveObjections(ctx, facts, [objection({ fact: 'migration', proposedValue: '{"mode":"none","command":null}' })], null);
    expect(result.facts.migration.value).toEqual({ mode: 'unknown', command: null });
    expect(result.questions.map((item) => item.fact)).toEqual(['migration']);
  });
});

describe('resolveObjections: workers and variables', () => {
  const worker = (id: string, command: string, quote: string, line = 2) => ({ id, command, confidence: 'high' as const, evidence: cite('Procfile', line, quote) });
  const variable = (name: string, line: number, quote: string) => ({ name, confidence: 'high' as const, evidence: cite('src/server.js', line, quote) });

  it('confirms the removal of a worker only when the analyst item fails its check', () => {
    const facts = factsOf({ workers: [worker('ghost', 'node dist/ghost.js', 'queue-worker.js')] });
    const result = resolveObjections(ctx, facts, [objection({ fact: 'workers', subject: 'ghost', proposedValue: null })], null);
    expect(result.facts.workers).toEqual([]);
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed']);
  });

  it('keeps a worker that passes its check and makes a question of the removal', () => {
    const facts = factsOf({ workers: [worker('queue', 'node dist/queue-worker.js', 'queue-worker.js')] });
    const result = resolveObjections(ctx, facts, [objection({ fact: 'workers', subject: 'queue', proposedValue: null, reason: 'not a worker' })], null);
    expect(result.facts.workers).toHaveLength(1);
    expect(result.questions).toEqual([{ fact: 'workers', subject: 'queue', reason: 'not a worker' }]);
  });

  it('confirms a corrected worker command that passes', () => {
    const facts = factsOf({ workers: [worker('queue', 'node dist/other.js', 'queue-worker.js')] });
    const result = resolveObjections(
      ctx,
      facts,
      [objection({ fact: 'workers', subject: 'queue', proposedValue: '"node dist/queue-worker.js"', evidence: cite('Procfile', 2, 'queue-worker.js') })],
      null,
    );
    expect(result.facts.workers).toHaveLength(1);
    expect(result.facts.workers[0]!.command).toBe('node dist/queue-worker.js');
  });

  it('confirms the removal of a required variable only when the analyst item fails its check', () => {
    const facts = factsOf({ requiredVariables: [variable('API_TOKEN', 2, 'process.env.API_TOKEN'), variable('MAIL_KEY', 3, 'process.env.MAIL_KEY')] });
    const result = resolveObjections(
      ctx,
      facts,
      [
        objection({ fact: 'requiredVariables', subject: 'MAIL_KEY', proposedValue: null }),
        objection({ fact: 'requiredVariables', subject: 'API_TOKEN', proposedValue: null }),
      ],
      null,
    );
    expect(result.facts.requiredVariables.map((item) => item.name)).toEqual(['API_TOKEN']);
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed', 'question']);
    expect(result.questions).toEqual([{ fact: 'requiredVariables', subject: 'API_TOKEN', reason: 'the reviewer disagrees' }]);
  });

  it('adds a missing required variable when the proposal passes', () => {
    const result = resolveObjections(
      ctx,
      factsOf(),
      [objection({ fact: 'requiredVariables', proposedValue: '"API_TOKEN"', evidence: cite('src/server.js', 2, 'process.env.API_TOKEN') })],
      null,
    );
    expect(result.facts.requiredVariables.map((item) => item.name)).toEqual(['API_TOKEN']);
    expect(result.outcomes.map((item) => item.outcome)).toEqual(['confirmed']);
  });

  it('makes a question of a missing variable that the evidence reads with a default', () => {
    const result = resolveObjections(
      ctx,
      factsOf(),
      [objection({ fact: 'requiredVariables', proposedValue: '"MAIL_KEY"', evidence: cite('src/server.js', 3, 'process.env.MAIL_KEY') })],
      null,
    );
    expect(result.facts.requiredVariables).toEqual([]);
    expect(result.questions).toEqual([{ fact: 'requiredVariables', subject: 'MAIL_KEY', reason: 'the reviewer disagrees' }]);
  });
});

describe('resolveObjections: no objections', () => {
  it('returns the facts unchanged', () => {
    const facts: AnalystOutput = factsOf();
    const result = resolveObjections(ctx, facts, [], null);
    expect(result.facts).toBe(facts);
    expect(result.questions).toEqual([]);
    expect(result.outcomes).toEqual([]);
  });
});
