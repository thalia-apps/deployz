import crypto from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAiGateway, JUDGE_SYSTEM, type AiGateway, type AnalysisEngine } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { runApplicationAnalysis, type AnalysisRunnerDeps } from './analysis.js';
import type { FetchFn } from './github.js';

// ANALYSIS_ENGINE over two fixtures. express-api leaves no open item, so no
// engine calls the model. mongodb-app has one blocker question (mongoose); the
// fake analyst answers "not used", which the checks refuse because the app
// imports mongoose, so the rejection stays.

function gateway(answer: () => unknown): AiGateway {
  return {
    async generate() {
      return { object: answer(), usage: { promptTokens: 1000, completionTokens: 200 }, model: 'fake' };
    },
  };
}

const NOT_USED = {
  answers: [
    {
      id: 'q1',
      answer: 'not_used',
      setting: null,
      settingValue: null,
      engine: null,
      value: null,
      confidence: 'high',
      evidence: [{ path: 'Dockerfile', line: 8, quote: 'CMD ["node", "dist/index.js"]' }],
    },
  ],
};

const analyst = gateway(() => NOT_USED);

/** The analyst answers "not used"; the final judge (its own system message) blocks on a cited Dockerfile line. */
const JUDGE_BLOCKS = {
  verdict: 'not_deployable',
  category: 'not_http',
  reason: 'It does not serve a web application.',
  evidence: [{ path: 'Dockerfile', line: 8, quote: 'CMD ["node", "dist/index.js"]' }],
};
function judged(judge: unknown): AiGateway & { systems: Array<string | undefined> } {
  const systems: Array<string | undefined> = [];
  return {
    systems,
    async generate(_prompt, _schema, options) {
      systems.push(options?.system);
      return { object: options?.system === JUDGE_SYSTEM ? judge : NOT_USED, usage: { promptTokens: 1000, completionTokens: 200 }, model: 'fake' };
    },
  };
}
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

  async function analyse(engine: AnalysisEngine, gateways: AnalysisRunnerDeps['aiAnalysis'], repo = 'express-api', detectedMetadata?: Record<string, unknown>) {
    const organizationId = `org-engine-${crypto.randomUUID().slice(0, 8)}`;
    await db.insert(schema.organization).values({ id: organizationId, name: 'Acme', slug: organizationId });
    const [inserted] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'Engine App',
        repoFullName: `deployz-demo/${repo}`,
        repoUrl: `https://github.com/deployz-demo/${repo}`,
        defaultBranch: 'main',
        analysisStatus: 'ANALYZING',
        ...(detectedMetadata ? { detectedMetadata } : {}),
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
    const row = await analyse('rules', { analyst: broken });
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toBeUndefined();
    expect(row.detectedMetadata?.['analysisEngine']).toBeUndefined();
  });

  it('ai: a repository with no open item makes no model call', async () => {
    const row = await analyse('ai', { analyst: broken });
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'ok', analyst: null, questions: 0 });
  });

  it('shadow: stores the AI answers and changes nothing', async () => {
    const row = await analyse('shadow', { analyst }, 'mongodb-app');
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(row.detectedMetadata?.['analysisEngine']).toBe('shadow');
    const record = row.detectedMetadata?.['aiEngine'] as { status: string; answers: Array<{ subject: string; decision: string }> };
    expect(record.status).toBe('ok');
    expect(record.answers).toContainEqual(expect.objectContaining({ subject: 'mongoose', decision: 'rules' }));
  });

  it('ai: a "not used" answer that the checks refute keeps the rejection', async () => {
    const row = await analyse('ai', { analyst }, 'mongodb-app');
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
  });

  it('ai: a gateway failure falls back to the rules result', async () => {
    const row = await analyse('ai', { analyst: broken }, 'mongodb-app');
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback', reason: 'Error' });
  });

  it('ai: invalid model output falls back to the rules result', async () => {
    const row = await analyse('ai', { analyst: gateway(() => ({ port: 'eighty' })) }, 'mongodb-app');
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback' });
  });

  it('ai: the final judge skips a NOT_DEPLOYABLE outcome and makes no call', async () => {
    const judge = judged(JUDGE_BLOCKS);
    const row = await analyse('ai', { analyst: judge }, 'mongodb-app');
    expect(row.detectedMetadata?.['aiJudge']).toMatchObject({ status: 'skipped', reason: 'not_deployable' });
    expect(judge.systems).not.toContain(JUDGE_SYSTEM);
  });

  it('ai: a cited final judge "not_deployable" blocks a deployable app', async () => {
    const row = await analyse('ai', { analyst: judged(JUDGE_BLOCKS) });
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect((row.detectedMetadata?.['readiness'] as { outcome: string }).outcome).toBe('NOT_DEPLOYABLE');
    expect(row.detectedMetadata?.['aiJudge']).toMatchObject({ status: 'ok', judgement: { decision: 'block' } });
  });

  it('ai: a final judge "not_deployable" that cites a line it was not shown only asks the vendor', async () => {
    const row = await analyse('ai', { analyst: judged({ ...JUDGE_BLOCKS, evidence: [{ path: 'src/server.js', line: 1, quote: 'net.createServer' }] }) });
    expect(row.compatibilityStatus).toBe('READY');
    const readiness = row.detectedMetadata?.['readiness'] as { outcome: string; findings: Array<{ id: string }> };
    expect(readiness.outcome).toBe('DEPLOYABLE');
    expect(readiness.findings.map((finding) => finding.id)).toContain('final-review-question');
  });

  it('ai: a vendor answer skips only its own item: the judge still runs, reads it, and a block in its category only asks', async () => {
    const rules = await analyse('rules', undefined, 'mongodb-app');
    const mongo = (rules.detectedMetadata?.['readiness'] as { findings: { id: string; technicalEvidence: string }[] }).findings.find((item) => item.id === 'unsupported-database-mongo')!;
    const dispute = { findingId: mongo.id, reason: mongo.technicalEvidence, dismissedAt: new Date().toISOString(), dismissedBy: 'vendor' };
    const prompts: string[] = [];
    const judge: AiGateway = {
      async generate(prompt, _schema, options) {
        if (options?.system === JUDGE_SYSTEM) prompts.push(prompt);
        const object = options?.system === JUDGE_SYSTEM ? { ...JUDGE_BLOCKS, category: 'unsupported_service' } : NOT_USED;
        return { object, usage: { promptTokens: 1000, completionTokens: 200 }, model: 'fake' };
      },
    };
    const row = await analyse('ai', { analyst: judge }, 'mongodb-app', { vendorDismissedRejections: [dispute] });
    expect(row.compatibilityStatus).not.toBe('NOT_COMPATIBLE');
    expect(row.detectedMetadata?.['aiJudge']).toMatchObject({ status: 'ok', judgement: { verdict: 'not_deployable', decision: 'question' } });
    expect(prompts[0]).toContain(`- ${mongo.technicalEvidence}`);
  });

  it('ai: a final judge failure changes nothing', async () => {
    const row = await analyse('ai', { analyst: judged({ verdict: 'maybe' }) });
    expect(row.compatibilityStatus).toBe('READY');
    expect(row.detectedMetadata?.['aiJudge']).toMatchObject({ status: 'fallback' });
  });

  it('ai: without gateways it runs the rules only', async () => {
    const row = await analyse('ai', undefined);
    expect(row.containerPort).toBe(3000);
    expect(row.detectedMetadata?.['aiEngine']).toMatchObject({ status: 'fallback', reason: 'not_configured' });
  });
});
