import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { EmailMessage, EmailSender } from './email.js';
import { buildServer } from './server.js';

// ── Shared test helpers (matches server.test.ts / auth.test.ts style) ──────

/** Signs up a fresh user, which provisions its own vendor org (auth.ts session hook). */
async function signUpAndGetOrg(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; organizationId: string; cookie: string; email: string; name: string }> {
  // Throwaway credential, generated per account. Nothing here is written
  // down, so there is no credential in the source for a scanner to find.
  const password = crypto.randomUUID();
  const name = email.split('@')[0]!;
  const signup = await auth.api.signUpEmail({ body: { email, password, name } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const setCookie = signin.headers.get('set-cookie');
  if (!setCookie) {
    throw new Error('sign-in did not set a session cookie');
  }
  const memberships = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  const organizationId = memberships[0]?.organizationId;
  if (!organizationId) {
    throw new Error('signup did not provision an organization');
  }
  return { userId: signup.user.id, organizationId, cookie: setCookie, email, name };
}

/**
 * Adds an already-signed-up user to an organization directly (bypassing the
 * invitation flow, which is tested on its own) and points their session at
 * it, so their existing cookie resolves that organization as active.
 */
async function addMember(
  db: Db,
  organizationId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(schema.member).values({ id, organizationId, userId, role });
  await db
    .update(schema.session)
    .set({ activeOrganizationId: organizationId })
    .where(eq(schema.session.userId, userId));
  return id;
}

async function insertApplication(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.applications.$inferInsert> = {},
): Promise<typeof schema.applications.$inferSelect> {
  const [row] = await db
    .insert(schema.applications)
    .values({
      organizationId,
      name: 'Test App',
      repoFullName: 'acme/test-app',
      repoUrl: 'https://github.com/acme/test-app',
      defaultBranch: 'main',
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertCustomer(
  db: Db,
  organizationId: string,
  overrides: Partial<typeof schema.customers.$inferInsert> = {},
): Promise<typeof schema.customers.$inferSelect> {
  const [row] = await db
    .insert(schema.customers)
    .values({
      organizationId,
      name: 'Test Customer',
      email: `customer-${crypto.randomUUID()}@example.com`,
      ...overrides,
    })
    .returning();
  return row!;
}

async function insertDeployment(
  db: Db,
  organizationId: string,
  applicationId: string,
  customerId: string,
  overrides: Partial<typeof schema.deployments.$inferInsert> = {},
): Promise<typeof schema.deployments.$inferSelect> {
  const [row] = await db
    .insert(schema.deployments)
    .values({
      organizationId,
      applicationId,
      customerId,
      region: 'us-east-1',
      state: 'NOT_INSTALLED',
      installationId: `inst-${crypto.randomUUID()}`,
      enrollmentCode: crypto.randomUUID(),
      ...overrides,
    })
    .returning();
  return row!;
}

/** POST/PATCH/DELETE a JSON body through app.inject, matching server.ts's raw-string JSON parser. */
function sendJson(
  app: FastifyInstance,
  method: 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    payload: JSON.stringify(body),
  });
}

function postJson(
  app: FastifyInstance,
  url: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
) {
  return sendJson(app, 'POST', url, body, extraHeaders);
}

/** Recording EmailSender — captures every message instead of touching the network. */
function createRecordingEmailSender(): { sentEmails: EmailMessage[]; emailSender: EmailSender } {
  const sentEmails: EmailMessage[] = [];
  const emailSender: EmailSender = {
    async send(message) {
      sentEmails.push(message);
    },
  };
  return { sentEmails, emailSender };
}

// ── §me/organizations: GET /api/me, create/list/activate, isolation ────────
describe('GET /api/me and organization create/list/activate (isolation)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgB: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let secondOrgId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    orgA = await signUpAndGetOrg(auth, db, `me-a-${crypto.randomUUID()}@example.com`);
    orgB = await signUpAndGetOrg(auth, db, `me-b-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/me returns the role and organizations list', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: orgA.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      role: string;
      organizations: Array<{ id: string; role: string; memberCount: number; subscriptionStatus: string | null }>;
    };
    expect(body.role).toBe('owner');
    expect(body.organizations).toHaveLength(1);
    expect(body.organizations[0]!.id).toBe(orgA.organizationId);
    expect(body.organizations[0]!.role).toBe('owner');
    expect(body.organizations[0]!.memberCount).toBe(1);
    // Evaluation mode: no billing_subscriptions row yet.
    expect(body.organizations[0]!.subscriptionStatus).toBeNull();
  });

  it('GET /api/me reflects a billing_subscriptions row in the organizations list', async () => {
    await db.insert(schema.billingSubscriptions).values({
      organizationId: orgA.organizationId,
      providerCustomerId: 'ctm_me',
      providerSubscriptionId: 'sub_me',
      status: 'PAST_DUE',
    });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: orgA.cookie } });
      const body = response.json() as { organizations: Array<{ id: string; subscriptionStatus: string | null }> };
      const row = body.organizations.find((o) => o.id === orgA.organizationId);
      expect(row?.subscriptionStatus).toBe('PAST_DUE');
    } finally {
      await db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.organizationId, orgA.organizationId));
    }
  });

  it('POST /api/organizations creates a new org, makes the caller owner, and switches the active tenant', async () => {
    const response = await postJson(app, '/api/organizations', { name: 'Second Org' }, { cookie: orgA.cookie });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; name: string; role: string; memberCount: number };
    expect(body.name).toBe('Second Org');
    expect(body.role).toBe('owner');
    expect(body.memberCount).toBe(1);
    secondOrgId = body.id;

    const activeResponse = await app.inject({
      method: 'GET',
      url: '/api/organization',
      headers: { cookie: orgA.cookie },
    });
    expect((activeResponse.json() as { id: string }).id).toBe(secondOrgId);
  });

  it('GET /api/organizations lists every organization the caller belongs to', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/organizations',
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { organizations: Array<{ id: string }> };
    expect(body.organizations.map((o) => o.id).sort()).toEqual(
      [orgA.organizationId, secondOrgId].sort(),
    );
  });

  it('POST /api/organizations/:id/activate switches the active tenant back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgA.organizationId}/activate`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { id: string }).id).toBe(orgA.organizationId);
  });

  it('switching to an organization the caller is NOT a member of returns 404 (isolation)', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/api/organizations/${orgB.organizationId}/activate`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── GET/PATCH /api/organization: role permission matrix ────────────────────
describe('GET/PATCH /api/organization — role permissions', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let memberUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `settings-owner-${crypto.randomUUID()}@example.com`);
    adminUser = await signUpAndGetOrg(auth, db, `settings-admin-${crypto.randomUUID()}@example.com`);
    memberUser = await signUpAndGetOrg(auth, db, `settings-member-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, adminUser.userId, 'admin');
    await addMember(db, owner.organizationId, memberUser.userId, 'member');
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('GET /api/organization reports the caller role for owner/admin/member', async () => {
    for (const [actor, role] of [
      [owner, 'owner'],
      [adminUser, 'admin'],
      [memberUser, 'member'],
    ] as const) {
      const response = await app.inject({
        method: 'GET',
        url: '/api/organization',
        headers: { cookie: actor.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { role: string }).role).toBe(role);
    }
  });

  it('a plain member cannot rename the organization (403 INSUFFICIENT_ROLE)', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      '/api/organization',
      { name: 'Member Rename Attempt' },
      { cookie: memberUser.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('an admin can rename the organization', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      '/api/organization',
      { name: 'Admin Renamed Org' },
      { cookie: adminUser.cookie },
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('Admin Renamed Org');
  });

  it('the owner can rename the organization', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      '/api/organization',
      { name: 'Owner Renamed Org' },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as { name: string }).name).toBe('Owner Renamed Org');
  });

  it('records an organization.updated audit row for each successful rename', async () => {
    const rows = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.organizationId, owner.organizationId),
          eq(schema.eventLogs.eventType, 'organization.updated'),
        ),
      );
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.requestedState).sort()).toEqual(
      ['Admin Renamed Org', 'Owner Renamed Org'].sort(),
    );
    expect(rows.every((r) => r.actorType === 'user')).toBe(true);
  });
});

// ── GET /api/organization/members: shape and ordering ───────────────────────
describe('GET /api/organization/members — shape and ordering', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let memberUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `members-owner-${crypto.randomUUID()}@example.com`);
    memberUser = await signUpAndGetOrg(auth, db, `members-member-${crypto.randomUUID()}@example.com`);
    adminUser = await signUpAndGetOrg(auth, db, `members-admin-${crypto.randomUUID()}@example.com`);
    // Inserted member-before-admin on purpose: the response order must come
    // from role rank, never from insertion/creation order.
    await addMember(db, owner.organizationId, memberUser.userId, 'member');
    await addMember(db, owner.organizationId, adminUser.userId, 'admin');
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('returns owner, admin, member in that order with the documented shape', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/organization/members',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      members: Array<{ id: string; userId: string; name: string; email: string; role: string; createdAt: string }>;
    };
    expect(body.members.map((m) => m.role)).toEqual(['owner', 'admin', 'member']);
    expect(body.members[0]!.userId).toBe(owner.userId);
    expect(body.members[1]!.userId).toBe(adminUser.userId);
    expect(body.members[2]!.userId).toBe(memberUser.userId);
    expect(body.members[2]!.email).toBe(memberUser.email);
    for (const member of body.members) {
      expect(typeof member.id).toBe('string');
      expect(typeof member.createdAt).toBe('string');
    }
  });
});

// ── Invitations: create/duplicate/already-member/permission/resend/revoke ──
describe('Invitations — create, duplicate, permission, resend, revoke', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let memberUser: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let sentEmails: EmailMessage[];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `invite-owner-${crypto.randomUUID()}@example.com`);
    memberUser = await signUpAndGetOrg(auth, db, `invite-member-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, memberUser.userId, 'member');
    const recorder = createRecordingEmailSender();
    sentEmails = recorder.sentEmails;
    app = await buildServer({ auth, db, emailSender: recorder.emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(() => {
    sentEmails.length = 0;
  });

  it('creates a pending invitation, sends email, and records audit (201)', async () => {
    const email = `invitee-${crypto.randomUUID()}@example.com`;
    const response = await postJson(app, '/api/organization/invitations', { email, role: 'member' }, { cookie: owner.cookie });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { id: string; email: string; role: string; status: string; expired: boolean };
    expect(body.email).toBe(email);
    expect(body.role).toBe('member');
    expect(body.status).toBe('pending');
    expect(body.expired).toBe(false);

    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(email);
    expect(sentEmails[0]!.subject).toContain(owner.name);
    expect(sentEmails[0]!.body).toContain(body.id);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.organizationId, owner.organizationId),
          eq(schema.eventLogs.eventType, 'member.invited'),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.actorId).toBe(owner.userId);
  });

  it('a duplicate pending invitation to the same email returns 409 ALREADY_INVITED', async () => {
    const email = `dup-${crypto.randomUUID()}@example.com`;
    const first = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    expect(first.statusCode).toBe(201);

    const second = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    expect(second.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(second.json()).error.code).toBe('ALREADY_INVITED');
  });

  it('inviting an existing member returns 409 ALREADY_MEMBER', async () => {
    const response = await postJson(
      app,
      '/api/organization/invitations',
      { email: memberUser.email },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ALREADY_MEMBER');
  });

  it('a plain member cannot invite (403)', async () => {
    const response = await postJson(
      app,
      '/api/organization/invitations',
      { email: `blocked-${crypto.randomUUID()}@example.com` },
      { cookie: memberUser.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('resend refreshes expiresAt and re-sends the email', async () => {
    const email = `resend-${crypto.randomUUID()}@example.com`;
    const created = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (created.json() as { id: string }).id;
    const [before] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));

    sentEmails.length = 0;
    const response = await app.inject({
      method: 'POST',
      url: `/api/organization/invitations/${invitationId}/resend`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(200);

    const [after] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));
    expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]!.to).toBe(email);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'member.invitation.resent'));
    expect(events.some((e) => e.actorId === owner.userId)).toBe(true);
  });

  it('a plain member cannot resend or revoke (403)', async () => {
    const email = `resend-blocked-${crypto.randomUUID()}@example.com`;
    const created = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (created.json() as { id: string }).id;

    const resend = await app.inject({
      method: 'POST',
      url: `/api/organization/invitations/${invitationId}/resend`,
      headers: { cookie: memberUser.cookie },
    });
    expect(resend.statusCode).toBe(403);

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/organization/invitations/${invitationId}`,
      headers: { cookie: memberUser.cookie },
    });
    expect(revoke.statusCode).toBe(403);
  });

  it('revoke sets status canceled (204), then accepting it returns 409 INVITATION_NOT_PENDING', async () => {
    const email = `revoke-${crypto.randomUUID()}@example.com`;
    const created = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (created.json() as { id: string }).id;

    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/organization/invitations/${invitationId}`,
      headers: { cookie: owner.cookie },
    });
    expect(revoke.statusCode).toBe(204);
    const [row] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));
    expect(row!.status).toBe('canceled');

    const invitee = await signUpAndGetOrg(auth, db, email);
    const accept = await postJson(app, `/api/invitations/${invitationId}/accept`, {}, { cookie: invitee.cookie });
    expect(accept.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(accept.json()).error.code).toBe('INVITATION_NOT_PENDING');
  });
});

// ── Invitations: expiry and reissue ─────────────────────────────────────────
describe('Invitations — expiry and reissue', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `expiry-owner-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('an expired invitation reports status "expired" publicly and 410s on accept', async () => {
    const email = `expired-${crypto.randomUUID()}@example.com`;
    const created = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (created.json() as { id: string }).id;

    // Push expiresAt into the past directly — the API never lets a caller do
    // this, so the only way to test it is to write the row ourselves.
    await db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitation.id, invitationId));

    const publicView = await app.inject({ method: 'GET', url: `/api/invitations/${invitationId}` });
    expect(publicView.statusCode).toBe(200);
    expect((publicView.json() as { status: string }).status).toBe('expired');

    const invitee = await signUpAndGetOrg(auth, db, email);
    const accept = await postJson(app, `/api/invitations/${invitationId}/accept`, {}, { cookie: invitee.cookie });
    expect(accept.statusCode).toBe(410);
    expect(errorEnvelopeSchema.parse(accept.json()).error.code).toBe('INVITATION_EXPIRED');
  });

  it('re-inviting the same email after expiry reissues the same invitation rather than rejecting it', async () => {
    const email = `reissue-${crypto.randomUUID()}@example.com`;
    const created = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (created.json() as { id: string }).id;
    await db
      .update(schema.invitation)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.invitation.id, invitationId));

    const reissued = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    expect(reissued.statusCode).toBe(201);
    const body = reissued.json() as { id: string; status: string; expired: boolean };
    expect(body.id).toBe(invitationId);
    expect(body.status).toBe('pending');
    expect(body.expired).toBe(false);

    const [row] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

// ── Invitations: accept/reject across accounts ──────────────────────────────
describe('Invitations — accept/reject (cross-account)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let sentEmails: EmailMessage[];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `accept-owner-${crypto.randomUUID()}@example.com`);
    const recorder = createRecordingEmailSender();
    sentEmails = recorder.sentEmails;
    app = await buildServer({ auth, db, emailSender: recorder.emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('accepting with a different signed-in email than the invite returns 404', async () => {
    const email = `correct-${crypto.randomUUID()}@example.com`;
    const invite = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (invite.json() as { id: string }).id;

    const wrongUser = await signUpAndGetOrg(auth, db, `wrong-${crypto.randomUUID()}@example.com`);
    const response = await postJson(app, `/api/invitations/${invitationId}/accept`, {}, { cookie: wrongUser.cookie });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('the correct invitee accepts, joins, switches the active org, and the inviter gets an email', async () => {
    const email = `join-${crypto.randomUUID()}@example.com`;
    const invite = await postJson(app, '/api/organization/invitations', { email, role: 'member' }, { cookie: owner.cookie });
    const invitationId = (invite.json() as { id: string }).id;

    sentEmails.length = 0;
    const invitee = await signUpAndGetOrg(auth, db, email);
    const accept = await postJson(app, `/api/invitations/${invitationId}/accept`, {}, { cookie: invitee.cookie });
    expect(accept.statusCode).toBe(200);
    const body = accept.json() as { id: string; role: string };
    expect(body.id).toBe(owner.organizationId);
    expect(body.role).toBe('member'); // OrganizationSummary.role reflects the ACCEPTING invitee, not the inviter

    const following = await app.inject({
      method: 'GET',
      url: '/api/organization',
      headers: { cookie: invitee.cookie },
    });
    expect(following.statusCode).toBe(200);
    expect((following.json() as { id: string; role: string }).id).toBe(owner.organizationId);
    expect((following.json() as { id: string; role: string }).role).toBe('member');

    const membershipRows = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, invitee.userId)));
    expect(membershipRows).toHaveLength(1);

    expect(sentEmails.some((e) => e.to === owner.email)).toBe(true);

    const auditRows = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(
          eq(schema.eventLogs.eventType, 'member.invitation.accepted'),
          eq(schema.eventLogs.organizationId, owner.organizationId),
        ),
      );
    expect(auditRows.some((r) => r.actorId === invitee.userId)).toBe(true);
  });

  it('reject sets status rejected (204)', async () => {
    const email = `reject-${crypto.randomUUID()}@example.com`;
    const invite = await postJson(app, '/api/organization/invitations', { email }, { cookie: owner.cookie });
    const invitationId = (invite.json() as { id: string }).id;

    const rejecter = await signUpAndGetOrg(auth, db, email);
    const response = await postJson(app, `/api/invitations/${invitationId}/reject`, {}, { cookie: rejecter.cookie });
    expect(response.statusCode).toBe(204);

    const [row] = await db.select().from(schema.invitation).where(eq(schema.invitation.id, invitationId));
    expect(row!.status).toBe('rejected');

    const auditRows = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'member.invitation.rejected'));
    expect(auditRows.some((r) => r.actorId === rejecter.userId)).toBe(true);
  });
});

// ── Member role change: permissions and safeguards ──────────────────────────
describe('PATCH /api/organization/members/:memberId — permissions and safeguards', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminB: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let memberY: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let otherOrgMember: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let ownerMembershipId: string;
  let adminAMembershipId: string;
  let adminBMembershipId: string;
  let memberYMembershipId: string;
  let otherOrgMembershipId: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `role-owner-${crypto.randomUUID()}@example.com`);
    adminA = await signUpAndGetOrg(auth, db, `role-admin-a-${crypto.randomUUID()}@example.com`);
    adminB = await signUpAndGetOrg(auth, db, `role-admin-b-${crypto.randomUUID()}@example.com`);
    memberY = await signUpAndGetOrg(auth, db, `role-member-y-${crypto.randomUUID()}@example.com`);
    otherOrgMember = await signUpAndGetOrg(auth, db, `role-other-org-${crypto.randomUUID()}@example.com`);

    adminAMembershipId = await addMember(db, owner.organizationId, adminA.userId, 'admin');
    adminBMembershipId = await addMember(db, owner.organizationId, adminB.userId, 'admin');
    memberYMembershipId = await addMember(db, owner.organizationId, memberY.userId, 'member');
    const [otherOrgRow] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, otherOrgMember.userId));
    otherOrgMembershipId = otherOrgRow!.id;
    const [ownerRow] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, owner.userId)));
    ownerMembershipId = ownerRow!.id;

    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('an admin can promote a member to admin, and the owner can demote them back', async () => {
    const promote = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${memberYMembershipId}`,
      { role: 'admin' },
      { cookie: adminA.cookie },
    );
    expect(promote.statusCode).toBe(200);
    expect((promote.json() as { role: string }).role).toBe('admin');

    // memberY is an admin now, so adminA can no longer touch them — the
    // owner demotes them back.
    const demote = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${memberYMembershipId}`,
      { role: 'member' },
      { cookie: owner.cookie },
    );
    expect(demote.statusCode).toBe(200);
    expect((demote.json() as { role: string }).role).toBe('member');

    const auditRows = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'member.role.changed'));
    expect(auditRows.length).toBeGreaterThanOrEqual(2);
  });

  it('changing your own role returns 403 SELF_ROLE_CHANGE', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${adminAMembershipId}`,
      { role: 'member' },
      { cookie: adminA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('SELF_ROLE_CHANGE');
  });

  it('changing the owner returns 403 OWNER_ROLE_LOCKED', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${ownerMembershipId}`,
      { role: 'member' },
      { cookie: adminA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('OWNER_ROLE_LOCKED');
  });

  it('an admin changing another admin returns 403 INSUFFICIENT_ROLE', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${adminBMembershipId}`,
      { role: 'member' },
      { cookie: adminA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('a member id from another organization returns 404 (isolation)', async () => {
    const response = await sendJson(
      app,
      'PATCH',
      `/api/organization/members/${otherOrgMembershipId}`,
      { role: 'admin' },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── Remove member: permissions, safeguards, and immediate access loss ──────
describe('DELETE /api/organization/members/:memberId — permissions, safeguards, immediate access loss', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminB: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let removableMember: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let otherOrgMember: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let ownerMembershipId: string;
  let adminAMembershipId: string;
  let adminBMembershipId: string;
  let removableMembershipId: string;
  let otherOrgMembershipId: string;
  let sentEmails: EmailMessage[];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `remove-owner-${crypto.randomUUID()}@example.com`);
    adminA = await signUpAndGetOrg(auth, db, `remove-admin-a-${crypto.randomUUID()}@example.com`);
    adminB = await signUpAndGetOrg(auth, db, `remove-admin-b-${crypto.randomUUID()}@example.com`);
    removableMember = await signUpAndGetOrg(auth, db, `remove-member-${crypto.randomUUID()}@example.com`);
    otherOrgMember = await signUpAndGetOrg(auth, db, `remove-other-org-${crypto.randomUUID()}@example.com`);

    adminAMembershipId = await addMember(db, owner.organizationId, adminA.userId, 'admin');
    adminBMembershipId = await addMember(db, owner.organizationId, adminB.userId, 'admin');
    removableMembershipId = await addMember(db, owner.organizationId, removableMember.userId, 'member');
    const [otherRow] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(eq(schema.member.userId, otherOrgMember.userId));
    otherOrgMembershipId = otherRow!.id;
    const [ownerRow] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, owner.userId)));
    ownerMembershipId = ownerRow!.id;

    const recorder = createRecordingEmailSender();
    sentEmails = recorder.sentEmails;
    app = await buildServer({ auth, db, emailSender: recorder.emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('an admin removes a member: the membership is gone, the target session loses this org immediately, and it is audited/emailed', async () => {
    sentEmails.length = 0;
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/organization/members/${removableMembershipId}`,
      headers: { cookie: adminA.cookie },
    });
    expect(response.statusCode).toBe(204);

    const rows = await db.select().from(schema.member).where(eq(schema.member.id, removableMembershipId));
    expect(rows).toHaveLength(0);

    // The removed member's own personal org (from signup) is what they now
    // land on — the SAME cookie must never resolve the org they lost.
    const following = await app.inject({
      method: 'GET',
      url: '/api/organization',
      headers: { cookie: removableMember.cookie },
    });
    expect(following.statusCode).toBe(200);
    expect((following.json() as { id: string }).id).not.toBe(owner.organizationId);

    expect(sentEmails.some((e) => e.to === removableMember.email)).toBe(true);

    const auditRows = await db
      .select()
      .from(schema.eventLogs)
      .where(
        and(eq(schema.eventLogs.eventType, 'member.removed'), eq(schema.eventLogs.organizationId, owner.organizationId)),
      );
    expect(auditRows.some((r) => r.actorId === adminA.userId)).toBe(true);
  });

  it('removing yourself returns 403 SELF_REMOVAL', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/organization/members/${adminAMembershipId}`,
      headers: { cookie: adminA.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('SELF_REMOVAL');
  });

  it('removing the owner returns 403 LAST_OWNER', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/organization/members/${ownerMembershipId}`,
      headers: { cookie: adminA.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('LAST_OWNER');
  });

  it('an admin removing another admin returns 403 INSUFFICIENT_ROLE', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/organization/members/${adminBMembershipId}`,
      headers: { cookie: adminA.cookie },
    });
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('a cross-org member id returns 404 (isolation)', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/organization/members/${otherOrgMembershipId}`,
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── Leave organization ───────────────────────────────────────────────────────
describe('POST /api/organization/leave', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let adminA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let memberX: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    owner = await signUpAndGetOrg(auth, db, `leave-owner-${crypto.randomUUID()}@example.com`);
    adminA = await signUpAndGetOrg(auth, db, `leave-admin-${crypto.randomUUID()}@example.com`);
    memberX = await signUpAndGetOrg(auth, db, `leave-member-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, adminA.userId, 'admin');
    await addMember(db, owner.organizationId, memberX.userId, 'member');
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('a member can leave', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/organization/leave',
      headers: { cookie: memberX.cookie },
    });
    expect(response.statusCode).toBe(204);
    const rows = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, memberX.userId)));
    expect(rows).toHaveLength(0);

    const auditRows = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, 'member.left'));
    expect(auditRows.some((r) => r.actorId === memberX.userId)).toBe(true);
  });

  it('an admin can leave', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/organization/leave',
      headers: { cookie: adminA.cookie },
    });
    expect(response.statusCode).toBe(204);
    const rows = await db
      .select()
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, adminA.userId)));
    expect(rows).toHaveLength(0);
  });

  it('the owner gets 409 LAST_OWNER', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/organization/leave',
      headers: { cookie: owner.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('LAST_OWNER');
  });
});

// ── Transfer ownership ───────────────────────────────────────────────────────
describe('POST /api/organization/transfer-ownership', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('owner -> member: afterwards the old owner is admin and the new one is owner (exactly one owner)', async () => {
    const owner = await signUpAndGetOrg(auth, db, `transfer-owner-${crypto.randomUUID()}@example.com`);
    const memberUser = await signUpAndGetOrg(auth, db, `transfer-member-${crypto.randomUUID()}@example.com`);
    const memberMembershipId = await addMember(db, owner.organizationId, memberUser.userId, 'member');

    const response = await postJson(
      app,
      '/api/organization/transfer-ownership',
      { memberId: memberMembershipId },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(204);

    const members = await db.select().from(schema.member).where(eq(schema.member.organizationId, owner.organizationId));
    const owners = members.filter((m) => m.role === 'owner');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.userId).toBe(memberUser.userId);
    const oldOwnerRow = members.find((m) => m.userId === owner.userId);
    expect(oldOwnerRow!.role).toBe('admin');

    const auditRows = await db
      .select()
      .from(schema.eventLogs)
      .where(eq(schema.eventLogs.eventType, 'organization.ownership.transferred'));
    expect(auditRows.some((r) => r.actorId === owner.userId)).toBe(true);
  });

  it('a non-owner caller gets 403', async () => {
    const owner = await signUpAndGetOrg(auth, db, `transfer-nonowner-owner-${crypto.randomUUID()}@example.com`);
    const adminA = await signUpAndGetOrg(auth, db, `transfer-nonowner-admin-${crypto.randomUUID()}@example.com`);
    const memberUser = await signUpAndGetOrg(auth, db, `transfer-nonowner-member-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, adminA.userId, 'admin');
    const memberMembershipId = await addMember(db, owner.organizationId, memberUser.userId, 'member');

    const response = await postJson(
      app,
      '/api/organization/transfer-ownership',
      { memberId: memberMembershipId },
      { cookie: adminA.cookie },
    );
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('transferring to yourself returns 400 ALREADY_OWNER', async () => {
    const owner = await signUpAndGetOrg(auth, db, `transfer-self-owner-${crypto.randomUUID()}@example.com`);
    const [ownerRow] = await db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, owner.organizationId), eq(schema.member.userId, owner.userId)));

    const response = await postJson(
      app,
      '/api/organization/transfer-ownership',
      { memberId: ownerRow!.id },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ALREADY_OWNER');
  });
});

// ── DELETE /api/organization ────────────────────────────────────────────────
describe('DELETE /api/organization', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let sentEmails: EmailMessage[];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    const recorder = createRecordingEmailSender();
    sentEmails = recorder.sentEmails;
    app = await buildServer({ auth, db, emailSender: recorder.emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('a wrong confirmName returns 400 CONFIRMATION_MISMATCH', async () => {
    const owner = await signUpAndGetOrg(auth, db, `delorg-mismatch-${crypto.randomUUID()}@example.com`);
    const response = await sendJson(app, 'DELETE', '/api/organization', { confirmName: 'not the real name' }, { cookie: owner.cookie });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('CONFIRMATION_MISMATCH');
  });

  it('a non-owner returns 403', async () => {
    const owner = await signUpAndGetOrg(auth, db, `delorg-nonowner-owner-${crypto.randomUUID()}@example.com`);
    const adminA = await signUpAndGetOrg(auth, db, `delorg-nonowner-admin-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, adminA.userId, 'admin');
    const [orgRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, owner.organizationId));

    const response = await sendJson(app, 'DELETE', '/api/organization', { confirmName: orgRow!.name }, { cookie: adminA.cookie });
    expect(response.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
  });

  it('an organization with a HEALTHY deployment returns 409 ORGANIZATION_HAS_ACTIVE_DEPLOYMENTS', async () => {
    const owner = await signUpAndGetOrg(auth, db, `delorg-active-${crypto.randomUUID()}@example.com`);
    const application = await insertApplication(db, owner.organizationId);
    const customer = await insertCustomer(db, owner.organizationId);
    await insertDeployment(db, owner.organizationId, application.id, customer.id, { state: 'HEALTHY' });
    const [orgRow] = await db.select().from(schema.organization).where(eq(schema.organization.id, owner.organizationId));

    const response = await sendJson(app, 'DELETE', '/api/organization', { confirmName: orgRow!.name }, { cookie: owner.cookie });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ORGANIZATION_HAS_ACTIVE_DEPLOYMENTS');
  });

  it('a clean organization deletes and takes its applications/customers with it, leaves event_logs intact, and clears activeOrganizationId on sessions', async () => {
    const owner = await signUpAndGetOrg(auth, db, `delorg-clean-owner-${crypto.randomUUID()}@example.com`);

    // Use the real creation route so an organization.created audit row
    // exists to check against after deletion.
    const created = await postJson(app, '/api/organizations', { name: 'Deletable Org' }, { cookie: owner.cookie });
    const orgId = (created.json() as { id: string }).id;
    const application = await insertApplication(db, orgId);
    const customer = await insertCustomer(db, orgId);
    // A removed, fully purged deployment must not block deletion.
    const deployment = await insertDeployment(db, orgId, application.id, customer.id, {
      state: 'DELETED',
      cleanupState: 'COMPLETE',
    });
    const [job] = await db
      .insert(schema.deploymentJobs)
      .values({ deploymentId: deployment.id, type: 'INSTALL', idempotencyKey: crypto.randomUUID() })
      .returning();
    // A deployment_stack_events row referencing both the job and the
    // deployment must not block deletion via its FK (no ON DELETE cascade).
    await db.insert(schema.deploymentStackEvents).values({
      deploymentId: deployment.id,
      jobId: job!.id,
      providerEventId: `evt-${crypto.randomUUID()}`,
      eventAt: new Date(),
      logicalResourceId: 'MyResource',
      resourceType: 'AWS::CloudFormation::Stack',
      resourceStatus: 'CREATE_IN_PROGRESS',
    });
    // Billing rows FK to organization (no cascade) — deletion must clear
    // these too, or the organization delete itself would fail.
    await db.insert(schema.billingSubscriptions).values({
      organizationId: orgId,
      providerCustomerId: 'ctm_delorg',
      providerSubscriptionId: 'sub_delorg',
      status: 'ACTIVE',
    });
    await db.insert(schema.billingProviderEvents).values({
      organizationId: orgId,
      providerEventId: `evt-delorg-${crypto.randomUUID()}`,
      eventType: 'subscription.activated',
      occurredAt: new Date(),
    });
    await db.insert(schema.billingReconciliationEvents).values({
      organizationId: orgId,
      expectedDeploymentQuantity: 0,
      action: 'none',
      status: 'SUCCEEDED',
    });

    sentEmails.length = 0;
    const response = await sendJson(app, 'DELETE', '/api/organization', { confirmName: 'Deletable Org' }, { cookie: owner.cookie });
    expect(response.statusCode).toBe(204);

    const orgRows = await db.select().from(schema.organization).where(eq(schema.organization.id, orgId));
    expect(orgRows).toHaveLength(0);
    const appRows = await db.select().from(schema.applications).where(eq(schema.applications.organizationId, orgId));
    expect(appRows).toHaveLength(0);
    const customerRows = await db.select().from(schema.customers).where(eq(schema.customers.organizationId, orgId));
    expect(customerRows).toHaveLength(0);
    const stackEventRows = await db
      .select()
      .from(schema.deploymentStackEvents)
      .where(eq(schema.deploymentStackEvents.deploymentId, deployment.id));
    expect(stackEventRows).toHaveLength(0);
    const subscriptionRows = await db
      .select()
      .from(schema.billingSubscriptions)
      .where(eq(schema.billingSubscriptions.organizationId, orgId));
    expect(subscriptionRows).toHaveLength(0);
    const providerEventRows = await db
      .select()
      .from(schema.billingProviderEvents)
      .where(eq(schema.billingProviderEvents.organizationId, orgId));
    expect(providerEventRows).toHaveLength(0);
    const reconciliationEventRows = await db
      .select()
      .from(schema.billingReconciliationEvents)
      .where(eq(schema.billingReconciliationEvents.organizationId, orgId));
    expect(reconciliationEventRows).toHaveLength(0);

    // event_logs outlives the organization it describes.
    const eventRows = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.organizationId, orgId));
    const eventTypes = eventRows.map((r) => r.eventType);
    expect(eventTypes).toContain('organization.created');
    expect(eventTypes).toContain('organization.deleted');

    const sessionRows = await db.select().from(schema.session).where(eq(schema.session.userId, owner.userId));
    expect(sessionRows.every((s) => s.activeOrganizationId !== orgId)).toBe(true);
  });
});

// ── DELETE /api/account ──────────────────────────────────────────────────────
describe('DELETE /api/account', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('a wrong confirmEmail returns 400 CONFIRMATION_MISMATCH', async () => {
    const user = await signUpAndGetOrg(auth, db, `delacct-mismatch-${crypto.randomUUID()}@example.com`);
    const response = await sendJson(app, 'DELETE', '/api/account', { confirmEmail: 'wrong@example.com' }, { cookie: user.cookie });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('CONFIRMATION_MISMATCH');
  });

  it('owning an organization with other members returns 409 OWNERSHIP_REQUIRED', async () => {
    const owner = await signUpAndGetOrg(auth, db, `delacct-owned-${crypto.randomUUID()}@example.com`);
    const memberUser = await signUpAndGetOrg(auth, db, `delacct-owned-member-${crypto.randomUUID()}@example.com`);
    await addMember(db, owner.organizationId, memberUser.userId, 'member');

    const response = await sendJson(app, 'DELETE', '/api/account', { confirmEmail: owner.email }, { cookie: owner.cookie });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('OWNERSHIP_REQUIRED');
  });

  it('otherwise the user row and their solo organization are gone', async () => {
    const user = await signUpAndGetOrg(auth, db, `delacct-solo-${crypto.randomUUID()}@example.com`);
    const response = await sendJson(app, 'DELETE', '/api/account', { confirmEmail: user.email }, { cookie: user.cookie });
    expect(response.statusCode).toBe(204);

    const userRows = await db.select().from(schema.user).where(eq(schema.user.id, user.userId));
    expect(userRows).toHaveLength(0);
    const orgRows = await db.select().from(schema.organization).where(eq(schema.organization.id, user.organizationId));
    expect(orgRows).toHaveLength(0);

    const auditRows = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.eventType, 'account.deleted'));
    expect(auditRows.some((r) => r.actorId === user.userId)).toBe(true);
  });
});

// ── Every mutating route requires a session ─────────────────────────────────
describe('every mutating organization/invitation/account route returns 401 without a session', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, { emailVerificationFixtureMode: true });
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const id = crypto.randomUUID();
  const routes: Array<[string, string]> = [
    ['POST', '/api/organizations'],
    ['POST', `/api/organizations/${id}/activate`],
    ['PATCH', '/api/organization'],
    ['DELETE', '/api/organization'],
    ['PATCH', `/api/organization/members/${id}`],
    ['DELETE', `/api/organization/members/${id}`],
    ['POST', '/api/organization/leave'],
    ['POST', '/api/organization/transfer-ownership'],
    ['POST', '/api/organization/invitations'],
    ['POST', `/api/organization/invitations/${id}/resend`],
    ['DELETE', `/api/organization/invitations/${id}`],
    ['POST', `/api/invitations/${id}/accept`],
    ['POST', `/api/invitations/${id}/reject`],
    ['DELETE', '/api/account'],
  ];

  it.each(routes)('%s %s returns 401', async (method, url) => {
    const response = await sendJson(app, method as 'POST' | 'PATCH' | 'DELETE', url, {});
    expect(response.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });
});
