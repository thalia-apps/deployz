import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { EmailMessage, EmailSender } from './email.js';
import { buildServer } from './server.js';

// Regression tests for the security audit findings on authentication and
// organizations: DZ-03, DZ-13, DZ-23, DZ-32, DZ-33.

async function signUp(auth: Auth, email: string): Promise<{ userId: string; cookie: string }> {
  const password = crypto.randomUUID();
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie');
  if (!cookie) throw new Error('no session cookie');
  return { userId: signup.user.id, cookie };
}

function send(
  app: FastifyInstance,
  method: 'POST' | 'DELETE' | 'PATCH',
  url: string,
  body: unknown,
  cookie: string,
) {
  return app.inject({
    method,
    url,
    headers: { 'content-type': 'application/json', cookie },
    payload: JSON.stringify(body),
  });
}

async function organizationOf(app: FastifyInstance, cookie: string): Promise<string> {
  const me = (await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json() as {
    organization: { id: string };
  };
  return me.organization.id;
}

function verify(db: Db, userId: string) {
  return db.update(schema.user).set({ emailVerified: true }).where(eq(schema.user.id, userId));
}

describe('organization security', () => {
  let client: PGlite;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  const sent: EmailMessage[] = [];
  const authSent: EmailMessage[] = [];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, {
      emailVerificationFixtureMode: false,
      emailSender: {
        async send(message) {
          authSent.push(message);
        },
      },
    });
    const emailSender: EmailSender = {
      async send(message) {
        sent.push(message);
      },
    };
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('DZ-03: an unverified address cannot list, accept or decline an invitation', async () => {
    const owner = await signUp(auth, `owner-${crypto.randomUUID()}@vendor.example`);
    await verify(db, owner.userId);
    const organizationId = await organizationOf(app, owner.cookie);

    const inviteeEmail = `bob-${crypto.randomUUID()}@acme.example`;
    const invited = await send(app, 'POST', '/api/organization/invitations', { email: inviteeEmail, role: 'admin' }, owner.cookie);
    expect(invited.statusCode).toBe(201);
    const invitationId = (invited.json() as { id: string }).id;

    const squatter = await signUp(auth, inviteeEmail);

    const listed = await app.inject({ method: 'GET', url: '/api/invitations', headers: { cookie: squatter.cookie } });
    expect(listed.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(listed.json()).error.code).toBe('EMAIL_NOT_VERIFIED');

    for (const action of ['accept', 'reject']) {
      const answered = await send(app, 'POST', `/api/invitations/${invitationId}/${action}`, {}, squatter.cookie);
      expect(answered.statusCode).toBe(403);
      expect(errorEnvelopeSchema.parse(answered.json()).error.code).toBe('EMAIL_NOT_VERIFIED');
    }
    const members = await db.select().from(schema.member).where(eq(schema.member.organizationId, organizationId));
    expect(members).toHaveLength(1);

    await verify(db, squatter.userId);
    const accepted = await send(app, 'POST', `/api/invitations/${invitationId}/accept`, {}, squatter.cookie);
    expect(accepted.statusCode).toBe(200);
  });

  it('DZ-03: sign-up sends a verification email', async () => {
    const address = `verify-${crypto.randomUUID()}@vendor.example`;
    await signUp(auth, address);
    const [row] = await db.select().from(schema.user).where(eq(schema.user.email, address));
    expect(row?.emailVerified).toBe(false);
    const mail = authSent.find((message) => message.to === address);
    expect(mail?.body).toContain('/api/auth/verify-email?token=');
  });

  it('DZ-13: an unverified account cannot send or resend invitations', async () => {
    const unverified = await signUp(auth, `unverified-${crypto.randomUUID()}@vendor.example`);
    const mailCount = sent.length;
    const invited = await send(
      app,
      'POST',
      '/api/organization/invitations',
      { email: `victim-${crypto.randomUUID()}@acme.example`, role: 'member' },
      unverified.cookie,
    );
    expect(invited.statusCode).toBe(403);
    expect(errorEnvelopeSchema.parse(invited.json()).error.code).toBe('EMAIL_NOT_VERIFIED');

    const resent = await send(app, 'POST', `/api/organization/invitations/${crypto.randomUUID()}/resend`, {}, unverified.cookie);
    expect(resent.statusCode).toBe(403);
    expect(sent.length).toBe(mailCount);
  });

  it('DZ-13: user-controlled text in the invitation e-mail has no control characters and a capped length', async () => {
    const owner = await signUp(auth, `mailer-${crypto.randomUUID()}@vendor.example`);
    await verify(db, owner.userId);
    const organizationId = await organizationOf(app, owner.cookie);
    await db.update(schema.user).set({ name: `Evil\r\nBcc: x@y.example ${'a'.repeat(500)}` }).where(eq(schema.user.id, owner.userId));
    await db.update(schema.organization).set({ name: 'Org\nName' }).where(eq(schema.organization.id, organizationId));

    const invited = await send(
      app,
      'POST',
      '/api/organization/invitations',
      { email: `target-${crypto.randomUUID()}@acme.example`, role: 'member' },
      owner.cookie,
    );
    expect(invited.statusCode).toBe(201);
    const message = sent.at(-1)!;
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain('Org Name');
    expect(message.subject.length).toBeLessThan(200);
    expect(message.body).not.toContain('Bcc: x@y.example\r');
    expect(message.body.split('\n')[0]!.length).toBeLessThan(250);
  });

  it('DZ-13: invitations are limited per organization per day', async () => {
    const owner = await signUp(auth, `limit-${crypto.randomUUID()}@vendor.example`);
    await verify(db, owner.userId);
    const organizationId = await organizationOf(app, owner.cookie);
    await db.insert(schema.eventLogs).values(
      Array.from({ length: 50 }, () => ({
        actorType: 'user',
        actorId: owner.userId,
        organizationId,
        eventType: 'member.invited',
        payload: {},
      })),
    );

    const invited = await send(
      app,
      'POST',
      '/api/organization/invitations',
      { email: `over-${crypto.randomUUID()}@acme.example`, role: 'member' },
      owner.cookie,
    );
    expect(invited.statusCode).toBe(429);
    expect(errorEnvelopeSchema.parse(invited.json()).error.code).toBe('INVITATION_LIMIT_REACHED');
  });

  it('DZ-33: the public invitation view omits the invitation id and expiry', async () => {
    const owner = await signUp(auth, `public-${crypto.randomUUID()}@vendor.example`);
    await verify(db, owner.userId);
    const invited = await send(
      app,
      'POST',
      '/api/organization/invitations',
      { email: `shown-${crypto.randomUUID()}@acme.example`, role: 'member' },
      owner.cookie,
    );
    const invitationId = (invited.json() as { id: string }).id;
    const view = await app.inject({ method: 'GET', url: `/api/invitations/${invitationId}` });
    expect(view.statusCode).toBe(200);
    expect(Object.keys(view.json() as object).sort()).toEqual([
      'email',
      'inviterName',
      'organizationName',
      'role',
      'status',
    ]);
  });

  it('DZ-23: a member cannot destroy, purge, force-complete, reset the relay or delete an application or customer', async () => {
    const owner = await signUp(auth, `roles-owner-${crypto.randomUUID()}@vendor.example`);
    const member = await signUp(auth, `roles-member-${crypto.randomUUID()}@vendor.example`);
    const organizationId = await organizationOf(app, owner.cookie);
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId,
      userId: member.userId,
      role: 'member',
    });
    await db.update(schema.session).set({ activeOrganizationId: organizationId }).where(eq(schema.session.userId, member.userId));

    const id = crypto.randomUUID();
    const requests: Array<['POST' | 'DELETE', string]> = [
      ['POST', `/api/deployments/${id}/destroy`],
      ['POST', `/api/deployments/${id}/purge`],
      ['POST', `/api/deployments/${id}/disconnect/force-complete`],
      ['POST', `/api/deployments/${id}/relay/reset`],
      ['DELETE', `/api/applications/${id}`],
      ['DELETE', `/api/customers/${id}`],
    ];
    for (const [method, url] of requests) {
      const response = await send(app, method, url, {}, member.cookie);
      expect(response.statusCode, `${method} ${url}`).toBe(403);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSUFFICIENT_ROLE');
    }

    // An owner passes the role check and reaches the (missing) resource.
    const ownerResponse = await send(app, 'DELETE', `/api/applications/${id}`, {}, owner.cookie);
    expect(ownerResponse.statusCode).toBe(404);
  });

  describe('DZ-32: organization deletion', () => {
    async function ownerWithOrganization(): Promise<{ cookie: string; organizationId: string; name: string }> {
      const owner = await signUp(auth, `delete-${crypto.randomUUID()}@vendor.example`);
      const organizationId = await organizationOf(app, owner.cookie);
      const [row] = await db.select().from(schema.organization).where(eq(schema.organization.id, organizationId));
      return { cookie: owner.cookie, organizationId, name: row!.name };
    }

    async function insertApplicationAndCustomer(organizationId: string) {
      const [application] = await db
        .insert(schema.applications)
        .values({
          organizationId,
          name: 'App',
          repoFullName: 'acme/app',
          repoUrl: 'https://github.com/acme/app',
          defaultBranch: 'main',
        })
        .returning();
      const [customer] = await db
        .insert(schema.customers)
        .values({ organizationId, name: 'Customer', email: `c-${crypto.randomUUID()}@example.com` })
        .returning();
      return { application: application!, customer: customer! };
    }

    it('refuses while a removed deployment still has retained resources', async () => {
      const tenant = await ownerWithOrganization();
      const { application, customer } = await insertApplicationAndCustomer(tenant.organizationId);
      await db.insert(schema.deployments).values({
        organizationId: tenant.organizationId,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        state: 'DELETED',
        cleanupState: 'SKIPPED_RELAY_OFFLINE',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
      });

      const response = await send(app, 'DELETE', '/api/organization', { confirmName: tenant.name }, tenant.cookie);
      expect(response.statusCode).toBe(409);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('ORGANIZATION_HAS_UNPURGED_RESOURCES');
    });

    it('removes rows from tables that reference the organization without a cascade', async () => {
      const tenant = await ownerWithOrganization();
      const { application, customer } = await insertApplicationAndCustomer(tenant.organizationId);
      await db.insert(schema.githubInstallations).values({
        id: crypto.randomUUID(),
        organizationId: tenant.organizationId,
        accountLogin: 'acme',
        accountType: 'Organization',
      });
      await db.insert(schema.deployments).values({
        organizationId: tenant.organizationId,
        applicationId: application.id,
        customerId: customer.id,
        region: 'us-east-1',
        state: 'DELETED',
        cleanupState: 'COMPLETE',
        installationId: `inst-${crypto.randomUUID()}`,
        enrollmentCode: crypto.randomUUID(),
      });

      const response = await send(app, 'DELETE', '/api/organization', { confirmName: tenant.name }, tenant.cookie);
      expect(response.statusCode).toBe(204);
      const remaining = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, tenant.organizationId));
      expect(remaining).toHaveLength(0);
      const organizations = await db.select().from(schema.organization).where(eq(schema.organization.id, tenant.organizationId));
      expect(organizations).toHaveLength(0);
    });
  });
});
