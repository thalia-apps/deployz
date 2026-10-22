import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// A DESTROY request stops billing immediately and terminally (billing_state
// STOPPED). When the relay reports the DESTROY as FAILED the deployment lands
// on FAILED, and deploying again would serve the application unbilled. The
// only way forward is another disconnect.

async function signUp(auth: Auth, db: Db, email: string) {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: 'Test' } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie')!;
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  return { cookie, organizationId: membership!.organizationId };
}

function send(
  app: FastifyInstance,
  method: 'POST' | 'PUT' | 'PATCH',
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('a failed DESTROY does not allow a deploy', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let cookie: string;
  let applicationId: string;
  let customerId: string;
  let releaseId: string;
  const relayToken = 'audit-relay-token-0123456789abcdef';

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    app = await buildServer({ auth, db });
    const { cookie: sessionCookie, organizationId } = await signUp(auth, db, 'audit-billing@example.com');
    cookie = sessionCookie;
    await db.insert(schema.githubInstallations).values({
      id: 'inst-1',
      organizationId,
      accountLogin: 'acme',
      accountType: 'Organization',
    });
    await db.insert(schema.billingSubscriptions).values({
      organizationId,
      providerCustomerId: 'ctm_audit',
      providerSubscriptionId: 'sub_audit',
      status: 'ACTIVE',
    });
    const application = await send(
      app,
      'POST',
      '/api/applications',
      {
        name: 'Acme Analytics',
        githubInstallationId: 'inst-1',
        repoFullName: 'acme/analytics',
        repoUrl: 'https://github.com/acme/analytics',
        defaultBranch: 'main',
      },
      { cookie },
    );
    applicationId = (application.json() as { id: string }).id;
    const customer = await send(
      app,
      'POST',
      '/api/customers',
      { name: 'Acme Corp', email: 'ops@acme.example.com' },
      { cookie },
    );
    customerId = (customer.json() as { id: string }).id;
    await db
      .update(schema.applications)
      .set({
        detectedMetadata: {
          hasDockerfile: true,
          dockerfilePath: 'Dockerfile',
          port: '3000',
          startupCommands: ['node dist/index.js'],
          usesPostgresql: false,
          postgres: { required: false },
          usesRedis: false,
          redis: { required: false },
          usesS3: false,
          usesLocalFilesystem: false,
          databaseState: 'none',
        },
      })
      .where(eq(schema.applications.id, applicationId));
    const [release] = await db
      .insert(schema.releases)
      .values({
        applicationId,
        version: '1.0.0',
        gitSha: 'a'.repeat(40),
        releaseStatus: 'READY',
        imageDigest: `123456789012.dkr.ecr.us-east-1.amazonaws.com/deployz-fixture@sha256:${'b'.repeat(64)}`,
      })
      .returning();
    releaseId = release!.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('destroy stops billing, a failed destroy lands on FAILED, deploy and restart are refused', async () => {
    const created = await send(
      app,
      'POST',
      '/api/deployments',
      { applicationId, customerId, region: 'us-east-1' },
      { cookie },
    );
    expect(created.statusCode).toBe(201);
    const deploymentId = (created.json() as { id: string }).id;

    // Simulate an installed, healthy, billed production deployment with a
    // connected relay (the state the relay write paths would have produced).
    const now = new Date();
    await db
      .update(schema.deployments)
      .set({
        state: 'HEALTHY',
        installationId: 'audit-install-1',
        relayStatus: 'CONNECTED',
        relayBoundAt: now,
        lastHealthAt: now,
        enrollmentUsedAt: now,
        relayCredential: null,
        relayTokenHash: hashRelayToken(relayToken),
        currentReleaseId: releaseId,
        billingState: 'ACTIVE',
        billingStartedAt: now,
      })
      .where(eq(schema.deployments.id, deploymentId));
    await db.insert(schema.deploymentJobs).values({
      deploymentId,
      type: 'INSTALL',
      state: 'SUCCEEDED',
      idempotencyKey: `${deploymentId}:INSTALL`,
      payload: {},
      startedAt: now,
      finishedAt: now,
    });

    // 1. Vendor requests the disconnect: billing stops at once (R0-1).
    const destroy = await send(app, 'POST', `/api/deployments/${deploymentId}/destroy`, {}, { cookie });
    expect(destroy.statusCode).toBe(202);
    const destroyJobId = (destroy.json() as { jobId: string }).jobId;
    let [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(row!.state).toBe('DELETING');
    expect(row!.billingState).toBe('STOPPED');

    // 2. The relay claims the DESTROY and reports it FAILED (for example the
    // relay role was denied cloudformation:DeleteStack; the stack still serves).
    const claim = await app.inject({
      method: 'GET',
      url: '/api/relay/commands?installationId=audit-install-1',
      headers: { authorization: `Bearer ${relayToken}` },
    });
    expect(claim.statusCode).toBe(200);
    expect((claim.json() as { commands: { id: string }[] }).commands.map((c) => c.id)).toContain(destroyJobId);
    const failed = await send(
      app,
      'POST',
      `/api/relay/commands/${destroyJobId}/result`,
      { success: false, error: 'User is not authorized to perform: cloudformation:DeleteStack', failureCode: 'AWS_PERMISSION_DENIED' },
      { authorization: `Bearer ${relayToken}` },
    );
    expect(failed.statusCode).toBe(200);
    [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(row!.state).toBe('FAILED');
    expect(row!.billingState).toBe('STOPPED');

    // 3. Deploy and restart are refused: the newest job is a DESTROY.
    const deploy = await send(app, 'POST', `/api/deployments/${deploymentId}/deploy`, { releaseId }, { cookie });
    expect(deploy.statusCode).toBe(409);
    expect(deploy.json()).toMatchObject({ error: { code: 'DEPLOYMENT_NOT_DEPLOYABLE' } });
    const restart = await send(app, 'POST', `/api/deployments/${deploymentId}/restart`, {}, { cookie });
    expect(restart.statusCode).toBe(409);
    [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    expect(row!.state).toBe('FAILED');
  }, 60_000);
});
