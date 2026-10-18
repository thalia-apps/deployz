import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ManifestReadinessFinding, ManifestReadinessResult } from '@deployz/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeManifest } from '../claims/test-support.js';
import { analysisResultFileSchema, recipeSchema } from '../contract.js';
import { freshApplicationGate, openAnalyser, vendorQuestionCount, type Analyser } from './analyse.js';
import { readLocalTree, serveLocalTree } from './local-tree.js';

const finding = (id: string, severity: 'error' | 'warning'): ManifestReadinessFinding => ({ id, category: 'x', severity, message: 'm' });
const error = (id: string) => finding(id, 'error');
const warning = (id: string) => finding(id, 'warning');
const gate = (state: ManifestReadinessResult['state'], ...findings: ManifestReadinessFinding[]): ManifestReadinessResult => ({ state, findings });

describe('vendorQuestionCount', () => {
  const manifest = makeManifest();

  it('is 0 for a ready application', () => {
    expect(vendorQuestionCount(manifest, gate('READY'))).toBe(0);
  });

  it('counts each gate error that needs a vendor action', () => {
    expect(vendorQuestionCount(manifest, gate('NEEDS_CONFIGURATION', error('port-missing'), error('health-path-required')))).toBe(2);
  });

  it('does not count warnings or unsupported reasons', () => {
    expect(vendorQuestionCount(manifest, gate('NOT_COMPATIBLE', error('unsupported'), warning('migration-command-missing')))).toBe(0);
  });

  it('counts one question per missing variable', () => {
    const variables = ['A', 'B', 'C'].map((key) => ({ key, required: true, secret: false, source: [], classification: 'customer_required' }));
    expect(vendorQuestionCount(makeManifest({ environment: { variables } }), gate('NEEDS_CONFIGURATION', error('required-env-vars-missing')))).toBe(3);
  });

  it('adds the manifest questions', () => {
    const questions = [{ id: 'q', field: 'queue_relationship', question: 'Which process consumes the queue?', source: 'src/queue.ts' }];
    expect(vendorQuestionCount(makeManifest({ questions }), gate('READY'))).toBe(1);
  });
});

describe('freshApplicationGate', () => {
  const variable = (key: string, classification: string) => ({ key, required: true, secret: false, source: [], classification });

  it('does not ask for a variable that Deployz manages', () => {
    const manifest = makeManifest({ environment: { variables: [variable('BASE_URL', 'deployz_managed')] } });
    expect(freshApplicationGate(manifest)).toEqual({ state: 'READY', findings: [] });
  });

  it('asks for a required customer variable', () => {
    const manifest = makeManifest({ environment: { variables: [variable('STRIPE_KEY', 'customer_required')] } });
    expect(freshApplicationGate(manifest).findings.map((entry) => entry.id)).toEqual(['required-env-vars-missing']);
  });
});

describe('local tree', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'runcheck-tree-'));
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'Dockerfile'), 'FROM scratch\n');
    writeFileSync(join(dir, 'src', 'index.js'), 'console.log(1)\n');
    writeFileSync(join(dir, 'node_modules', 'skipped.js'), 'x');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('lists the files with forward slashes and skips node_modules', () => {
    expect(readLocalTree(dir).files.map((file) => file.path)).toEqual(['Dockerfile', 'src/index.js']);
  });

  it('gives the git blob sha and a commit that changes with the content', () => {
    const before = readLocalTree(dir);
    expect(before.files[0]!.sha).toBe('c35f1b5f5e29f0e2942c58a7e82005733977ebdd');
    expect(before.commit).toMatch(/^[0-9a-f]{40}$/);
    writeFileSync(join(dir, 'src', 'index.js'), 'console.log(2)\n');
    expect(readLocalTree(dir).commit).not.toBe(before.commit);
  });

  it('serves the head, the tree and a blob like GitHub', async () => {
    const tree = readLocalTree(dir);
    const serve = serveLocalTree(tree);
    const base = 'https://api.github.com/repos/fixture/F1';
    expect(await serve(`${base}/commits/${tree.commit}`).json()).toEqual({ sha: tree.commit });
    const listing = (await serve(`${base}/git/trees/${tree.commit}?recursive=1`).json()) as { tree: { path: string; sha: string }[] };
    expect(listing.tree.map((entry) => entry.path)).toEqual(['Dockerfile', 'src/index.js']);
    const blob = (await serve(`${base}/git/blobs/${listing.tree[0]!.sha}`).json()) as { content: string };
    expect(Buffer.from(blob.content, 'base64').toString()).toBe('FROM scratch\n');
    expect(serve(`${base}/git/blobs/${'0'.repeat(40)}`).status).toBe(404);
  });
});

describe('openAnalyser on a fixture (production analysis path, no network)', () => {
  let fixtures: string;
  let analyser: Analyser;
  beforeAll(async () => {
    fixtures = mkdtempSync(join(tmpdir(), 'runcheck-fixtures-'));
    const app = join(fixtures, 'F1', 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(app, 'Dockerfile'),
      ['FROM node:20-alpine', 'WORKDIR /app', 'COPY . .', 'EXPOSE 8080', 'CMD ["node", "server.js"]', ''].join('\n'),
    );
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'f1', scripts: { start: 'node server.js' } }));
    writeFileSync(join(app, 'server.js'), "require('http').createServer((_req, res) => res.end('ok')).listen(8080);\n");
    analyser = await openAnalyser({ analyser: 'rules@test', cacheDir: join(fixtures, 'cache'), token: null, offline: true, fixturesDir: fixtures });
  });
  afterAll(async () => {
    await analyser.close();
    rmSync(fixtures, { recursive: true, force: true });
  });

  it('gives a valid Analysis result file', async () => {
    const recipe = recipeSchema.parse({ id: 'F1', set: 'fixture', source: { kind: 'fixture', fixture: 'F1' } });
    const file = analysisResultFileSchema.parse(await analyser.analyse(recipe));
    expect(file).toMatchObject({ id: 'F1', analyser: 'rules@test', status: 'analysed', failure: null });
    expect(file.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(file.manifest?.application.dockerfilePath).toBe('Dockerfile');
    expect(file.manifest?.web.port).toBe(8080);
    expect(file.gate?.state).toBeDefined();
  });
});
