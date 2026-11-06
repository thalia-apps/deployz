import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { EmailMessage } from './email.js';
import { buildServer } from './server.js';

// Better Auth over a fresh in-memory PGlite (real Postgres semantics, full
// migrations). Proves the tenant-on-signup hook and the session contract that
// the Fastify layer consumes — no HTTP needed except where the route IS the
// thing under test.
describe('auth (Better Auth over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('signUp by email creates the user AND its vendor tenant (organization + owner membership)', async () => {
    // Given a fresh user payload
    const email = 'ada@example.com';
    // When the user signs up with email/password
    const result = await auth.api.signUpEmail({
      body: { email, password: 'super-secret-1', name: 'Ada' },
    });
    // Then the user exists and exactly one organization + membership point at it
    expect(result.user.email).toBe(email);
    const memberships = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, result.user.id));
    expect(memberships).toHaveLength(1);
    const orgs = await db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, memberships[0]!.organizationId));
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.name).toBe('ada');
    expect(orgs[0]!.slug).toContain('ada-');
    // ...and the signup session itself is already pinned to the tenant (no
    // post-transaction race — provisioning happens in session.create.before).
    const sessions = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, result.token));
    expect(sessions[0]!.activeOrganizationId).toBe(orgs[0]!.id);
  });

  it('signIn by email returns a session token pinned to the tenant', async () => {
    // Given the user above
    // When they sign in with correct credentials
    const result = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
    });
    // Then a token issues and its session carries the active organization
    expect(result.token).toBeTruthy();
    const memberships = await db
      .select()
      .from(schema.member)
      .where(eq(schema.member.userId, result.user.id));
    const sessions = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, result.token));
    expect(sessions[0]!.activeOrganizationId).toBe(memberships[0]!.organizationId);
  });

  it('getSession resolves the session cookie back to the user', async () => {
    // Given a sign-in response whose Set-Cookie we capture (name agnostic)
    const response = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toBeTruthy();
    // When getSession is called with that cookie header
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie! }),
    });
    // Then the session resolves to the signed-in user
    expect(session?.user.email).toBe('ada@example.com');
  });

  // Staging and production share the '.deployz.dev' cookie domain, so the
  // cookie NAME is the only isolation left: a shared name lets a production
  // cookie reach staging and a staging sign-in overwrite production's.
  it('names the session cookie after the configured prefix', async () => {
    const prefixed = createAuth(db, { cookiePrefix: 'deployz-staging' });
    const response = await prefixed.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie?.split('=')[0]).toContain('deployz-staging.session_token');
  });

  // The cookie domain must stay below the customer hostnames, which are
  // d-<id>.deployz.dev. A cookie for .app.deployz.dev never reaches them.
  it('scopes the session cookie to the configured cookie domain', async () => {
    const scoped = createAuth(db, { cookieDomain: '.app.deployz.dev' });
    const response = await scoped.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie).toContain('Domain=.app.deployz.dev');
    expect(cookie).not.toMatch(/Domain=\.?deployz\.dev/);
  });

  it('keeps the default session-cookie name without a prefix', async () => {
    const response = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie?.split('=')[0]).toContain('better-auth.session_token');
  });

  it('rejects a sign-up password shorter than 12 characters', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: 'short@example.com', password: 'eleven-char', name: 'Short' },
      }),
    ).rejects.toThrow();
  });

  it('rejects a wrong password', async () => {
    await expect(
      auth.api.signInEmail({
        body: { email: 'ada@example.com', password: 'wrong-password' },
      }),
    ).rejects.toThrow();
  });

  it('GET /api/me returns 401 without a session and 200 with the user + organization when forwarded a cookie', async () => {
    // Given the Fastify app and a signed-in user cookie
    const app = await buildServer({ auth, db });
    const response = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie')!;
    // When the route is hit without a session
    const anonymous = await app.inject({ method: 'GET', url: '/api/me' });
    expect(anonymous.statusCode).toBe(401);
    // When the route is hit with the session cookie forwarded
    const authenticated = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie },
    });
    expect(authenticated.statusCode).toBe(200);
    const body = authenticated.json() as {
      user: { email: string };
      organization: { slug: string } | null;
    };
    expect(body.user.email).toBe('ada@example.com');
    expect(body.organization?.slug).toContain('ada-');
    await app.close();
  }, 15_000);
});

describe('password reset (Better Auth over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  const sent: EmailMessage[] = [];

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, {
      emailSender: {
        send: async (message) => {
          sent.push(message);
        },
      },
    });
    await auth.api.signUpEmail({
      body: { email: 'grace@example.com', password: 'old-password-1', name: 'Grace' },
    });
    sent.length = 0;
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('answers the same for a known and an unknown address, and mails only the known one', async () => {
    const known = await auth.api.requestPasswordReset({ body: { email: 'grace@example.com' } });
    const unknown = await auth.api.requestPasswordReset({ body: { email: 'nobody@example.com' } });
    expect(unknown).toEqual(known);
    expect(sent.map((message) => message.to)).toEqual(['grace@example.com']);
    expect(sent[0]!.body).toContain('/reset-password?token=');
  });

  it('sets the new password through the mailed token, ends old sessions and rejects the old password', async () => {
    const oldSession = await auth.api.signInEmail({
      body: { email: 'grace@example.com', password: 'old-password-1' },
    });
    const token = new URL(/https?:\/\/\S+/.exec(sent[0]!.body)![0]).searchParams.get('token')!;

    await auth.api.resetPassword({ body: { newPassword: 'new-password-2', token } });

    await expect(
      auth.api.signInEmail({ body: { email: 'grace@example.com', password: 'old-password-1' } }),
    ).rejects.toThrow();
    const fresh = await auth.api.signInEmail({
      body: { email: 'grace@example.com', password: 'new-password-2' },
    });
    expect(fresh.token).toBeTruthy();
    const revoked = await db
      .select()
      .from(schema.session)
      .where(eq(schema.session.token, oldSession.token));
    expect(revoked).toHaveLength(0);
    await expect(
      auth.api.resetPassword({ body: { newPassword: 'third-password-3', token } }),
    ).rejects.toThrow();
  });
});


describe('two-factor sign-in with an emailed code (Better Auth over PGlite)', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  const sent: EmailMessage[] = [];
  const email = 'linus@example.com';
  const password = 'two-factor-pass-1';

  const cookieHeader = (response: Response): string =>
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0])
      .join('; ');
  const lastCode = (): string => /\b(\d{6})\b/.exec(sent.at(-1)!.body)![1]!;
  const userRow = async () =>
    (await db.select().from(schema.user).where(eq(schema.user.email, email)))[0]!;

  async function passwordStep(): Promise<{ body: Record<string, unknown>; cookie: string }> {
    const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
    return { body: (await response.json()) as Record<string, unknown>, cookie: cookieHeader(response) };
  }

  async function sendCode(cookie: string): Promise<string> {
    await auth.api.sendTwoFactorOTP({ headers: new Headers({ cookie }), body: {} });
    return lastCode();
  }

  async function verifyCode(cookie: string, code: string): Promise<Response> {
    return auth.api.verifyTwoFactorOTP({
      headers: new Headers({ cookie }),
      body: { code },
      asResponse: true,
    });
  }

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db, {
      emailSender: {
        send: async (message) => {
          sent.push(message);
        },
      },
    });
    await auth.api.signUpEmail({ body: { email, password, name: 'Linus' } });
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  it('turns on only after the signed-in user enters the emailed code, and stores only a hash of the code', async () => {
    const { body, cookie } = await passwordStep();
    expect(body.twoFactorRedirect).toBeUndefined();

    const code = await sendCode(cookie);
    expect(sent.at(-1)!.to).toBe(email);
    expect(sent.at(-1)!.subject).toBe('Your Deployz sign-in code');
    const stored = await db.select().from(schema.verification);
    expect(stored.some((row) => row.value.includes(code))).toBe(false);
    expect((await userRow()).twoFactorEnabled).toBe(false);

    const verified = await verifyCode(cookie, code);
    expect(verified.status).toBe(200);
    expect((await userRow()).twoFactorEnabled).toBe(true);
  });

  it('turns off the routes that enable 2FA without a code, authenticator apps and backup codes', async () => {
    for (const path of ['enable', 'get-totp-uri', 'verify-totp', 'generate-backup-codes', 'verify-backup-code']) {
      const response = await auth.handler(
        new Request(`http://localhost:3001/api/auth/two-factor/${path}`, { method: 'POST' }),
      );
      expect(response.status, path).toBe(404);
    }
  });

  it('gives no session for the password alone, then a session pinned to the tenant for the right code', async () => {
    const sessionsBefore = await db.select().from(schema.session);
    const { body, cookie } = await passwordStep();
    expect(body.twoFactorRedirect).toBe(true);
    expect(await db.select().from(schema.session)).toHaveLength(sessionsBefore.length);

    const code = await sendCode(cookie);
    expect((await verifyCode(cookie, code === '000000' ? '111111' : '000000')).status).toBe(401);

    const verified = await verifyCode(cookie, code);
    expect(verified.status).toBe(200);
    const { token } = (await verified.json()) as { token: string };
    const sessions = await db.select().from(schema.session).where(eq(schema.session.token, token));
    const memberships = await db.select().from(schema.member).where(eq(schema.member.userId, sessions[0]!.userId));
    expect(sessions[0]!.activeOrganizationId).toBe(memberships[0]!.organizationId);
  });

  it('refuses the right code after 5 wrong codes', async () => {
    const { cookie } = await passwordStep();
    const code = await sendCode(cookie);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await verifyCode(cookie, wrong)).status).toBe(401);
    }
    expect((await verifyCode(cookie, code)).status).toBe(400);
  });

  it('refuses an expired code', async () => {
    const { cookie } = await passwordStep();
    const code = await sendCode(cookie);
    await db.update(schema.verification).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await verifyCode(cookie, code)).status).toBe(400);
  });

  it('turns off only with the right password', async () => {
    const { cookie: twoFactorCookie } = await passwordStep();
    const verified = await verifyCode(twoFactorCookie, await sendCode(twoFactorCookie));
    const headers = new Headers({ cookie: cookieHeader(verified) });

    await expect(
      auth.api.disableTwoFactor({ headers, body: { password: 'wrong-password' } }),
    ).rejects.toThrow();
    expect((await userRow()).twoFactorEnabled).toBe(true);

    await auth.api.disableTwoFactor({ headers, body: { password } });
    expect((await userRow()).twoFactorEnabled).toBe(false);
    const { body } = await passwordStep();
    expect(body.twoFactorRedirect).toBeUndefined();
  });
});
