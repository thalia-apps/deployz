import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import { checkBlocker, checkFact, citedLine, imageCommand, isImageStartCommand, type CheckContext } from '../../src/ai-analysis/checks.js';
import { buildEvidencePack, type Question } from '../../src/ai-analysis/evidence-pack.js';
import type { BlockerItem } from '../../src/ai-analysis/open-items.js';
import type { FileTree } from '../../src/detectors.js';
import { blocker, cite, fact, MONGO_DECLARED_ONLY, MONGO_OR_POSTGRES } from './helpers.js';

function contextOf(tree: FileTree): CheckContext {
  return { pack: buildEvidencePack(tree, analyseRepo(tree)), tree, dockerfile: 'Dockerfile', database: 'none' };
}

const blockerOf = (ctx: CheckContext) => ctx.pack.questions.find((question) => question.kind === 'blocker') as Question & BlockerItem;

describe('citedLine', () => {
  const ctx = contextOf({ ...MONGO_OR_POSTGRES, 'src/db.js': `\n\n${MONGO_OR_POSTGRES['src/db.js']}` });

  it('finds the line in a window that does not start at line 1, with one line of tolerance', () => {
    expect(citedLine(ctx.pack, { path: 'src/db.js', line: 3, quote: 'process.env.DB_TYPE' })).toContain('DB_TYPE');
    expect(citedLine(ctx.pack, { path: 'src/db.js', line: 4, quote: 'process.env.DB_TYPE' })).toContain('DB_TYPE');
    expect(citedLine(ctx.pack, { path: 'src/db.js', line: 3, quote: 'not there' })).toBeNull();
    expect(citedLine(ctx.pack, { path: 'src/other.js', line: 1, quote: 'x' })).toBeNull();
  });
});

describe('checkBlocker: optional by setting', () => {
  const ctx = contextOf(MONGO_OR_POSTGRES);
  const question = blockerOf(ctx);
  const evidence = [...cite('src/db.js', 1, 'process.env.DB_TYPE'), ...cite('src/db.js', 2, "type === 'postgres'")];
  const answer = (overrides = {}) => blocker('q1', 'optional_by_setting', { setting: 'DB_TYPE', settingValue: 'postgres', engine: 'postgres', evidence, ...overrides });

  it('passes when a cited line reads the setting and the value selects PostgreSQL', () => {
    expect(checkBlocker(ctx, question, answer())).toEqual({ id: 'q1', ok: true, reasons: [] });
  });

  it('fails without a cited read of the setting', () => {
    expect(checkBlocker(ctx, question, answer({ evidence: cite('src/db.js', 2, "type === 'postgres'") })).reasons).toContain('no cited line reads DB_TYPE');
  });

  it('fails when the value does not select the engine', () => {
    const check = checkBlocker(ctx, question, answer({ settingValue: 'sql', evidence: cite('src/db.js', 1, 'process.env.DB_TYPE') }));
    expect(check.reasons).toContain('no cited line shows that DB_TYPE=sql selects postgres');
  });

  it('does not read MinIO as S3', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES, 'src/files.js': "const type = process.env.STORAGE_TYPE || 'local';" };
    const local = contextOf(tree);
    const question: Question & BlockerItem = { id: 'q1', kind: 'blocker', category: 'local_state', dependency: 'local-filesystem', reason: 'x', terms: ['STORAGE'], windows: [] };
    const minio = blocker('q1', 'optional_by_setting', { setting: 'STORAGE_TYPE', settingValue: 'minio', engine: 's3', evidence: cite('src/files.js', 1, 'process.env.STORAGE_TYPE') });
    expect(checkBlocker(local, question, minio).reasons).toContain('no cited line shows that STORAGE_TYPE=minio selects s3');
  });

  it('fails for an engine that does not replace a datastore, a low confidence or a missing setting', () => {
    expect(checkBlocker(ctx, question, answer({ engine: 'redis', settingValue: 'redis' })).ok).toBe(false);
    expect(checkBlocker(ctx, question, answer({ confidence: 'low' })).reasons).toContain('low confidence');
    expect(checkBlocker(ctx, question, answer({ setting: null })).ok).toBe(false);
  });

  it('always accepts "required": it changes nothing', () => {
    expect(checkBlocker(ctx, question, blocker('q1', 'required')).ok).toBe(true);
  });
});

describe('checkBlocker: not used', () => {
  it('passes when no production file imports the datastore', () => {
    const ctx = contextOf(MONGO_DECLARED_ONLY);
    const check = checkBlocker(ctx, blockerOf(ctx), blocker('q1', 'not_used', { evidence: cite('src/index.js', 1, "require('express')") }));
    expect(check).toEqual({ id: 'q1', ok: true, reasons: [] });
  });

  it('fails when a production file imports it, and ignores tests', () => {
    const ctx = contextOf(MONGO_OR_POSTGRES);
    const answer = blocker('q1', 'not_used', { evidence: cite('src/index.js', 1, "require('express')") });
    expect(checkBlocker(ctx, blockerOf(ctx), answer).reasons).toEqual([expect.stringMatching(/^src\/(?:db|models\/user)\.js:\d+ imports or connects to it$/)]);
    const testOnly = contextOf({ ...MONGO_DECLARED_ONLY, 'test/setup.js': "require('mongoose');" });
    expect(checkBlocker(testOnly, blockerOf(testOnly), answer).ok).toBe(true);
  });

  it('local state: fails when the code reads the declared variable or path', () => {
    const tree: FileTree = { Dockerfile: 'FROM node:20\nENV DATA_DIR=/data\nCMD ["node", "index.js"]', 'index.js': 'app.listen(3000);' };
    const question: Question & BlockerItem = {
      id: 'q1',
      kind: 'blocker',
      category: 'local_state',
      dependency: 'local-filesystem',
      reason: 'durable local state (DATA_DIR=/data (Dockerfile))',
      terms: ['DATA_DIR', '/data', 'STORAGE'],
      windows: [],
    };
    const answer = blocker('q1', 'not_used', { evidence: cite('Dockerfile', 2, 'ENV DATA_DIR=/data') });
    expect(checkBlocker(contextOf(tree), question, answer).ok).toBe(true);
    const reads = { ...tree, 'index.js': 'fs.writeFileSync(`${process.env.DATA_DIR}/db.json`, x);' };
    expect(checkBlocker(contextOf(reads), question, answer).reasons).toEqual(['index.js:1 uses the declared path or variable']);
  });

  it('a second Compose service: only a third-party image that no production line names', () => {
    const compose = ['services:', '  web:', '    build: .', '  search:', '    image: getmeili/meilisearch:v1', ''].join('\n');
    const tree: FileTree = { Dockerfile: 'FROM node:20\nCMD ["node", "index.js"]', 'docker-compose.yml': compose, 'index.js': 'app.listen(3000);' };
    const question: Question & BlockerItem = {
      id: 'q1',
      kind: 'blocker',
      category: 'compose_service',
      dependency: 'docker-compose-multi-service',
      reason: 'defines 2 application services (web, search)',
      terms: ['web', 'search'],
      windows: [],
    };
    const answer = blocker('q1', 'not_used', { evidence: cite('Dockerfile', 2, 'CMD') });
    expect(checkBlocker(contextOf(tree), question, answer).ok).toBe(true);
    const named = { ...tree, 'index.js': 'const url = process.env.SEARCH_URL;' };
    expect(checkBlocker(contextOf(named), question, answer).reasons).toEqual(['index.js:1 names the service search']);
    const built = { ...tree, 'docker-compose.yml': compose.replace('image: getmeili/meilisearch:v1', 'build: ./search') };
    expect(checkBlocker(contextOf(built), question, answer).ok).toBe(false);
  });
});

describe('the image start command', () => {
  it('reads the final stage CMD and ENTRYPOINT in both forms', () => {
    expect(imageCommand('FROM a AS b\nCMD ["x"]\nFROM c\nENTRYPOINT ["tini", "--"]\nCMD node server.js')).toEqual({ entrypoint: 'tini --', cmd: 'node server.js' });
  });

  it('accepts the CMD, the ENTRYPOINT with the CMD, a package script the CMD runs, and a script file it starts', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:20\nENTRYPOINT ["tini", "--"]\nCMD ["yarn", "start-docker"]',
      'package.json': JSON.stringify({ scripts: { 'start-docker': 'sh scripts/start-docker.sh' } }),
      'scripts/start-docker.sh': 'node server.js',
    };
    expect(isImageStartCommand(tree, 'Dockerfile', 'yarn start-docker')).toBe(true);
    expect(isImageStartCommand(tree, 'Dockerfile', 'tini -- yarn start-docker')).toBe(true);
    expect(isImageStartCommand(tree, 'Dockerfile', 'sh scripts/start-docker.sh')).toBe(true);
    expect(isImageStartCommand(tree, 'Dockerfile', 'node other.js')).toBe(false);
    const script: FileTree = { Dockerfile: 'FROM alpine\nCOPY docker-entrypoint.sh /\nCMD ["/docker-entrypoint.sh"]', 'docker-entrypoint.sh': 'exec app' };
    expect(isImageStartCommand(script, 'Dockerfile', 'sh docker-entrypoint.sh')).toBe(true);
  });
});

describe('checkFact', () => {
  const tree: FileTree = {
    Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "src/index.js"]',
    'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
    'src/index.js': "const app = require('express')();\napp.get('/status', (req, res) => res.send('ok'));\napp.listen(3000);",
  };
  const ctx = contextOf(tree);
  const health: Question = { id: 'q7', kind: 'fact', fact: 'healthPath', windows: [] };

  it('passes a health path that a cited route registers', () => {
    expect(checkFact(ctx, health, fact(health.id, '/status', { evidence: cite('src/index.js', 2, "app.get('/status'") })).ok).toBe(true);
  });

  it('fails a path the cited line does not register, a low confidence and a value of the wrong shape', () => {
    expect(checkFact(ctx, health, fact(health.id, '/healthz', { evidence: cite('src/index.js', 2, "app.get('/status'") })).ok).toBe(false);
    expect(checkFact(ctx, health, fact(health.id, '/status', { confidence: 'low', evidence: cite('src/index.js', 2, "app.get('/status'") })).ok).toBe(false);
    expect(checkFact(ctx, health, fact(health.id, 'status')).reasons).toEqual(['status is not a valid healthPath']);
  });

  it('accepts "unknown": it changes nothing', () => {
    expect(checkFact(ctx, health, fact(health.id, null)).ok).toBe(true);
  });

  it('port: refuses a port that the Dockerfile contradicts when the app does not read PORT', () => {
    const portQuestion: Question = { id: 'q9', kind: 'fact', fact: 'port', windows: [] };
    expect(checkFact(ctx, portQuestion, fact('q9', '8080', { evidence: cite('Dockerfile', 3, 'CMD') })).ok).toBe(false);
    expect(checkFact(ctx, portQuestion, fact('q9', '3000', { evidence: cite('Dockerfile', 2, 'EXPOSE 3000') })).ok).toBe(true);
  });

  it('startCommand: accepts only the image command, never a description', () => {
    const start: Question = { id: 'q6', kind: 'fact', fact: 'startCommand', windows: [] };
    expect(checkFact(ctx, start, fact('q6', 'node src/index.js')).ok).toBe(true);
    expect(checkFact(ctx, start, fact('q6', 'The image runs node src/index.js', { evidence: cite('Dockerfile', 3, 'src/index.js') })).ok).toBe(false);
  });

  it('migration: a startup migration is cited on the start path or in boot code, never in a manifest', () => {
    const migration: Question = { id: 'q8', kind: 'fact', fact: 'migration', windows: [] };
    const startup = JSON.stringify({ mode: 'startup', command: null });
    const boot = contextOf({ ...tree, 'src/boot.js': 'await db.migrate.latest();' });
    const db = { ...boot, pack: { ...boot.pack, startPath: [...boot.pack.startPath, { path: 'src/boot.js', start: 1, lines: ['await db.migrate.latest();'] }] }, database: 'postgres' as const };
    expect(checkFact(db, migration, fact('q8', startup, { evidence: cite('src/boot.js', 1, 'db.migrate.latest()') })).ok).toBe(true);
    expect(checkFact(db, migration, fact('q8', startup, { evidence: cite('package.json', 1, 'express') })).ok).toBe(false);
    expect(checkFact(db, migration, fact('q8', JSON.stringify({ mode: 'none', command: null }))).reasons).toEqual(['mode none with a database needs a vendor decision']);
  });
});
