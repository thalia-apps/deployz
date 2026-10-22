import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';
import type { Region } from '@deployz/contracts';

import { createAuth, type Auth } from './auth.js';
import { createDeploymentRecord } from './deploy-links.js';
import { env } from './env.js';
import { installLinkToken } from './install-link-token.js';
import { buildServer } from './server.js';

// Phase 2 — targeted installation invitations: a vendor creates an invitation
// WITHOUT a deployment; the customer (already named) selects the final Region
// and confirms; confirmation creates exactly one deployment and consumes the
// invitation.

const FIXTURE_SHA = crypto.randomUUID().replace(/-/g, '').slice(0, 40);

const READY_METADATA = {
  analysisCommitSha: FIXTURE_SHA,
  hasDockerfile: true,
  dockerfilePath: 'Dockerfile',
  framework: 'express',
  port: '3000',
  startupCommands: ['node dist/index.js'],
  hasStartupCommand: true,
  usesPostgresql: false,
  postgres: { required: false, evidence: [] },
  usesRedis: false,
  redis: { required: false, confidence: 'low', purposes: [], evidence: [], connectionEnvVars: [], compatibility: { supported: true } },
  usesS3: false,
  usesLocalFilesystem: false,
  usesWorkerProcesses: false,
  hasMigrationCommand: false,
  hasEnvVars: true,
  hasExternalServices: false,
  hasBuildCommand: false,
  buildCommands: ['npm run build'],
  envVars: [],
  envVarModel: [
    {
      key: 'STRIPE_API_KEY',
      required: true,
      secret: true,
      classification: 'customer_required',
      purpose: 'external_credential',
      confidence: 'high',
      source: ['.env.example'],
    },
  ],
  databaseState: 'none',
  externalServices: [] as string[],
} as Record<string, unknown>;

async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) throw new Error('sign-in did not set a session cookie');
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) throw new Error('signup did not provision an organization');
  return { userId: signup.user.id, organizationId, cookie: setCookie };
}

describe('targeted installation invitations', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let org: { userId: string; organizationId: string; cookie: string };
  let applicationId: string;
  let customerId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    org = await signUpAndGetOrg(auth, db, 'invitation-vendor@example.com');

    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: org.organizationId,
        name: 'Invited App',
        repoFullName: `acme/invited-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/invited',
        defaultBranch: 'main',
        detectedMetadata: READY_METADATA,
      })
      .returning();
    applicationId = application!.id;

    await db.insert(schema.releases).values({
      applicationId,
      version: '1.0.0',
      gitSha: crypto.randomUUID().slice(0, 8),
      imageDigest: 'registry.example.com/acme/app@sha256:' + 'a'.repeat(64),
      buildStatus: 'SUCCEEDED',
      releaseStatus: 'READY',
    });

    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: org.organizationId, name: 'Target Customer', email: 'target@example.com' })
      .returning();
    customerId = customer!.id;

    await db.insert(schema.billingSubscriptions).values({
      organizationId: org.organizationId,
      providerCustomerId: 'ctm_fixture_invitation',
      providerSubscriptionId: 'sub_fixture_invitation',
      status: 'ACTIVE',
    });

    app = await buildServer({ auth, db });
    // The customer must be able to choose a non-default deployable region.
    (env as { deployableAwsRegions: string[] }).deployableAwsRegions = ['us-east-1', 'eu-west-1'];
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  async function createInvitation(recommendedRegion?: string) {
    return app.inject({
      method: 'POST',
      url: `/api/customers/${customerId}/invitations`,
      headers: { 'content-type': 'application/json', cookie: org.cookie },
      payload: JSON.stringify({ applicationId, ...(recommendedRegion ? { recommendedRegion } : {}) }),
    });
  }

  // Approves the plan the way the install page does: fetch the plan for the
  // payload's Region and size, then echo its fingerprint.
  async function approvePlan(id: string, token: string, payload: Record<string, unknown>) {
    const sizeProfile = (payload['sizeProfile'] as string | undefined) ?? 'small';
    const plan = await app.inject({
      method: 'GET',
      url: `/api/public-install/${id}/plan?region=${String(payload['region'])}&profile=${sizeProfile}`,
      headers: { 'x-deployz-token': token },
    });
    const fingerprint = (plan.json() as { planFingerprint?: string | null }).planFingerprint;
    return { ...payload, sizeProfile, planFingerprint: fingerprint ?? '0'.repeat(64) };
  }

  async function deploymentCount(): Promise<number> {
    const rows = await db.select({ id: schema.deployments.id }).from(schema.deployments);
    return rows.length;
  }

  it('creates an invitation with a one-time token and NO deployment', async () => {
    const response = await createInvitation('ap-south-1');
    expect(response.statusCode, response.body).toBe(201);
    const body = response.json() as { id: string; token: string; recommendedRegion: string | null };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.token).toHaveLength(64);
    expect(body.recommendedRegion).toBe('ap-south-1');
    expect(await deploymentCount()).toBe(0);

    // The token is stored only as a hash — never the plaintext.
    const [row] = await db
      .select({ tokenHash: schema.publicInstallLinks.tokenHash })
      .from(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.id, body.id));
    expect(row!.tokenHash).not.toContain(body.token);
  });

  it('requires the secret token to resolve; a missing token 404s', async () => {
    const { id, token } = (await createInvitation()).json() as { id: string; token: string };

    const noToken = await app.inject({ method: 'GET', url: `/api/public-install/${id}` });
    expect(noToken.statusCode).toBe(404);

    const withToken = await app.inject({
      method: 'GET',
      url: `/api/public-install/${id}`,
      headers: { 'x-deployz-token': token },
    });
    expect(withToken.statusCode, withToken.body).toBe(200);
    const body = withToken.json() as { recommendedRegion: string | null; regionSelection: string };
    expect(body.regionSelection).toBe('customer');
    expect(body.recommendedRegion).toBeNull();
  });

  it('confirmation creates exactly one deployment on the target customer and consumes the invitation', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const key = crypto.randomUUID();
    const payload = {
      idempotencyKey: key,
      region: 'eu-west-1', // customer overrides the recommendation
      config: [{ key: 'STRIPE_API_KEY', value: 'sk_live_fixture', isSecret: true }],
    };

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, payload)),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    expect(await deploymentCount()).toBe(1);

    const [deployment] = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, id));
    expect(deployment!.customerId).toBe(customerId);
    expect(deployment!.region).toBe('eu-west-1');
    expect(deployment!.source).toBe('public_link');

    const [link] = await db
      .select({ confirmedAt: schema.publicInstallLinks.confirmedAt })
      .from(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.id, id));
    expect(link!.confirmedAt).not.toBeNull();

    // Replay with the SAME key is idempotent (200, same install link id).
    const replay = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, payload)),
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect((replay.json() as { installLinkId: string }).installLinkId).toBe(
      (confirm.json() as { installLinkId: string }).installLinkId,
    );

    // A DIFFERENT key on a consumed invitation is refused (410 USED).
    const differentKey = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, { ...payload, idempotencyKey: crypto.randomUUID() })),
    });
    expect(differentKey.statusCode).toBe(410);
    expect((differentKey.json() as { error: { code: string } }).error.code).toBe('PUBLIC_INSTALL_LINK_USED');
    expect(await deploymentCount()).toBe(1);
  });

  it('plan preview returns region-specific cost, estimate-unavailable for wrong Region, and 422 for unknown profile', async () => {
    const { id, token } = (await createInvitation()).json() as { id: string; token: string };
    const plan = (region: string, profile?: string) =>
      app.inject({
        method: 'GET',
        url: `/api/public-install/${id}/plan?region=${region}${profile ? `&profile=${profile}` : ''}`,
        headers: { 'x-deployz-token': token },
      });

    // Deployable region: a real estimate with that region.
    const deployable = await plan('eu-west-1');
    expect(deployable.statusCode, deployable.body).toBe(200);
    const deployableBody = deployable.json() as { region: string | null; costEstimate: unknown };
    expect(deployableBody.region).toBe('eu-west-1');
    expect(deployableBody.costEstimate).not.toBeNull();

    // Supported but NOT deployable: estimate unavailable, never a guess.
    const undeployable = await plan('us-west-1');
    expect(undeployable.statusCode, undeployable.body).toBe(200);
    const undeployableBody = undeployable.json() as { region: string | null; costEstimate: unknown };
    expect(undeployableBody.region).toBeNull();
    expect(undeployableBody.costEstimate).toBeNull();

    // Unknown profile: 422.
    const unknownProfile = await plan('eu-west-1', 'huge');
    expect(unknownProfile.statusCode).toBe(422);
    expect((unknownProfile.json() as { error: { code: string } }).error.code).toBe('UNKNOWN_PROFILE');
  });

  it('lists the customer invitations with derived status and no token material', async () => {
    const active = (await createInvitation()).json() as { id: string };
    const toUse = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${toUse.id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': toUse.token },
      payload: JSON.stringify(await approvePlan(toUse.id, toUse.token, {
        idempotencyKey: crypto.randomUUID(),
        region: 'us-east-1',
        config: [{ key: 'STRIPE_API_KEY', value: 'sk_list_fixture', isSecret: true }],
      })),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);

    const list = await app.inject({
      method: 'GET',
      url: `/api/customers/${customerId}/invitations`,
      headers: { cookie: org.cookie },
    });
    expect(list.statusCode, list.body).toBe(200);
    const rows = (list.json() as {
      invitations: Array<{
        id: string;
        status: string;
        applicationName: string;
        recommendedRegion: string | null;
      }>;
    }).invitations;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(toUse.id)?.status).toBe('used');
    expect(byId.get(active.id)?.status).toBe('active');
    expect(byId.get(active.id)?.applicationName).toBe('Invited App');
    expect(byId.get(active.id)?.recommendedRegion).toBeNull();
    // The stored hash and raw token never reach this surface.
    expect(JSON.stringify(rows)).not.toContain('tokenHash');
    expect(JSON.stringify(rows)).not.toContain(toUse.token);
  });

  it('emits the invitation lifecycle events without ever logging values or tokens', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    // Opening the invitation emits invitation.opened (throttled in memory).
    const opened = await app.inject({
      method: 'GET',
      url: `/api/public-install/${id}`,
      headers: { 'x-deployz-token': token },
    });
    expect(opened.statusCode, opened.body).toBe(200);

    const secretValue = 'sk_events_fixture_value';
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, {
        idempotencyKey: crypto.randomUUID(),
        region: 'eu-west-1', // differs from the recommendation on purpose
        config: [{ key: 'STRIPE_API_KEY', value: secretValue, isSecret: true }],
      })),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);

    const events = await db
      .select({ eventType: schema.eventLogs.eventType, payload: schema.eventLogs.payload })
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.customerId, customerId));
    const types = new Set(events.map((row) => row.eventType));
    for (const expected of [
      'invitation.created',
      'invitation.opened',
      'invitation.confirmed',
      'invitation.region_selected',
      'invitation.deployment_created',
      'invitation.configuration_delivered',
    ]) {
      expect(types, `missing ${expected}`).toContain(expected);
    }
    // Neither the secret value nor the one-time token reaches any payload.
    expect(JSON.stringify(events)).not.toContain(secretValue);
    expect(JSON.stringify(events)).not.toContain(token);
    // region_selected records the CUSTOMER's region, not the recommendation.
    const regionEvent = events.find((row) => row.eventType === 'invitation.region_selected');
    expect((regionEvent!.payload as Record<string, unknown>)['region']).toBe('eu-west-1');
  });

  it('two concurrent confirms with different keys create exactly one deployment', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const confirmOnce = async () =>
      app.inject({
        method: 'POST',
        url: `/api/public-install/${id}/confirm`,
        headers: { 'content-type': 'application/json', 'x-deployz-token': token },
        payload: JSON.stringify(await approvePlan(id, token, {
          idempotencyKey: crypto.randomUUID(),
          region: 'eu-west-1',
          config: [{ key: 'STRIPE_API_KEY', value: 'sk_race_fixture', isSecret: true }],
        })),
      });
    const [first, second] = await Promise.all([confirmOnce(), confirmOnce()]);
    const codes = [first.statusCode, second.statusCode].sort();
    expect(codes.join(','), `${first.body} | ${second.body}`).toBe('201,410');
    const loser = first.statusCode === 410 ? first : second;
    expect((loser.json() as { error: { code: string } }).error.code).toBe('PUBLIC_INSTALL_LINK_USED');
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, id));
    expect(deployments).toHaveLength(1);
  });

  it('two concurrent confirms with the same key on a targeted invitation stay idempotent', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const payload = {
      idempotencyKey: crypto.randomUUID(),
      region: 'us-east-1',
      config: [{ key: 'STRIPE_API_KEY', value: 'sk_samekey_fixture', isSecret: true }],
    };
    const confirmOnce = async () =>
      app.inject({
        method: 'POST',
        url: `/api/public-install/${id}/confirm`,
        headers: { 'content-type': 'application/json', 'x-deployz-token': token },
        payload: JSON.stringify(await approvePlan(id, token, payload)),
      });
    const [first, second] = await Promise.all([confirmOnce(), confirmOnce()]);
    expect(first.statusCode, `${first.body} | ${second.body}`).toBeLessThan(300);
    expect(second.statusCode, `${first.body} | ${second.body}`).toBeLessThan(300);
    expect((first.json() as { installLinkId: string }).installLinkId).toBe(
      (second.json() as { installLinkId: string }).installLinkId,
    );
    const deployments = await db
      .select({ id: schema.deployments.id })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, id));
    expect(deployments).toHaveLength(1);
  });

  it('omits a recommendation that is no longer deployable from resolve', async () => {
    // ap-south-1 is a supported Region but not in this suite's deployable
    // set — the recommendation cannot deploy, so it is never served.
    const stale = (await createInvitation('ap-south-1')).json() as { id: string; token: string };
    const staleResponse = await app.inject({
      method: 'GET',
      url: `/api/public-install/${stale.id}`,
      headers: { 'x-deployz-token': stale.token },
    });
    expect(staleResponse.statusCode, staleResponse.body).toBe(200);
    const staleBody = staleResponse.json() as { recommendedRegion: string | null; regions: { value: string }[] };
    expect(staleBody.recommendedRegion).toBeNull();
    expect(staleBody.regions.map((region) => region.value)).not.toContain('ap-south-1');

    // A deployable recommendation is still served.
    const fresh = (await createInvitation('eu-west-1')).json() as { id: string; token: string };
    const freshResponse = await app.inject({
      method: 'GET',
      url: `/api/public-install/${fresh.id}`,
      headers: { 'x-deployz-token': fresh.token },
    });
    const freshBody = freshResponse.json() as { recommendedRegion: string | null };
    expect(freshBody.recommendedRegion).toBe('eu-west-1');
  });

  it('keeps the deployment Region immutable after creation', async () => {
    const { id, token } = (await createInvitation('us-east-1')).json() as { id: string; token: string };
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, {
        idempotencyKey: crypto.randomUUID(),
        region: 'eu-west-1',
        config: [{ key: 'STRIPE_API_KEY', value: 'sk_immutable_fixture', isSecret: true }],
      })),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const { installLinkId } = confirm.json() as { installLinkId: string };

    // Later lifecycle calls never move the Region, whatever their outcome.
    await app.inject({
      method: 'POST',
      url: `/api/install/${installLinkId}/launched`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    await app.inject({
      method: 'POST',
      url: `/api/install/${installLinkId}/retry`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': installLinkToken(installLinkId) },
      payload: '{}',
    });

    const [deployment] = await db
      .select({ region: schema.deployments.region })
      .from(schema.deployments)
      .where(eq(schema.deployments.installLinkId, installLinkId));
    expect(deployment!.region).toBe('eu-west-1');
  });

  it('createDeploymentRecord itself refuses an undeployable Region (shared backstop)', async () => {
    // A confirmation first, so the target customer holds the config the
    // preflight needs; the count snapshot is taken after it.
    const { id, token } = (await createInvitation()).json() as { id: string; token: string };
    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(await approvePlan(id, token, {
        idempotencyKey: crypto.randomUUID(),
        region: 'us-east-1',
        config: [{ key: 'STRIPE_API_KEY', value: 'sk_backstop_fixture', isSecret: true }],
      })),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const before = await deploymentCount();

    // us-west-1 is a supported enum value but not deployable here — the
    // shared creation seam refuses it even though no route-level gate ran.
    await expect(
      createDeploymentRecord(db, {
        organizationId: org.organizationId,
        applicationId,
        customerId,
        region: 'us-west-1' as Region,
        deploymentType: 'PRODUCTION',
        createdBy: null,
        updatedBy: null,
        source: 'manual',
      }),
    ).rejects.toMatchObject({ statusCode: 422, code: 'REGION_NOT_SUPPORTED' });
    expect(await deploymentCount()).toBe(before);
  });

  it('freezes the vendor size recommendation on the invitation; the customer may choose a bigger size', async () => {
    const defaulted = (await createInvitation()).json() as { recommendedSizeProfile: string };
    expect(defaulted.recommendedSizeProfile).toBe('small');

    const created = await app.inject({
      method: 'POST',
      url: `/api/customers/${customerId}/invitations`,
      headers: { 'content-type': 'application/json', cookie: org.cookie },
      payload: JSON.stringify({ applicationId, recommendedSizeProfile: 'medium' }),
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id, token, recommendedSizeProfile } = created.json() as {
      id: string;
      token: string;
      recommendedSizeProfile: string;
    };
    expect(recommendedSizeProfile).toBe('medium');

    const resolved = await app.inject({
      method: 'GET',
      url: `/api/public-install/${id}`,
      headers: { 'x-deployz-token': token },
    });
    const sizing = (resolved.json() as { sizing: { recommended: string; minimum: string; options: { id: string }[] } }).sizing;
    expect(sizing).toMatchObject({ recommended: 'medium', minimum: 'small' });
    expect(sizing.options.map((option) => option.id)).toEqual(['small', 'medium', 'large']);

    const confirm = await app.inject({
      method: 'POST',
      url: `/api/public-install/${id}/confirm`,
      headers: { 'content-type': 'application/json', 'x-deployz-token': token },
      payload: JSON.stringify(
        await approvePlan(id, token, {
          idempotencyKey: crypto.randomUUID(),
          region: 'us-east-1',
          sizeProfile: 'large',
          config: [{ key: 'STRIPE_API_KEY', value: 'sk_size_fixture', isSecret: true }],
        }),
      ),
    });
    expect(confirm.statusCode, confirm.body).toBe(201);
    const [deployment] = await db
      .select({ desiredState: schema.deployments.desiredState })
      .from(schema.deployments)
      .where(eq(schema.deployments.publicInstallLinkId, id));
    expect(deployment!.desiredState).toMatchObject({ infrastructureProfile: { id: 'large', version: 1 } });
  });
});
