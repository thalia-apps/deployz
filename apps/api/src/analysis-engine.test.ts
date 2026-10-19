import crypto from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAiGateway, type AiGateway, type AnalysisEngine, type AnalystOutput } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { runApplicationAnalysis, type AnalysisRunnerDeps } from './analysis.js';
import type { FetchFn } from './github.js';

// ANALYSIS_ENGINE over the express-api fixture (EXPOSE 3000, `app.listen(process.env.PORT || 3000)`).
// The fake analyst moves the port to 4000 with evidence that the app reads PORT,
// so the fact passes the checks: only the `ai` engine may apply it.

const evidence = (path: string, line: number, quote: string) => [{ path, line, quote }];

const ANALYST: AnalystOutput = {
  dockerfile: { value: { path: 'Dockerfile', context: '.' }, confidence: 'high', evidence: evidence('Dockerfile', 1, 'FROM node:20-alpine') },
  port: { value: 4000, confidence: 'high', evidence: evidence('src/index.ts', 4, 'process.env.PORT') },
  startCommand: { value: 'node dist/index.js', confidence: 'high', evidence: evidence('Dockerfile', 8, 'dist/index.js') },
  healthPath: { value: '/health', confidence: 'high', evidence: evidence('src/index.ts', 3, "app.get('/health'") },
  database: { value: 'postgres', confidence: 'high', evidence: evidence('.env.example', 1, 'DATABASE_URL=') },
  redis: { value: false, confidence: 'high', evidence: [] },
  storage: { value: false, confidence: 'high', evidence: [] },
  migration: { value: { mode: 'unknown', command: null }, confidence: 'medium', evidence: [] },
  workers: [],
  requiredVariables: [],
};

function gateway(answer: () => unknown): AiGateway {
  return {
    async generate() {
      return { object: answer(), usage: { promptTokens: 1000, completionTokens: 200 }, model: 'fake' };
    },
  };
}

// The provider answers in the flat wire format: one entry per fact, the value as JSON text.
const SCALARS = ['dockerfile', 'port', 'startCommand', 'healthPath', 'database', 'redis', 'storage', 'migration'] as const;
const WIRE = {
  facts: SCALARS.map((fact) => ({
    fact,
    subject: null,
    value: JSON.stringify(ANALYST[fact].value),
    confidence: ANALYST[fact].confidence,
    evidence: ANALYST[fact].evidence,
  })),
};

const analyst = gateway(() => WIRE);
const reviewer = gateway(() => ({ objections: [] }));
const broken: AiGateway = {
  async generate() {
    throw new Error('gateway down');
  },
};

describe('analysis — ANALYSIS_ENGINE', () => {
  let client: PGlite | undefined;
  let db: Db;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  async function analyse(engine: AnalysisEngine, gateways: AnalysisRunnerDeps['aiAnalysis']) {
    const organizationId = `org-engine-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [inserted] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Engine App',
        repoFullName: 'deployz-demo/express-api',
        repoUrl: 'https://github.com/deployz-demo/express-api',
        defaultBranch: 'main',
        analysisStatus: 'ANALYZING',
      })
      .returning();
    const deps: AnalysisRunnerDeps = {
      db,
      fetchFn: (() => {
        throw new Error('fixture mode must never call fetchFn');
      }) as unknown as FetchFn,
      githubAppId: undefined,
      githubAppPrivateKey: undefined,
      githubFixtureMode: true,
      aiGateway: createAiGateway(undefined),
      analysisEngine: engine,
      aiAnalysis: gateways,
    };
    await runApplicationAnalysis(deps, inserted!.id);
    const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, inserted!.id));
    return row!;
  }

  it('rules: never calls the AI and stores no AI record', async () => {
    const row = await analyse('rules', { analyst: broken, reviewer: broken });
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toBeUndefined();
    expect(row.detectedMetadata?.['analysisEngine']).toBeUndefined();
  });

  it('shadow: stores the AI result and changes nothing', async () => {
    const row = await analyse('shadow', { analyst, reviewer });
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['analysisEngine']).toBe('shadow');
    const record = row.detectedMetadata?.['aiEngine'] as { status: string; facts: Array<{ fact: string; decision: string }> };
    expect(record.status).toBe('ok');
    expect(record.facts).toContainEqual(expect.objectContaining({ fact: 'port', decision: 'ai' }));
  });

  it('ai: a verified AI fact enters the analysis', async () => {
    const row = await analyse('ai', { analyst, reviewer });
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.containerPort).toBe(4000);
    expect(row.detectedMetadata?.['port']).toBe('4000');
    expect(row.compatibilityStatus).toBe('READY');
  });

  it('ai: a gateway failure falls back to the rules result', async () => {
    const row = await analyse('ai', { analyst: broken, reviewer });
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback', reason: 'Error' });
  });

  it('ai: invalid model output falls back to the rules result', async () => {
    const row = await analyse('ai', { analyst: gateway(() => ({ port: 'eighty' })), reviewer });
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback' });
  });

  it('ai: without gateways it runs the rules only', async () => {
    const row = await analyse('ai', undefined);
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback', reason: 'not_configured' });
  });
});
