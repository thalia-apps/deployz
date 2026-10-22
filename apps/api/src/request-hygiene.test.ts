import { PGlite } from '@electric-sql/pglite';
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';

import { createAuth, type Auth } from './auth.js';
import { env } from './env.js';
import { buildServer } from './server.js';

// Request hygiene: cross-site writes with a session cookie, client-chosen
// X-Forwarded-For, text/plain bodies, malformed input and response headers.

const trustedOrigin = env.webOrigins[0]!;
const LIMIT = 300; // PUBLIC_INSTALL_RATE_LIMIT.max in server.ts

describe('request hygiene', () => {
  let client: PGlite | undefined;
  let db: Db;
  let auth: Auth;
  let app: FastifyInstance;
  let cookie: string;

  beforeAll(async () => {
    client = new PGlite();
    await applyMigrations(client);
    db = createDb(client);
    auth = createAuth(db);
    app = await buildServer({ auth, db });
    await auth.api.signUpEmail({
      body: { email: 'hygiene@example.com', password: 'super-secret-1', name: 'hygiene' },
    });
    const signin = await auth.api.signInEmail({
      body: { email: 'hygiene@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    cookie = signin.headers.get('set-cookie')!;
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const createCustomer = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/api/customers',
      headers: { cookie, ...headers },
      payload: { name: 'Acme', email: 'ops@acme.test' },
    });

  describe('cross-site writes', () => {
    it('rejects a cookie-carrying write from a foreign Origin', async () => {
      const response = await createCustomer({ origin: 'https://d-attacker.deployz.dev' });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    });

    it('rejects a write whose Referer is foreign and Origin is absent', async () => {
      const response = await createCustomer({ referer: 'https://d-attacker.deployz.dev/page' });
      expect(response.statusCode).toBe(403);
    });

    it('rejects the opaque Origin of a sandboxed frame', async () => {
      const response = await createCustomer({ origin: 'null' });
      expect(response.statusCode).toBe(403);
    });

    it('accepts a write from a trusted web origin', async () => {
      const response = await createCustomer({ origin: trustedOrigin });
      expect(response.statusCode).toBe(201);
    });

    it('does not apply to requests without a session cookie', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/relay/register',
        headers: { origin: 'https://d-attacker.deployz.dev' },
        payload: {},
      });
      expect(response.statusCode).not.toBe(403);
    });

    it('does not parse text/plain bodies', async () => {
      const response = await createCustomer({ origin: trustedOrigin, 'content-type': 'text/plain' });
      expect(response.statusCode).toBe(415);
    });
  });

  describe('rate limit keying', () => {
    it('keys on the right-most X-Forwarded-For hop, not a client-chosen one', async () => {
      let last = 0;
      for (let i = 0; i < LIMIT + 1; i += 1) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/install/${crypto.randomUUID()}`,
          headers: { 'x-forwarded-for': `10.0.${(i >> 8) & 255}.${i & 255}, 203.0.113.10` },
        });
        last = response.statusCode;
      }
      expect(last).toBe(429);
    }, 120_000);
  });

  describe('error envelope', () => {
    it('answers malformed JSON with 400 in the standard envelope', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/customers',
        headers: { cookie, origin: trustedOrigin, 'content-type': 'application/json' },
        payload: '{bad',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('REQUEST_ERROR');
    });

    it('answers an unknown route with the 404 envelope', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/no-such-route' });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    });

    it('rejects a non-numeric or negative pagination query with 400', async () => {
      for (const query of ['limit=abc', 'limit=0', 'offset=-1']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/deployments/${crypto.randomUUID()}/events?${query}`,
          headers: { cookie },
        });
        expect(response.statusCode, query).toBe(400);
      }
    });
  });

  it('sends the safe response headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });
});
