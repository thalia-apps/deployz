import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import {
  MAX_LISTED_PATHS,
  MAX_PACK_CHARS,
  MAX_QUESTION_CHARS,
  bindingContractOf,
  buildEvidencePack,
  evidenceFileRequests,
  isExcludedPath,
  packFiles,
  renderEvidencePack,
} from '../../src/ai-analysis/evidence-pack.js';
import { TREE_PATHS, type FileTree } from '../../src/detectors.js';
import { ELIXIR_SOURCES, elixirPostgres, MONGO_OR_POSTGRES } from './helpers.js';

const pack = (tree: FileTree) => buildEvidencePack(tree, analyseRepo(tree));
const windowOf = (tree: FileTree, path: string) => packFiles(pack(tree)).find((file) => file.path === path);

describe('isExcludedPath', () => {
  it.each([
    '.env',
    '.env.production',
    'apps/web/.env.local',
    'certs/server.pem',
    'certs/server.key',
    'id_rsa',
    '.npmrc',
    '.pypirc',
    'credentials',
    'credentials.json',
    'pnpm-lock.yaml',
    'sub/package-lock.json',
    'Gemfile.lock',
    'go.sum',
    'node_modules/x/index.js',
    'vendor/lib/a.php',
    'dist/app.js',
  ])('excludes %s', (path) => {
    expect(isExcludedPath(path)).toBe(true);
  });

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', 'Dockerfile', 'src/index.ts', 'package.json'])('keeps %s', (path) => {
    expect(isExcludedPath(path)).toBe(false);
  });
});

describe('buildEvidencePack: questions', () => {
  it('has no question when the rules resolved everything', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "src/index.js"]',
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
      'src/index.js': "app.get('/health', r);\napp.listen(process.env.PORT || 3000);",
    };
    expect(pack(tree).questions).toEqual([]);
  });

  it('gives a blocker question the windows around its search hits, with the repository line numbers', () => {
    const question = pack(MONGO_OR_POSTGRES).questions[0]!;
    expect(question).toMatchObject({ id: 'q1', kind: 'blocker', category: 'datastore', dependency: 'mongoose' });
    const db = question.windows.find((file) => file.path === 'src/db.js')!;
    expect(db.start).toBe(1);
    expect(db.lines[0]).toBe("const type = process.env.DB_TYPE || 'mongodb';");
  });

  it('never searches tests, examples or excluded files', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES, 'test/db.test.js': "require('mongoose');", '.env': 'MONGO_URL=mongodb://u:p@h/db' };
    const paths = pack(tree).questions[0]!.windows.map((file) => file.path);
    expect(paths).not.toContain('test/db.test.js');
    expect(paths).not.toContain('.env');
  });

  it('shows the selected Dockerfile and the scripts it starts once, as the start path', () => {
    const result = pack(MONGO_OR_POSTGRES);
    expect(result.startPath.map((file) => file.path)).toEqual(['Dockerfile', 'src/index.js']);
    expect(result.questions.flatMap((question) => question.windows).map((file) => file.path)).not.toContain('Dockerfile');
  });
});

describe('buildEvidencePack: redaction and size', () => {
  it('redacts secrets line by line and strips env sample values', () => {
    const tree: FileTree = {
      ...MONGO_OR_POSTGRES,
      'src/db.js': `${MONGO_OR_POSTGRES['src/db.js']}\nconst url = "mongodb://admin:hunter2@db/app";`,
      '.env.example': 'DB_TYPE=mongodb\nMONGO_URL=mongodb://user:pw@host/db',
    };
    const db = windowOf(tree, 'src/db.js')!;
    expect(db.lines.join('\n')).not.toContain('hunter2');
    const sample = windowOf(tree, '.env.example')!;
    expect(sample.lines).toEqual(['DB_TYPE=', 'MONGO_URL=']);
  });

  it('skips a file that holds a PEM private key', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES, 'src/keys.js': "// mongoose\n// -----BEGIN RSA PRIVATE KEY-----\n// abc" };
    expect(windowOf(tree, 'src/keys.js')).toBeUndefined();
  });

  it('keeps each question inside MAX_QUESTION_CHARS and the pack inside MAX_PACK_CHARS', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES };
    const big = Array.from({ length: 200 }, (_, i) => `const mongoose${i} = require('mongoose'); // ${'x'.repeat(200)}`).join('\n');
    for (let i = 0; i < 20; i++) tree[`src/m${i}.js`] = big;
    // The rules of the small tree: the rules are slow on this much code, and the pack only reads the files.
    const result = buildEvidencePack(tree, analyseRepo(MONGO_OR_POSTGRES));
    const chars = (files: readonly { lines: readonly string[] }[]) => files.reduce((sum, file) => sum + file.lines.reduce((s, line) => s + line.length + 1, 0), 0);
    for (const question of result.questions) expect(chars(question.windows)).toBeLessThanOrEqual(MAX_QUESTION_CHARS);
    expect(chars(packFiles(result))).toBeLessThanOrEqual(MAX_PACK_CHARS);
  });

  it('caps the path list and reports the total', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES };
    for (let i = 0; i < MAX_LISTED_PATHS + 10; i++) tree[`docs/page-${i}.md`] = 'x';
    const result = pack(tree);
    expect(result.paths).toHaveLength(MAX_LISTED_PATHS);
    expect(result.totalPaths).toBeGreaterThan(MAX_LISTED_PATHS);
  });
});

describe('renderEvidencePack', () => {
  it('numbers every window line as in the repository and names each question', () => {
    const tree: FileTree = { ...MONGO_OR_POSTGRES, 'src/db.js': `${'\n'.repeat(29)}${MONGO_OR_POSTGRES['src/db.js']}` };
    const rendered = renderEvidencePack(pack(tree));
    expect(rendered).toContain('## Question q1 (kind "blocker", datastore)');
    expect(rendered).toContain("30| const type = process.env.DB_TYPE || 'mongodb';");
    expect(rendered.indexOf('## Deployz binding contract')).toBeLessThan(rendered.indexOf('## Question q1'));
  });
});

describe('the Deployz binding contract', () => {
  it('lists what Deployz sets always, for this repository, and for each resource it can add', () => {
    const tree: FileTree = {
      Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/index.js"]',
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4', pg: '^8' } }),
      'src/index.ts': 'const db = new Pool({ connectionString: process.env.DATABASE_URL });\nconst s = process.env.SESSION_SECRET;\napp.listen(process.env.PORT);',
    };
    const contract = bindingContractOf(analyseRepo(tree));
    expect(contract.always).toEqual(['PORT', 'HOSTNAME']);
    expect(contract.forThisRepository).toContain('DATABASE_URL');
    expect(contract.forThisRepository).toContain('SESSION_SECRET');
    expect(contract.whenDatabase).toContain('DATABASE_PASSWORD');
    expect(contract.whenRedis).toEqual(expect.arrayContaining(['REDIS_URL', 'REDIS_HOST', 'REDIS_PORT']));
    expect(contract.whenStorage).toContain('S3_BUCKET');
  });
});

describe('evidenceFileRequests', () => {
  it('asks for the boot code and the named files the rules tree does not hold, never a numbered migration, a test or a browser file', () => {
    const tree = elixirPostgres();
    expect(evidenceFileRequests(tree, analyseRepo(tree)).sort()).toEqual(Object.keys(ELIXIR_SOURCES).sort());
  });

  it('asks for nothing without an open item or without the repository path list', () => {
    const resolved: FileTree = {
      Dockerfile: 'FROM node:20\nCOPY . .\nEXPOSE 3000\nCMD ["node", "src/index.js"]',
      'package.json': JSON.stringify({ name: 'a', dependencies: { express: '^4' } }),
      'src/index.js': "app.get('/health', r);\napp.listen(process.env.PORT || 3000);",
    };
    Object.defineProperty(resolved, TREE_PATHS, { value: [...Object.keys(resolved), 'src/main.go'], enumerable: false });
    expect(evidenceFileRequests(resolved, analyseRepo(resolved))).toEqual([]);
    const { ...withoutPaths } = elixirPostgres();
    expect(evidenceFileRequests(withoutPaths, analyseRepo(withoutPaths))).toEqual([]);
  });

  it('shows the fetched files in the windows, the call that runs the migrations before a comment', () => {
    const tree = elixirPostgres();
    const withSources = { ...tree, ...ELIXIR_SOURCES };
    const questions = buildEvidencePack(withSources, analyseRepo(tree)).questions;
    expect(questions.map((question) => (question.kind === 'fact' ? question.fact : question.category))).toEqual(['migration', 'databaseVariable']);
    const [migration, variable] = questions;
    expect(migration!.windows[0]).toMatchObject({ path: 'lib/app/application.ex' });
    expect(migration!.windows[0]!.lines.join('\n')).toContain('App.ReleaseTasks.migrate()');
    expect(variable!.windows.map((file) => file.path)).toContain('config/runtime.exs');
  });
});
