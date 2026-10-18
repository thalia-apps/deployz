import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openAnalysisSession, type AnalysisSession, type RawAnalysis } from './session.js';
import { createSnapshotFetch } from './snapshot.js';

const SHA = 'a'.repeat(40);

/** A snapshot fetch serving a fixed file tree — the same shape GitHub returns, no network. */
function inMemorySnapshot(files: Record<string, string>): typeof fetch {
  const paths = Object.keys(files);
  return (async (url: string) => {
    if (url.includes('/git/trees/')) {
      return new Response(
        JSON.stringify({
          tree: paths.map((path, index) => ({ path, type: 'blob', sha: `blob-${index}`, size: files[path]!.length })),
          truncated: false,
        }),
        { status: 200 },
      );
    }
    const index = Number(url.split('/').pop()!.replace('blob-', ''));
    const content = files[paths[index]!]!;
    return new Response(JSON.stringify({ content: Buffer.from(content).toString('base64'), encoding: 'base64' }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
}

const EXPRESS_POSTGRES_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm ci\nEXPOSE 3000\nCMD ["node", "dist/index.js"]\n',
  'package.json': JSON.stringify({
    name: 'acme-api',
    scripts: { start: 'node dist/index.js', build: 'tsc', 'db:migrate': 'prisma migrate deploy' },
    dependencies: { express: '^4.19.0', pg: '^8.12.0', '@prisma/client': '^5.0.0', prisma: '^5.0.0' },
  }),
  'prisma/schema.prisma': 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  '.env.example': 'PORT=3000\nDATABASE_URL=postgresql://localhost:5432/app\n',
  'src/index.ts': [
    "import express from 'express';",
    'const app = express();',
    "app.get('/healthz', (_req, res) => res.json({ ok: true }));",
    'app.listen(process.env.PORT || 3000);',
  ].join('\n'),
  'package-lock.json': '{}',
};

const SQLITE_APP: Record<string, string> = {
  Dockerfile: 'FROM node:20-alpine\nCMD ["node", "server.js"]\n',
  'package.json': JSON.stringify({
    name: 'notes',
    scripts: { start: 'node server.js' },
    dependencies: { express: '^4.19.0', 'better-sqlite3': '^11.0.0' },
  }),
  'server.js': "const express = require('express');\nconst app = express();\napp.get('/health', (q, r) => r.send('ok'));\napp.listen(process.env.PORT || 8080);\n",
};

describe('production analysis path over a snapshot', () => {
  let cacheDir: string;
  let session: AnalysisSession;
  let sqliteSession: AnalysisSession;
  let express: RawAnalysis;
  let sqlite: RawAnalysis;

  beforeAll(async () => {
    cacheDir = mkdtempSync(join(tmpdir(), 'session-cache-'));
    session = await openAnalysisSession(
      createSnapshotFetch({ cacheDir, token: null, fetchImpl: inMemorySnapshot(EXPRESS_POSTGRES_APP) }),
    );
    sqliteSession = await openAnalysisSession(
      createSnapshotFetch({ cacheDir: join(cacheDir, 'sqlite'), token: null, fetchImpl: inMemorySnapshot(SQLITE_APP) }),
    );
    express = await session.analyse({ id: 'repo-001', repository: 'acme/api', commit: SHA });
    sqlite = await sqliteSession.analyse({ id: 'repo-002', repository: 'acme/notes', commit: 'b'.repeat(40) });
  });

  afterAll(async () => {
    await session.close();
    await sqliteSession.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('persists what the real pipeline detected and what the deployment gate says', () => {
    expect(express).toMatchObject({ status: 'analysed', failure: null, treeFiles: 6 });
    expect(express.row.compatibilityStatus).toBe('READY');
    expect(express.row.healthPath).toBe('/healthz');
    expect(express.gate).toEqual({ state: 'READY', findings: [] });
    expect(express.manifest).toMatchObject({
      application: { runtime: 'node', root: '.', dockerfilePath: 'Dockerfile' },
      web: { port: 3000, command: 'CMD: ["node", "dist/index.js"]' },
      database: { postgres: true },
      redis: { required: false },
      storage: { required: false },
      // Bare `prisma migrate deploy` -> npx-prefixed (not runnable where the
      // relay executes it otherwise); no --schema flag, since this fixture's
      // single-WORKDIR Dockerfile puts the runtime cwd at the image root,
      // where `prisma/schema.prisma` is already Prisma's default lookup path.
      migration: { command: 'npx prisma migrate deploy' },
    });
  });

  it('reports a rejection in the analysis and in the gate', () => {
    expect(sqlite.status).toBe('analysed');
    expect(sqlite.row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(sqlite.analysis?.rejections.filter((rejection) => rejection.detected).map((rejection) => rejection.dependency)).toEqual(['sqlite']);
    expect(sqlite.gate?.state).toBe('NOT_COMPATIBLE');
    expect(sqlite.gate?.findings.map((finding) => finding.id)).toContain('unsupported');
  });

  it('records a repository the pipeline could not analyse as failed, never as a verdict', async () => {
    const empty = await openAnalysisSession(
      createSnapshotFetch({
        cacheDir: join(cacheDir, 'empty'),
        token: null,
        fetchImpl: (async () => new Response('{"message":"Git Repository is empty."}', { status: 404 })) as unknown as typeof fetch,
      }),
    );
    try {
      const result = await empty.analyse({ id: 'repo-003', repository: 'acme/empty', commit: 'c'.repeat(40) });
      expect(result).toMatchObject({ status: 'failed', failure: 'Repository has no commits to analyze', analysis: null, manifest: null, gate: null });
    } finally {
      await empty.close();
    }
  });
});
