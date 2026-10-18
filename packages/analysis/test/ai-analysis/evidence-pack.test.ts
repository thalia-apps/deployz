import { describe, expect, it } from 'vitest';

import { analyseRepo } from '../../src/analyser.js';
import {
  MAX_FILE_CHARS,
  MAX_PACK_CHARS,
  buildEvidencePack,
  isExcludedPath,
  renderEvidencePack,
} from '../../src/ai-analysis/evidence-pack.js';
import type { FileTree } from '../../src/detectors.js';

const baseTree: FileTree = {
  Dockerfile: 'FROM node:20\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({ name: 'a', scripts: { start: 'node dist/index.js' }, dependencies: { express: '^4' } }),
  'src/index.ts': "app.get('/health', r);\napp.listen(process.env.PORT || 3000);\n",
};

/** `note` is put in the rules metadata, so the pack sees it as a cited path. */
function pack(tree: FileTree, note?: string) {
  const rules = analyseRepo(tree);
  const analysis = note === undefined ? rules : { ...rules, metadata: { ...rules.metadata, note } };
  return buildEvidencePack(tree, analysis);
}

const paths = (p: ReturnType<typeof pack>) => p.files.map((file) => file.path);

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

  it.each(['.env.example', '.env.sample', '.env.template', '.env.dist', 'Dockerfile', 'src/index.ts', 'package.json'])(
    'keeps %s',
    (path) => {
      expect(isExcludedPath(path)).toBe(false);
    },
  );
});

describe('buildEvidencePack: excluded files', () => {
  const tree: FileTree = {
    ...baseTree,
    '.env': 'SECRET_TOKEN=realvalue\n',
    '.env.production': 'DB_PASSWORD=realvalue\n',
    'certs/server.key': 'a key file\n',
    'credentials.json': '{"a":1}',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'node_modules/dep/package.json': '{"name":"dep"}',
  };

  it('never packs secret files, real env files, lockfiles or vendored code, even when cited', () => {
    const cited = '.env .env.production certs/server.key credentials.json pnpm-lock.yaml node_modules/dep/package.json';
    const result = pack(tree, cited);
    for (const excluded of cited.split(' ')) expect(paths(result)).not.toContain(excluded);
    expect(paths(result)).toContain('Dockerfile');
    expect(paths(result)).toContain('src/index.ts');
  });

  it('does not list vendored paths in the path list', () => {
    const result = pack(tree);
    expect(result.paths).not.toContain('node_modules/dep/package.json');
    expect(result.paths).toContain('Dockerfile');
  });
});

describe('buildEvidencePack: env samples', () => {
  const tree: FileTree = {
    ...baseTree,
    '.env.example': ['# settings', 'DATABASE_URL=postgres://user:pw@host/db', '', 'export API_HOST=example.com', 'LABEL: some value'].join('\n'),
  };

  it('strips values but keeps names and line numbers', () => {
    const file = pack(tree).files.find((item) => item.path === '.env.example')!;
    expect(file.lines).toEqual(['# settings', 'DATABASE_URL=', '', 'export API_HOST=', 'LABEL:']);
    expect(file.lines.join('\n')).not.toContain('pw');
    expect(file.lines.join('\n')).not.toContain('example.com');
  });
});

describe('buildEvidencePack: redaction and private keys', () => {
  it('redacts secrets line by line and keeps the other lines intact', () => {
    const tree: FileTree = {
      ...baseTree,
      'requirements.txt': [
        'const a = 1;',
        'const url = "postgres://admin:hunter2@db/app";',
        'const key = "AKIAABCDEFGHIJKLMNOP";',
        'listen(3000);',
      ].join('\n'),
    };
    const file = pack(tree).files.find((item) => item.path === 'requirements.txt')!;
    expect(file.lines).toHaveLength(4);
    expect(file.lines[0]).toBe('const a = 1;');
    expect(file.lines[1]).toContain('[REDACTED]@db');
    expect(file.lines[1]).not.toContain('hunter2');
    expect(file.lines[2]).toContain('[REDACTED_AWS_KEY]');
    expect(file.lines[3]).toBe('listen(3000);');
  });

  it('skips a whole file that holds a PEM private key', () => {
    const tree: FileTree = {
      ...baseTree,
      Procfile: 'web: node server.js\n# -----BEGIN RSA PRIVATE KEY-----\n# abc\n# -----END RSA PRIVATE KEY-----\n',
    };
    expect(paths(pack(tree))).not.toContain('Procfile');
  });
});

describe('buildEvidencePack: size limits', () => {
  it('keeps the first lines of a long file and marks it truncated', () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`);
    const tree: FileTree = { ...baseTree, 'requirements.txt': lines.join('\n') };
    const file = pack(tree).files.find((item) => item.path === 'requirements.txt')!;
    expect(file.truncated).toBe(true);
    expect(file.lines.length).toBeLessThan(5000);
    expect(file.lines[0]).toBe('line 1');
    expect(file.lines.reduce((sum, line) => sum + line.length + 1, 0)).toBeLessThanOrEqual(MAX_FILE_CHARS);
  });

  it('cuts a single long line to 400 characters', () => {
    const tree: FileTree = { ...baseTree, 'requirements.txt': 'x'.repeat(2000) };
    const file = pack(tree).files.find((item) => item.path === 'requirements.txt')!;
    expect(file.lines[0]).toHaveLength(400);
  });

  it('keeps the whole pack inside MAX_PACK_CHARS', () => {
    const tree: FileTree = { ...baseTree };
    const big = Array.from({ length: 3000 }, (_, i) => `entry-${i}`).join('\n');
    for (let i = 0; i < 20; i++) tree[`svc${i}/requirements.txt`] = big;
    const result = pack(tree);
    const total = result.files.reduce((sum, file) => sum + file.lines.reduce((s, line) => s + line.length + 1, 0), 0);
    expect(total).toBeLessThanOrEqual(MAX_PACK_CHARS);
    expect(result.files.length).toBeLessThan(21);
    expect(paths(result)).toContain('Dockerfile');
  });

  it('caps the path list and reports the total', () => {
    const tree: FileTree = { ...baseTree };
    for (let i = 0; i < 450; i++) tree[`docs/page-${i}.md`] = 'x';
    const result = pack(tree);
    expect(result.paths).toHaveLength(400);
    expect(result.totalPaths).toBeGreaterThanOrEqual(450);
  });
});

describe('renderEvidencePack', () => {
  it('numbers every line as in the repository', () => {
    const rendered = renderEvidencePack(pack(baseTree));
    expect(rendered).toContain('<<<FILE Dockerfile');
    expect(rendered).toContain('1| FROM node:20');
    expect(rendered).toContain('2| EXPOSE 3000');
    expect(rendered).toContain('<<<FILE src/index.ts');
    expect(rendered).toContain('2| app.listen(process.env.PORT || 3000);');
    expect(rendered).toContain('FILE>>>');
  });

  it('marks a truncated file', () => {
    const tree: FileTree = { ...baseTree, 'requirements.txt': Array.from({ length: 5000 }, (_, i) => `l${i}`).join('\n') };
    expect(renderEvidencePack(pack(tree))).toContain('<<<FILE requirements.txt (first lines only)');
  });
});
