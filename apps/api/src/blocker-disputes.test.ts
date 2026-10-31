import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAiGateway, type ReadinessReport } from '@deployz/analysis';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

// Vendor disputes of allowlisted blockers (docs/ai-analysis.md#vendor-disputes).
// Without a queue the route runs the forced re-analysis inline, so each 202
// is followed by a complete analysis.

const MONGO_REPO = 'deployz-demo/mongodb-app';
const MONGO_FINDING = 'unsupported-database-mongo';

async function signUp(auth: Auth, db: Db, email: string): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie');
  if (!cookie) throw new Error('sign-in did not set a session cookie');
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  return { userId: signup.user.id, organizationId: membership!.organizationId, cookie };
}

describe('blocker disputes', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let vendor: { userId: string; organizationId: string; cookie: string };
  let other: { userId: string; organizationId: string; cookie: string };

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    vendor = await signUp(auth, db, 'dispute-vendor@example.com');
    other = await signUp(auth, db, 'dispute-other@example.com');
    app = await buildServer({ auth, db, githubFixtureMode: true, aiGateway: createAiGateway(undefined) });
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function loadApplication(id: string): Promise<typeof schema.applications.$inferSelect> {
    const [row] = await db.select().from(schema.applications).where(eq(schema.applications.id, id)).limit(1);
    return row!;
  }

  function request(method: 'POST' | 'DELETE', url: string, cookie: string, body?: unknown) {
    return app.inject({
      method,
      url,
      headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  }

  async function analysedMongoApp(): Promise<{ id: string; evidence: string }> {
    await db.delete(schema.applications).where(eq(schema.applications.repoFullName, MONGO_REPO));
    const created = await app.inject({
      method: 'POST',
      url: '/api/applications',
      headers: { cookie: vendor.cookie, 'content-type': 'application/json' },
      payload: JSON.stringify({
        name: 'mongodb-app',
        githubInstallationId: 'fixture-install-1',
        repoFullName: MONGO_REPO,
        repoUrl: `https://github.com/${MONGO_REPO}`,
        defaultBranch: 'main',
      }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = created.json() as { id: string };
    const analysed = await request('POST', `/api/applications/${id}/analyse`, vendor.cookie);
    expect(analysed.statusCode, analysed.body).toBe(202);
    const row = await loadApplication(id);
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    const finding = (row.detectedMetadata!['readiness'] as ReadinessReport).findings.find((item) => item.id === MONGO_FINDING);
    return { id, evidence: finding!.technicalEvidence };
  }

  async function events(eventType: string, applicationId: string) {
    const rows = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, eventType));
    return rows.filter((row) => row.payload['applicationId'] === applicationId);
  }

  it('a dispute removes the blocker; re-analysis keeps it; undo restores the blocker', async () => {
    const { id, evidence } = await analysedMongoApp();

    const disputed = await request('POST', `/api/applications/${id}/blocker-disputes`, vendor.cookie, { findingId: MONGO_FINDING, reason: evidence });
    expect(disputed.statusCode, disputed.body).toBe(202);
    let row = await loadApplication(id);
    expect(row.analysisStatus).toBe('COMPLETE');
    expect(row.compatibilityStatus).not.toBe('NOT_COMPATIBLE');
    const report = row.detectedMetadata!['readiness'] as ReadinessReport;
    expect(report.findings.some((item) => item.id === MONGO_FINDING)).toBe(false);
    expect(row.detectedMetadata!['vendorDismissedRejections']).toEqual([
      { findingId: MONGO_FINDING, reason: evidence, dismissedAt: expect.any(String), dismissedBy: vendor.userId },
    ]);

    const [event] = await events('application.analysis_disputed', id);
    expect(event!.payload).toMatchObject({ schemaVersion: 1, applicationId: id, findingId: MONGO_FINDING });
    expect(JSON.stringify(event!.payload)).not.toContain(evidence);

    const readiness = await app.inject({ method: 'GET', url: `/api/applications/${id}/readiness`, headers: { cookie: vendor.cookie } });
    expect(readiness.json()).toMatchObject({ vendorDismissedRejections: [{ findingId: MONGO_FINDING }] });

    const again = await request('POST', `/api/applications/${id}/analyse`, vendor.cookie, { force: true });
    expect(again.statusCode).toBe(202);
    row = await loadApplication(id);
    expect(row.compatibilityStatus).not.toBe('NOT_COMPATIBLE');
    expect(row.detectedMetadata!['vendorDismissedRejections']).toHaveLength(1);

    const undone = await request('DELETE', `/api/applications/${id}/blocker-disputes/${MONGO_FINDING}`, vendor.cookie);
    expect(undone.statusCode, undone.body).toBe(202);
    row = await loadApplication(id);
    expect(row.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(row.detectedMetadata!['vendorDismissedRejections']).toBeUndefined();
    expect(await events('application.analysis_dispute_withdrawn', id)).toEqual([
      expect.objectContaining({ payload: { schemaVersion: 1, applicationId: id, findingId: MONGO_FINDING, wasStale: false } }),
    ]);
  });

  it('marks an answer stale when the evidence no longer matches, and does not apply it', async () => {
    const { id, evidence } = await analysedMongoApp();
    const row = await loadApplication(id);
    await db
      .update(schema.applications)
      .set({
        detectedMetadata: {
          ...row.detectedMetadata,
          vendorDismissedRejections: [{ findingId: MONGO_FINDING, reason: `${evidence} (old)`, dismissedAt: 'x', dismissedBy: vendor.userId }],
        },
      })
      .where(eq(schema.applications.id, id));

    await request('POST', `/api/applications/${id}/analyse`, vendor.cookie, { force: true });
    const after = await loadApplication(id);
    expect(after.compatibilityStatus).toBe('NOT_COMPATIBLE');
    expect(after.detectedMetadata!['vendorDismissedRejections']).toEqual([expect.objectContaining({ findingId: MONGO_FINDING, stale: true })]);
  });

  it('refuses a finding that is not disputable, changed evidence, a running analysis and another organization', async () => {
    const { id, evidence } = await analysedMongoApp();
    const url = `/api/applications/${id}/blocker-disputes`;

    const hard = await request('POST', url, vendor.cookie, { findingId: 'unsupported-gpu', reason: evidence });
    expect(hard.statusCode).toBe(422);
    expect(hard.json()).toMatchObject({ error: { code: 'FINDING_NOT_DISPUTABLE' } });

    const changed = await request('POST', url, vendor.cookie, { findingId: MONGO_FINDING, reason: 'other evidence' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toMatchObject({ error: { code: 'FINDING_CHANGED' } });

    const foreign = await request('POST', url, other.cookie, { findingId: MONGO_FINDING, reason: evidence });
    expect(foreign.statusCode).toBe(404);

    await db.update(schema.applications).set({ analysisStatus: 'ANALYZING' }).where(eq(schema.applications.id, id));
    const running = await request('POST', url, vendor.cookie, { findingId: MONGO_FINDING, reason: evidence });
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ error: { code: 'ANALYSIS_IN_PROGRESS' } });

    const missing = await request('POST', url, vendor.cookie, { findingId: MONGO_FINDING });
    expect(missing.statusCode).toBe(400);
    expect((await loadApplication(id)).detectedMetadata!['vendorDismissedRejections']).toBeUndefined();
  });

  it('accepts an answer on a required soft finding only while the final review asks to confirm it', async () => {
    const { id } = await analysedMongoApp();
    const url = `/api/applications/${id}/blocker-disputes`;
    const reason = "Server binds only to a loopback address: listen(3000, '127.0.0.1') (src/index.js)";
    const withBinding = async (confidence: 'likely' | 'needs_confirmation') => {
      const row = await loadApplication(id);
      const readiness = row.detectedMetadata!['readiness'] as ReadinessReport;
      const binding = { ...readiness.findings.find((item) => item.id === MONGO_FINDING)!, id: 'localhost-binding', blocking: false, fixClass: 'CODE_CHANGE' as const, technicalEvidence: reason, confidence };
      await db
        .update(schema.applications)
        .set({ detectedMetadata: { ...row.detectedMetadata, readiness: { ...readiness, findings: [...readiness.findings, binding] } } })
        .where(eq(schema.applications.id, id));
    };

    await withBinding('likely');
    const unasked = await request('POST', url, vendor.cookie, { findingId: 'localhost-binding', reason });
    expect(unasked.statusCode).toBe(409);
    expect(unasked.json()).toMatchObject({ error: { code: 'FINDING_CHANGED' } });

    await withBinding('needs_confirmation');
    const asked = await request('POST', url, vendor.cookie, { findingId: 'localhost-binding', reason });
    expect(asked.statusCode, asked.body).toBe(202);
    expect((await loadApplication(id)).detectedMetadata!['vendorDismissedRejections']).toEqual([expect.objectContaining({ findingId: 'localhost-binding', reason })]);
  });
});
