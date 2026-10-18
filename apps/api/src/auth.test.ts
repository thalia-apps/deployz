import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
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

  it('keeps the default session-cookie name without a prefix', async () => {
    const response = await auth.api.signInEmail({
      body: { email: 'ada@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    const cookie = response.headers.get('set-cookie');
    expect(cookie?.split('=')[0]).toContain('better-auth.session_token');
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

