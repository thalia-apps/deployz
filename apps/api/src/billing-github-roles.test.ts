import { PGlite } from '@electric-sql/pglite';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import { buildServer } from './server.js';

// Billing checkout/portal and the GitHub connection belong to owners and
// admins (docs/product/user-flows.md); a plain member is refused.

async function signUp(
  auth: Auth,
  db: Db,
  email: string,
): Promise<{ userId: string; cookie: string; organizationId: string }> {
  const password = crypto.randomUUID();
  const signup = await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0]! } });
  const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookie = signin.headers.get('set-cookie');
  if (!cookie) throw new Error('no session cookie');
  const [membership] = await db
    .select({ organizationId: schema.member.organizationId })
    .from(schema.member)
    .where(eq(schema.member.userId, signup.user.id));
  return { userId: signup.user.id, cookie, organizationId: membership!.organizationId };
}

async function joinAs(
  db: Db,
  organizationId: string,
  userId: string,
  role: 'admin' | 'member',
): Promise<void> {
  await db.insert(schema.member).values({ id: crypto.randomUUID(), organizationId, userId, role });
  await db
    .update(schema.session)
    .set({ activeOrganizationId: organizationId })
    .where(eq(schema.session.userId, userId));
}

describe('billing and GitHub connection need owner or admin', () => {
  let client: PGlite | undefined;
  let db: Db;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUp>>;
  let admin: Awaited<ReturnType<typeof signUp>>;
  let member: Awaited<ReturnType<typeof signUp>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    const auth = createAuth(db);
    // paddle: null, so a caller who passes the role check gets 503
    // BILLING_DISABLED, never a real Paddle call.
    app = await buildServer({
      auth,
      db,
      paddle: null,
      githubAppInstallUrl: 'https://github.com/apps/deployz-test',
    });
    owner = await signUp(auth, db, `roles-owner-${crypto.randomUUID()}@example.com`);
    admin = await signUp(auth, db, `roles-admin-${crypto.randomUUID()}@example.com`);
    member = await signUp(auth, db, `roles-member-${crypto.randomUUID()}@example.com`);
    await joinAs(db, owner.organizationId, admin.userId, 'admin');
    await joinAs(db, owner.organizationId, member.userId, 'member');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  function post(url: string, cookie: string) {
    return app.inject({
      method: 'POST',
      url,
      headers: { 'content-type': 'application/json', cookie },
      payload: JSON.stringify({}),
    });
  }

  it.each(['/api/billing/checkout', '/api/billing/portal'])('a member gets 403 from %s', async (url) => {
    const response = await post(url, member.cookie);
    expect(response.statusCode).toBe(403);
    const { error } = errorEnvelopeSchema.parse(response.json());
    expect(error.code).toBe('INSUFFICIENT_ROLE');
    expect(error.message).toContain('owner or admin');
  });

  it.each(['/api/billing/checkout', '/api/billing/portal'])('owner and admin pass the role check on %s', async (url) => {
    for (const caller of [owner, admin]) {
      const response = await post(url, caller.cookie);
      expect(response.statusCode).toBe(503);
    }
  });

  it('a member is sent back from GitHub connect and setup with the reason', async () => {
    for (const url of ['/api/github/connect', '/api/github/setup?installation_id=123&state=x']) {
      const response = await app.inject({ method: 'GET', url, headers: { cookie: member.cookie } });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toMatch(/\/dashboard\/applications\?github=forbidden$/);
    }
    const bindings = await db.select().from(schema.githubInstallations);
    expect(bindings).toHaveLength(0);
  });

  it('owner and admin start the GitHub install', async () => {
    for (const caller of [owner, admin]) {
      const response = await app.inject({ method: 'GET', url: '/api/github/connect', headers: { cookie: caller.cookie } });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toContain('https://github.com/apps/deployz-test/installations/new');
    }
  });

  it('the installations list offers the connect link to owners and admins only', async () => {
    const read = async (cookie: string) =>
      (await app.inject({ method: 'GET', url: '/api/github/installations', headers: { cookie } })).json() as {
        connectUrl: string | null;
        canConnect: boolean;
      };
    expect(await read(owner.cookie)).toMatchObject({ canConnect: true });
    expect((await read(admin.cookie)).connectUrl).toMatch(/\/api\/github\/connect$/);
    expect(await read(member.cookie)).toMatchObject({ canConnect: false, connectUrl: null });
  });
});
