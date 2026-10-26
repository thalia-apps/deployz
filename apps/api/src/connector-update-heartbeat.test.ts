import { PGlite } from '@electric-sql/pglite';
import { and, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth } from './auth.js';
import { env } from './env.js';
import { hashRelayToken } from './relay-store.js';
import { buildServer } from './server.js';

// The heartbeat stores the connector stack status the relay reports and
// records each connector update outcome once.
describe('connector update verification on the heartbeat', () => {
  const PUBLISHED = 'build-new';
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let organizationId: string;
  let applicationId: string;
  let customerId: string;
  const previousBuildId = env.bootstrapBuildId;

  async function seed(bootstrapVersion: string): Promise<{ id: string; installationId: string; token: string }> {
    const token = 'tok-' + crypto.randomUUID();
    const installationId = 'inst-' + crypto.randomUUID();
    const [row] = await db
      .insert(schema.deployments)
      .values({
        organizationId,
        applicationId,
        customerId,
        region: 'us-east-1',
        state: 'HEALTHY',
        installationId,
        enrollmentCode: crypto.randomUUID(),
        enrollmentUsedAt: new Date(),
        relayTokenHash: hashRelayToken(token),
        relayStatus: 'CONNECTED',
        healthStatus: 'HEALTHY',
        bootstrapVersion,
        observedState: {},
      })
      .returning();
    return { id: row!.id, installationId, token };
  }

  async function heartbeat(
    deployment: { installationId: string; token: string },
    identity: { bootstrapVersion?: string; bootstrapStackStatus?: string },
  ): Promise<void> {
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/health',
      headers: { authorization: `Bearer ${deployment.token}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ installationId: deployment.installationId, observedState: {}, identity }),
    });
    expect(response.statusCode, response.body).toBe(200);
  }

  async function connectorEvents(deploymentId: string): Promise<{ eventType: string; payload: unknown }[]> {
    return db
      .select({ eventType: schema.eventLogs.eventType, payload: schema.eventLogs.payload })
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.deploymentId, deploymentId), like(schema.eventLogs.eventType, 'connector.%')));
  }

  async function storedStack(deploymentId: string): Promise<unknown> {
    const [row] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deploymentId));
    return (row!.observedState as Record<string, unknown>)['bootstrapStack'];
  }

  beforeAll(async () => {
    env.bootstrapBuildId = PUBLISHED;
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    await auth.api.signUpEmail({
      body: { email: 'connector-update@example.com', password: 'super-secret-1', name: 'Connector' },
    });
    app = await buildServer({ auth, db });
    const [membership] = await db.select({ organizationId: schema.member.organizationId }).from(schema.member).limit(1);
    organizationId = membership!.organizationId;
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId,
        name: 'App',
        repoFullName: `acme/cu-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/cu',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId, name: 'Cust', email: `cust-${crypto.randomUUID()}@example.com` })
      .returning();
    customerId = customer!.id;
  }, 60_000);

  afterAll(async () => {
    env.bootstrapBuildId = previousBuildId;
    await app?.close();
    await client?.close();
  });

  it('records connector.update_verified once when the updated stack is stable on the published build', async () => {
    const deployment = await seed('build-old');
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'CREATE_COMPLETE' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_IN_PROGRESS' });
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED, bootstrapStackStatus: 'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS' });
    expect(await connectorEvents(deployment.id)).toEqual([]);
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED, bootstrapStackStatus: 'UPDATE_COMPLETE' });
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED, bootstrapStackStatus: 'UPDATE_COMPLETE' });
    expect(await connectorEvents(deployment.id)).toEqual([
      { eventType: 'connector.update_verified', payload: { installedBuildId: PUBLISHED, publishedBuildId: PUBLISHED } },
    ]);
  });

  it('keeps the last reported status when a heartbeat omits it', async () => {
    const deployment = await seed(PUBLISHED);
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED, bootstrapStackStatus: 'UPDATE_COMPLETE' });
    const reported = (await storedStack(deployment.id)) as { status: string; observedAt: string };
    expect(reported.status).toBe('UPDATE_COMPLETE');
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED });
    expect(await storedStack(deployment.id)).toEqual(reported);
  });

  it('records a rollback and a failed update once each', async () => {
    const deployment = await seed('build-old');
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_IN_PROGRESS' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_ROLLBACK_IN_PROGRESS' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_ROLLBACK_COMPLETE' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_ROLLBACK_COMPLETE' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_ROLLBACK_FAILED' });
    await heartbeat(deployment, { bootstrapVersion: 'build-old', bootstrapStackStatus: 'UPDATE_ROLLBACK_FAILED' });
    expect((await connectorEvents(deployment.id)).map((event) => event.eventType).sort()).toEqual([
      'connector.update_failed',
      'connector.update_rolled_back',
    ]);
  });

  it('ignores a malformed status', async () => {
    const deployment = await seed(PUBLISHED);
    await heartbeat(deployment, { bootstrapVersion: PUBLISHED, bootstrapStackStatus: 'not a <status>' });
    expect(await storedStack(deployment.id)).toBeUndefined();
  });

  it('claims no command with claim=0, and still returns the deployment facts', async () => {
    const deployment = await seed(PUBLISHED);
    await db.insert(schema.deploymentJobs).values({
      deploymentId: deployment.id,
      type: 'RESTART',
      state: 'REQUESTED',
      idempotencyKey: `${deployment.id}:RESTART`,
      payload: {},
    });
    const poll = (query: string) =>
      app.inject({
        method: 'GET',
        url: `/api/relay/commands?installationId=${deployment.installationId}${query}`,
        headers: { authorization: `Bearer ${deployment.token}` },
      });
    const paused = await poll('&claim=0');
    expect(paused.statusCode).toBe(200);
    expect(paused.json().commands).toEqual([]);
    expect(paused.json().deployment).toHaveProperty('probeUrl');
    expect((await poll('')).json().commands).toHaveLength(1);
  });
});
