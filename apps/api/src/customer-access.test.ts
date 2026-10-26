import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import {
  CUSTOMER_CODE_MAX_ATTEMPTS,
  CUSTOMER_CODE_SENDS_PER_HOUR,
  CUSTOMER_FAILED_ATTEMPTS_PER_HOUR,
  CUSTOMER_SESSION_ABSOLUTE_MS,
  CUSTOMER_SESSION_IDLE_MS,
  createCustomerSession,
  customerCookieNames,
  requestCustomerCode,
  resolveCustomerSession,
  verifyCustomerCode,
} from './customer-access.js';
import type { EmailMessage, EmailSender } from './email.js';
import { env } from './env.js';
import { buildServer } from './server.js';

// Customer page access (docs/customer-access.md): email-code sign-in, the
// owner claim, sessions, and who may read or act on /api/install/:id/*.

class CapturingSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }
  lastCode(): string {
    const match = /\b(\d{8})\b/.exec(this.sent.at(-1)?.body ?? '');
    if (!match) throw new Error('no code was sent');
    return match[1]!;
  }
}

async function signUp(auth: Auth, db: Db, email: string): Promise<{ organizationId: string; cookie: string }> {
  const password = 'super-secret-1';
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id))
    .limit(1);
  return { organizationId: membership!.organizationId, cookie: signin.headers.get('set-cookie')! };
}

function setCookies(response: { headers: Record<string, unknown> }): string[] {
  const value = response.headers['set-cookie'];
  return Array.isArray(value) ? (value as string[]) : value ? [String(value)] : [];
}

/** The `name=value` pairs a browser would send back. */
function cookieJar(...responses: Array<{ headers: Record<string, unknown> }>): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const cookie of setCookies(response)) {
      const [pair] = cookie.split(';');
      const [name, value] = pair!.split('=');
      if (value) jar.set(name!, value);
      else jar.delete(name!);
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

describe('customer page access', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let sender: CapturingSender;
  let vendor: { organizationId: string; cookie: string };
  let otherVendor: { organizationId: string; cookie: string };
  let applicationId: string;

  async function seedDeployment(email = `owner-${crypto.randomUUID().slice(0, 8)}@example.com`) {
    const [customer] = await db
      .insert(schema.customers)
      .values({ organizationId: vendor.organizationId, name: 'Owner Co', email })
      .returning();
    const [deployment] = await db
      .insert(schema.deployments)
      .values({
        organizationId: vendor.organizationId,
        applicationId,
        customerId: customer!.id,
        region: 'us-east-1',
        enrollmentCode: crypto.randomUUID(),
      })
      .returning();
    return { deployment: deployment!, customer: customer! };
  }

  function post(url: string, body: unknown, cookie?: string, origin?: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        ...(origin ? { origin } : {}),
      },
      payload: JSON.stringify(body),
    });
  }

  /** Request and verify a code the way the browser does; returns the signed-in cookie. */
  async function signIn(installLinkId: string, email: string): Promise<string> {
    const requested = await post('/api/customer/sign-in/code', { installLinkId, email });
    const verified = await post(
      '/api/customer/sign-in/verify',
      { installLinkId, code: sender.lastCode() },
      cookieJar(requested),
    );
    expect(verified.statusCode, verified.body).toBe(200);
    return cookieJar(requested, verified);
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    vendor = await signUp(auth, db, 'access-vendor@example.com');
    otherVendor = await signUp(auth, db, 'access-other-vendor@example.com');
    const [application] = await db
      .insert(schema.applications)
      .values({
        organizationId: vendor.organizationId,
        name: 'Access App',
        repoFullName: `acme/access-${crypto.randomUUID().slice(0, 8)}`,
        repoUrl: 'https://github.com/acme/access',
        defaultBranch: 'main',
      })
      .returning();
    applicationId = application!.id;
    sender = new CapturingSender();
    app = await buildServer({ auth, db, emailSender: sender });
  }, 60_000);

  beforeEach(() => {
    sender.sent.length = 0;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('shows an anonymous visitor only who sent the link', async () => {
    const { deployment } = await seedDeployment();
    const response = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ signInRequired: true, applicationName: 'Access App', publisherName: expect.any(String) });
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers a code request the same way for any email, and emails only the allowed one', async () => {
    const { deployment, customer } = await seedDeployment();
    const stranger = await post('/api/customer/sign-in/code', {
      installLinkId: deployment.installLinkId,
      email: 'stranger@example.com',
    });
    const unknownLink = await post('/api/customer/sign-in/code', {
      installLinkId: crypto.randomUUID(),
      email: customer.email,
    });
    const owner = await post('/api/customer/sign-in/code', {
      installLinkId: deployment.installLinkId,
      email: ` ${customer.email.toUpperCase()} `,
    });
    for (const response of [stranger, unknownLink, owner]) {
      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ accepted: true });
    }
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.to).toBe(customer.email);
    const [stored] = await db
      .select()
      .from(schema.customerEmailChallenges)
      .where(eq(schema.customerEmailChallenges.deploymentId, deployment.id));
    expect(stored!.codeHmac).not.toContain(sender.lastCode());
  });

  it('signs the owner in, claims the deployment, and sets a session cookie for the browser that asked', async () => {
    const { deployment, customer } = await seedDeployment();
    const cookie = await signIn(deployment.installLinkId, customer.email);
    expect(cookie).toContain(`${customerCookieNames().session}=`);

    const [owner] = await db
      .select()
      .from(schema.deploymentOwners)
      .where(eq(schema.deploymentOwners.deploymentId, deployment.id));
    expect(owner!.email).toBe(customer.email);

    const page = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: { cookie } });
    const body = page.json() as Record<string, unknown>;
    expect(body['viewer']).toEqual({ kind: 'customer', email: customer.email });
    for (const route of ['status', 'overview']) {
      const read = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/${route}`, headers: { cookie } });
      expect(read.statusCode, read.body).toBe(200);
    }
    const events = await db.select().from(schema.eventLogs).where(eq(schema.eventLogs.deploymentId, deployment.id));
    expect(events.map((event) => event.eventType)).toEqual(
      expect.arrayContaining(['customer.owner_claimed', 'customer.signed_in']),
    );
    expect(JSON.stringify(events)).not.toContain(customer.email);
  });

  it('refuses a code from another browser flow, a reused code, and a wrong code', async () => {
    const { deployment, customer } = await seedDeployment();
    const requested = await post('/api/customer/sign-in/code', {
      installLinkId: deployment.installLinkId,
      email: customer.email,
    });
    const code = sender.lastCode();
    const otherBrowser = await post('/api/customer/sign-in/verify', { installLinkId: deployment.installLinkId, code }, `${customerCookieNames().flow}=forged`);
    expect(otherBrowser.statusCode).toBe(400);
    const noFlow = await post('/api/customer/sign-in/verify', { installLinkId: deployment.installLinkId, code });
    expect(noFlow.statusCode).toBe(400);
    const wrong = await post(
      '/api/customer/sign-in/verify',
      { installLinkId: deployment.installLinkId, code: code === '00000000' ? '00000001' : '00000000' },
      cookieJar(requested),
    );
    expect(wrong.statusCode).toBe(400);
    expect((wrong.json() as { error: { code: string } }).error.code).toBe('INVALID_CODE');
    const right = await post('/api/customer/sign-in/verify', { installLinkId: deployment.installLinkId, code }, cookieJar(requested));
    expect(right.statusCode).toBe(200);
    const reused = await post('/api/customer/sign-in/verify', { installLinkId: deployment.installLinkId, code }, cookieJar(requested));
    expect(reused.statusCode).toBe(400);
  });

  it('rejects a sign-in request from another site', async () => {
    const { deployment, customer } = await seedDeployment();
    const response = await post(
      '/api/customer/sign-in/code',
      { installLinkId: deployment.installLinkId, email: customer.email },
      undefined,
      'https://evil.example.com',
    );
    expect(response.statusCode).toBe(403);
    expect(sender.sent).toHaveLength(0);
  });

  it('locks a challenge after the attempt limit, and a new challenge does not reset the hourly budget', async () => {
    const { deployment, customer } = await seedDeployment();
    const now = new Date();
    const flowToken = 'flow-a';
    await requestCustomerCode(db, sender, {
      deployment,
      applicationName: 'Access App',
      publisherName: 'Vendor',
      email: customer.email,
      flowToken,
      now,
    });
    const code = sender.lastCode();
    const wrong = code === '11111111' ? '22222222' : '11111111';
    for (let attempt = 0; attempt < CUSTOMER_CODE_MAX_ATTEMPTS; attempt += 1) {
      expect(await verifyCustomerCode(db, { deploymentId: deployment.id, code: wrong, flowToken, now })).toEqual({
        ok: false,
        reason: 'INVALID_CODE',
      });
    }
    expect(await verifyCustomerCode(db, { deploymentId: deployment.id, code, flowToken, now })).toEqual({
      ok: false,
      reason: 'TOO_MANY_ATTEMPTS',
    });

    // A fresh challenge (after the resend cooldown) still counts the earlier guesses.
    const later = new Date(now.getTime() + 2 * 60 * 1000);
    await requestCustomerCode(db, sender, {
      deployment,
      applicationName: 'Access App',
      publisherName: 'Vendor',
      email: customer.email,
      flowToken: 'flow-b',
      now: later,
    });
    const second = sender.lastCode();
    const secondWrong = second === '11111111' ? '22222222' : '11111111';
    for (let attempt = 0; attempt < CUSTOMER_FAILED_ATTEMPTS_PER_HOUR - CUSTOMER_CODE_MAX_ATTEMPTS; attempt += 1) {
      await verifyCustomerCode(db, { deploymentId: deployment.id, code: secondWrong, flowToken: 'flow-b', now: later });
    }
    expect(await verifyCustomerCode(db, { deploymentId: deployment.id, code: second, flowToken: 'flow-b', now: later })).toEqual({
      ok: false,
      reason: 'TOO_MANY_ATTEMPTS',
    });
  });

  it('enforces the resend cooldown, the hourly send budget, and code expiry', async () => {
    const { deployment, customer } = await seedDeployment();
    const start = new Date();
    const send = (minutes: number, flowToken = 'flow') =>
      requestCustomerCode(db, sender, {
        deployment,
        applicationName: 'Access App',
        publisherName: 'Vendor',
        email: customer.email,
        flowToken,
        now: new Date(start.getTime() + minutes * 60 * 1000),
      });
    expect((await send(0)).sent).toBe(true);
    expect((await send(0.5)).sent).toBe(false);
    for (let index = 1; index < CUSTOMER_CODE_SENDS_PER_HOUR; index += 1) {
      expect((await send(index * 2)).sent).toBe(true);
    }
    expect((await send(CUSTOMER_CODE_SENDS_PER_HOUR * 2)).sent).toBe(false);
    // A code older than ten minutes is refused.
    const code = sender.lastCode();
    expect(
      await verifyCustomerCode(db, {
        deploymentId: deployment.id,
        code,
        flowToken: 'flow',
        now: new Date(start.getTime() + 30 * 60 * 1000),
      }),
    ).toEqual({ ok: false, reason: 'INVALID_CODE' });
  });

  it('expires a session after the idle limit and after the absolute limit', async () => {
    const start = new Date();
    const { token } = await createCustomerSession(db, 'idle@example.com', start);
    const cookie = `${customerCookieNames().session}=${token}`;
    expect(await resolveCustomerSession(db, cookie, new Date(start.getTime() + 60 * 1000))).not.toBeNull();
    expect(await resolveCustomerSession(db, cookie, new Date(start.getTime() + 60 * 1000 + CUSTOMER_SESSION_IDLE_MS + 1000))).toBeNull();

    const { token: active } = await createCustomerSession(db, 'active@example.com', start);
    const activeCookie = `${customerCookieNames().session}=${active}`;
    let at = start.getTime();
    while (at < start.getTime() + CUSTOMER_SESSION_ABSOLUTE_MS - CUSTOMER_SESSION_IDLE_MS) {
      at += CUSTOMER_SESSION_IDLE_MS / 2;
      expect(await resolveCustomerSession(db, activeCookie, new Date(at))).not.toBeNull();
    }
    expect(await resolveCustomerSession(db, activeCookie, new Date(start.getTime() + CUSTOMER_SESSION_ABSOLUTE_MS + 1))).toBeNull();
  });

  it('keeps the claimed owner when the vendor changes the customer email', async () => {
    const { deployment, customer } = await seedDeployment();
    const cookie = await signIn(deployment.installLinkId, customer.email);
    await db.update(schema.customers).set({ email: 'replacement@example.com' }).where(eq(schema.customers.id, customer.id));

    const owner = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/status`, headers: { cookie } });
    expect(owner.statusCode).toBe(200);
    const replacement = await post('/api/customer/sign-in/code', {
      installLinkId: deployment.installLinkId,
      email: 'replacement@example.com',
    });
    expect(replacement.statusCode).toBe(202);
    expect(sender.sent.filter((message) => message.to === 'replacement@example.com')).toHaveLength(0);
  });

  it('denies another deployment\'s owner, a vendor of another organization, and a signed-out session', async () => {
    const first = await seedDeployment();
    const second = await seedDeployment();
    const firstOwner = await signIn(first.deployment.installLinkId, first.customer.email);

    for (const headers of [{ cookie: firstOwner }, { cookie: otherVendor.cookie }]) {
      for (const route of ['', '/status', '/overview']) {
        const read = await app.inject({ method: 'GET', url: `/api/install/${second.deployment.installLinkId}${route}`, headers });
        if (route === '') expect(read.json()).toMatchObject({ signInRequired: true });
        else expect(read.statusCode).toBe(404);
      }
      const retry = await post(`/api/install/${second.deployment.installLinkId}/retry`, {}, headers.cookie);
      expect(retry.statusCode).toBe(404);
    }

    const signOut = await post('/api/customer/sign-out', { installLinkId: first.deployment.installLinkId }, firstOwner);
    expect(signOut.statusCode).toBe(204);
    const after = await app.inject({ method: 'GET', url: `/api/install/${first.deployment.installLinkId}/status`, headers: { cookie: firstOwner } });
    expect(after.statusCode).toBe(404);
  });

  it('lets a member of the vendor organization open the page', async () => {
    const { deployment } = await seedDeployment();
    const page = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}`, headers: { cookie: vendor.cookie } });
    expect((page.json() as Record<string, unknown>)['viewer']).toEqual({ kind: 'vendor' });
  });

  it('lists only customer-safe activity, newest first', async () => {
    const { deployment, customer } = await seedDeployment();
    const cookie = await signIn(deployment.installLinkId, customer.email);
    await db.insert(schema.eventLogs).values([
      { organizationId: vendor.organizationId, deploymentId: deployment.id, actorType: 'user', actorId: 'u', eventType: 'config.updated' },
      { organizationId: vendor.organizationId, deploymentId: deployment.id, actorType: 'user', actorId: 'u', eventType: 'billing.subscription_activated' },
      { organizationId: vendor.organizationId, deploymentId: deployment.id, actorType: 'relay', actorId: 'r', eventType: 'connector.update_verified' },
    ]);
    const overview = await app.inject({ method: 'GET', url: `/api/install/${deployment.installLinkId}/overview`, headers: { cookie } });
    const body = overview.json() as {
      activity: Array<{ type: string }>;
      connector: { connectivity: string };
      aws: { region: string };
    };
    const types = body.activity.map((item) => item.type);
    expect(types).toContain('config.updated');
    expect(types).toContain('connector.update_verified');
    expect(types).toContain('customer.owner_claimed');
    expect(types).not.toContain('billing.subscription_activated');
    expect(types).not.toContain('customer.signed_in');
    expect(body.connector.connectivity).toBe('NEVER_CONNECTED');
    expect(body.aws.region).toBe('us-east-1');
  });

  it('marks the session cookie HttpOnly and SameSite=Lax', async () => {
    const { deployment, customer } = await seedDeployment();
    const requested = await post('/api/customer/sign-in/code', { installLinkId: deployment.installLinkId, email: customer.email });
    const verified = await post('/api/customer/sign-in/verify', { installLinkId: deployment.installLinkId, code: sender.lastCode() }, cookieJar(requested));
    const session = setCookies(verified).find((cookie) => cookie.startsWith(`${customerCookieNames().session}=`));
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    if (env.cookieDomain) expect(session).toContain(`Domain=${env.cookieDomain}`);
    else expect(session).not.toContain('Domain=');
  });
});
