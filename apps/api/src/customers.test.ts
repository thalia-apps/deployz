import { PGlite } from '@electric-sql/pglite';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { errorEnvelopeSchema } from '@deployz/contracts';
import { applyMigrations, createDb, type Db } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { createAuth, type Auth } from './auth.js';
import type { EmailMessage, EmailSender } from './email.js';
import { buildServer } from './server.js';

// ── Shared test helpers (matches organizations.test.ts / server.test.ts style) ──

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
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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

// ── POST /api/customers ──────────────────────────────────────────────────
describe('POST /api/customers — create', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let owner: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    owner = await signUpAndGetOrg(auth, db, `customers-create-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('trims whitespace on name/email and stores an empty company as null', async () => {
    const response = await postJson(
      app,
      '/api/customers',
      { name: '  Ada Lovelace  ', email: '  ada@example.com  ', company: '   ' },
      { cookie: owner.cookie },
    );
    expect(response.statusCode).toBe(201);
    const body = response.json() as { name: string; email: string; company: string | null };
    expect(body.name).toBe('Ada Lovelace');
    expect(body.email).toBe('ada@example.com');
    expect(body.company).toBeNull();
  });
});

// ── GET /api/customers/:id ────────────────────────────────────────────────
describe('GET /api/customers/:id — read and isolation', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgB: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, `customers-get-a-${crypto.randomUUID()}@example.com`);
    orgB = await signUpAndGetOrg(auth, db, `customers-get-b-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("returns the customer for its own org", async () => {
    const customer = await insertCustomer(db, orgA.organizationId, { name: 'Acme Co' });
    const response = await app.inject({
      method: 'GET',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { id: string; name: string };
    expect(body.id).toBe(customer.id);
    expect(body.name).toBe('Acme Co');
  });

  it('returns 404 NOT_FOUND, never 403, for a customer belonging to another organization (IDOR guard)', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await app.inject({
      method: 'GET',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });
});

// ── PATCH /api/customers/:id ──────────────────────────────────────────────
describe('PATCH /api/customers/:id — update contact metadata', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgB: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, `customers-patch-a-${crypto.randomUUID()}@example.com`);
    orgB = await signUpAndGetOrg(auth, db, `customers-patch-b-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('updates name, email and company and returns the updated row', async () => {
    const customer = await insertCustomer(db, orgA.organizationId, {
      name: 'Old Name',
      email: 'old@example.com',
      company: 'Old Co',
    });
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: 'New Name', email: 'new@example.com', company: 'New Co' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; email: string; company: string | null };
    expect(body.name).toBe('New Name');
    expect(body.email).toBe('new@example.com');
    expect(body.company).toBe('New Co');
  });

  it('does not change the customer id', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: 'Renamed', email: customer.email },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    expect((response.json() as { id: string }).id).toBe(customer.id);
  });

  it('an existing deployment survives a metadata edit unchanged', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId, {
      name: 'Before Name',
      email: 'before@example.com',
    });
    const deployment = await insertDeployment(db, orgA.organizationId, application.id, customer.id);
    const [before] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));

    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: 'After Name', email: 'after@example.com' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);

    const [after] = await db.select().from(schema.deployments).where(eq(schema.deployments.id, deployment.id));
    // The install link, enrollment code and state are anchored to the
    // deployment id, not the customer's display metadata — none of them may
    // move just because a name/email edit touched the customer row.
    expect(after!.id).toBe(before!.id);
    expect(after!.customerId).toBe(before!.customerId);
    expect(after!.installLinkId).toBe(before!.installLinkId);
    expect(after!.enrollmentCode).toBe(before!.enrollmentCode);
    expect(after!.state).toBe(before!.state);
    expect(after!.updatedAt.getTime()).toBe(before!.updatedAt.getTime());
  });

  it('ignores an id, organizationId or externalReference carried in the body', async () => {
    const customer = await insertCustomer(db, orgA.organizationId, { externalReference: 'ext-1' });
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      {
        id: crypto.randomUUID(),
        organizationId: orgB.organizationId,
        externalReference: 'ext-hacked',
        name: 'Whatever',
        email: 'whatever@example.com',
      },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    const [row] = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
    expect(row!.id).toBe(customer.id);
    expect(row!.organizationId).toBe(orgA.organizationId);
    expect(row!.externalReference).toBe('ext-1');
  });

  it('rejects an empty name (400 VALIDATION_ERROR)', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: '   ', email: customer.email },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an invalid email (400 VALIDATION_ERROR)', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: customer.name, email: 'not-an-email' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('a customer in another organization returns 404', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: 'x', email: 'x@example.com' },
      { cookie: orgB.cookie },
    );
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
  });

  it('trims whitespace and normalises an all-whitespace company to null', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await sendJson(
      app,
      'PATCH',
      `/api/customers/${customer.id}`,
      { name: '  Padded Name  ', email: '  padded@example.com  ', company: '   ' },
      { cookie: orgA.cookie },
    );
    expect(response.statusCode).toBe(200);
    const body = response.json() as { name: string; email: string; company: string | null };
    expect(body.name).toBe('Padded Name');
    expect(body.email).toBe('padded@example.com');
    expect(body.company).toBeNull();
  });
});

// ── DELETE /api/customers/:id ─────────────────────────────────────────────
describe('DELETE /api/customers/:id — safety guards', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let orgA: Awaited<ReturnType<typeof signUpAndGetOrg>>;
  let orgB: Awaited<ReturnType<typeof signUpAndGetOrg>>;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    orgA = await signUpAndGetOrg(auth, db, `customers-delete-a-${crypto.randomUUID()}@example.com`);
    orgB = await signUpAndGetOrg(auth, db, `customers-delete-b-${crypto.randomUUID()}@example.com`);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('removes a customer that has zero deployments and returns 204', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(204);
    const rows = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
    expect(rows).toHaveLength(0);
  });

  it('removes a customer that holds unused invitations, and the invitations with it', async () => {
    const application = await insertApplication(db, orgA.organizationId, { repoFullName: 'acme/invited-app' });
    const customer = await insertCustomer(db, orgA.organizationId);
    for (const revokedAt of [null, new Date()]) {
      await db.insert(schema.publicInstallLinks).values({
        organizationId: orgA.organizationId,
        applicationId: application.id,
        customerId: customer.id,
        tokenHash: crypto.randomUUID(),
        enabled: true,
        revokedAt,
      });
    }
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(204);
    const links = await db
      .select()
      .from(schema.publicInstallLinks)
      .where(eq(schema.publicInstallLinks.customerId, customer.id));
    expect(links).toHaveLength(0);
  });

  it('refuses a customer that has a HEALTHY deployment (409 CUSTOMER_HAS_DEPLOYMENTS)', async () => {
    const application = await insertApplication(db, orgA.organizationId);
    const customer = await insertCustomer(db, orgA.organizationId);
    const deployment = await insertDeployment(db, orgA.organizationId, application.id, customer.id, {
      state: 'HEALTHY',
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('CUSTOMER_HAS_DEPLOYMENTS');
    const customerRows = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
    expect(customerRows).toHaveLength(1);
    const deploymentRows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRows).toHaveLength(1);
  });

  it('refuses a customer whose only deployment is DELETED — it may still hold retained AWS resources (409 CUSTOMER_HAS_DEPLOYMENTS)', async () => {
    const application = await insertApplication(db, orgA.organizationId, {
      repoFullName: `acme/test-app-${crypto.randomUUID()}`,
    });
    const customer = await insertCustomer(db, orgA.organizationId);
    const deployment = await insertDeployment(db, orgA.organizationId, application.id, customer.id, {
      state: 'DELETED',
    });
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('CUSTOMER_HAS_DEPLOYMENTS');
    const customerRows = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
    expect(customerRows).toHaveLength(1);
    const deploymentRows = await db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, deployment.id));
    expect(deploymentRows).toHaveLength(1);
  });

  it('a customer in another organization returns 404 and is not deleted', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgB.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    const rows = await db.select().from(schema.customers).where(eq(schema.customers.id, customer.id));
    expect(rows).toHaveLength(1);
  });

  it('writes a CUSTOMER_DELETED event_logs row with the org id and the customer id', async () => {
    const customer = await insertCustomer(db, orgA.organizationId);
    const response = await app.inject({
      method: 'DELETE',
      url: `/api/customers/${customer.id}`,
      headers: { cookie: orgA.cookie },
    });
    expect(response.statusCode).toBe(204);

    const events = await db
      .select()
      .from(schema.eventLogs)
      .where(and(eq(schema.eventLogs.eventType, 'CUSTOMER_DELETED'), eq(schema.eventLogs.customerId, customer.id)));
    expect(events).toHaveLength(1);
    expect(events[0]!.organizationId).toBe(orgA.organizationId);
  });
});

// ── Every mutating customer route requires a session ────────────────────────
describe('every mutating customer route returns 401 without a session', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    const { emailSender } = createRecordingEmailSender();
    app = await buildServer({ auth, db, emailSender });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const id = crypto.randomUUID();
  const routes: Array<[string, string]> = [
    ['GET', `/api/customers/${id}`],
    ['PATCH', `/api/customers/${id}`],
    ['DELETE', `/api/customers/${id}`],
  ];

  it.each(routes)('%s %s returns 401', async (method, url) => {
    const response = await sendJson(app, method as 'GET' | 'PATCH' | 'DELETE', url, {});
    expect(response.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });
});
