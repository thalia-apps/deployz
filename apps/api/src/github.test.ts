import { createHmac, createVerify, generateKeyPairSync } from 'node:crypto';

import { PGlite } from '@electric-sql/pglite';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { applyMigrations, createDb, type Db } from '@deployz/db';
import {
  analyseRepo,
  buildReadinessReport,
  manifestToApplicationGraph,
  normalizeDeploymentManifest,
  planApplicationGraph,
  TREE_PATHS,
} from '@deployz/analysis';

import { createAuth, type Auth } from './auth.js';
import { errorEnvelopeSchema } from '@deployz/contracts';
import { buildServer } from './server.js';
import {
  ANALYSIS_MAX_FILES,
  buildAppJwt,
  buildFileTreeForAnalysis,
  canReadRepository,
  createAppJwt,
  createInstallState,
  InMemoryGithubInstallationStore,
  createInstallationToken,
  fetchFilesForAnalysis,
  fetchHeadSha,
  fetchInstallationLiveState,
  fetchRepositoryTreeEntries,
  FixtureGithubConnections,
  getCommit,
  getFileTreeForAnalysis,
  getFixtureCommit,
  GITHUB_FIXTURE_COMMITS,
  GITHUB_FIXTURE_FILE_TREES,
  GITHUB_FIXTURE_INSTALLATIONS,
  GITHUB_SCOPED_PERMISSIONS,
  githubManageUrl,
  handleInstallationWebhook,
  isDashboardReturnPath,
  listBranchCommits,
  listFixtureBranchCommits,
  listRepositories,
  mintInstallationToken,
  parseRepoFullName,
  reconciledStatus,
  requireActiveInstallation,
  verifyInstallState,
  verifyWebhookSignature,
  type AppJwtSigner,
  type FetchFn,
  type GithubConnectionStatus,
  type GithubLiveState,
  type GithubWebhookEvent,
} from './github.js';

// Todo 15 — GitHub App handlers. Real App install / token fetch / webhook
// delivery are BLOCKED (no credentials, no network), so the JWT signing and
// token exchange are driven with injectable signer/fetch seams and the S4
// permission scope is locked verbatim.

const WEBHOOK_SECRET = 'github_webhook_test_secret';
const TEST_APP_ID = '123456';

function signPayload(payload: string, secret: string = WEBHOOK_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

function decodeJwtSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown;
}

function makeFetchResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ReturnType<FetchFn> {
  return Promise.resolve({
    status,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  });
}

describe('github — webhook signature verification', () => {
  it('accepts a valid HMAC-SHA256 signature', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    expect(verifyWebhookSignature(payload, signPayload(payload), WEBHOOK_SECRET)).toBe(true);
  });

  it('accepts a valid signature over a Buffer body', () => {
    const payload = Buffer.from(JSON.stringify({ action: 'deleted', installation: { id: 1 } }));
    expect(verifyWebhookSignature(payload, signPayload(payload.toString()), WEBHOOK_SECRET)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const tampered = JSON.stringify({ action: 'created', installation: { id: 9999 } });
    expect(verifyWebhookSignature(tampered, signPayload(payload), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a signature made with the wrong secret', () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    expect(verifyWebhookSignature(payload, signPayload(payload, 'wrong-secret'), WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    expect(verifyWebhookSignature('{}', undefined, WEBHOOK_SECRET)).toBe(false);
  });

  it('rejects a header without the sha256= prefix', () => {
    expect(verifyWebhookSignature('{}', 'not-a-signature', WEBHOOK_SECRET)).toBe(false);
  });
});

describe('github — App JWT (RS256)', () => {
  it('builds a well-formed JWT header/payload and uses the injected signer', () => {
    const signer: AppJwtSigner = { sign: (input) => `sig-of-${input.length}` };
    const nowMs = 1_700_000_000_000;
    const jwt = buildAppJwt(TEST_APP_ID, signer, nowMs);
    const [header, payload, signature] = jwt.split('.');

    expect(decodeJwtSegment(header!)).toStrictEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeJwtSegment(payload!) as { iat: number; exp: number; iss: string };
    // Backdated by the 60s skew margin, expiring 60s inside GitHub's 10-minute
    // ceiling: GitHub compares both claims against ITS clock, so issuing at
    // exactly now + 600 is rejected whenever our clock runs a moment fast.
    expect(claims.iat).toBe(1_699_999_940);
    expect(claims.exp).toBe(1_700_000_420);
    expect(claims.iss).toBe(TEST_APP_ID);
    expect(signature).toBe(`sig-of-${`${header}.${payload}`.length}`);
  });

  it('createAppJwt produces an RS256 signature verifiable with the public key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwt = createAppJwt(TEST_APP_ID, privateKey, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
    expect(decodeJwtSegment(header!)).toMatchObject({ alg: 'RS256' });
  });

  // The PEM reaches us through `.env` (double-quoted, backslash-n escapes) and
  // through a GitHub Actions secret, and only the .env parser decodes those
  // escapes. A key that arrives with them intact used to be handed to
  // node:crypto verbatim, which threw a bare Error — rendered to the vendor as
  // a 500 INTERNAL_ERROR with nothing in the logs to explain it.
  it('accepts a private key whose newlines arrived as escapes', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
    const escaped = pem.split('\n').join(String.raw`\n`);
    expect(escaped.includes('\n')).toBe(false);

    const jwt = createAppJwt(TEST_APP_ID, escaped, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  // Exactly how production broke: a real multi-line PEM whose FIRST and LAST
  // line breaks alone were re-escaped on the way into the Actions secret.
  it('accepts a key with only some of its line breaks escaped', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const lines = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString().trimEnd().split('\n');
    const mixed = [lines[0], lines.slice(1, -1).join('\n'), lines.at(-1)].join(String.raw`\n`);

    const jwt = createAppJwt(TEST_APP_ID, mixed, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    verifier.end();
    expect(verifier.verify(publicKey, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  // A key that is simply unusable has to name itself as a GitHub configuration
  // problem. An anonymous 500 is what made this cost an afternoon.
  it('reports an unusable key as a configuration error rather than a bare crash', () => {
    expect(() => createAppJwt(TEST_APP_ID, 'not-a-pem', 1_700_000_000_000)).toThrow(
      expect.objectContaining({ code: 'GITHUB_APP_KEY_INVALID', statusCode: 503 }),
    );
  });
});

describe('github — installation token vending + S4 permission scope', () => {
  it('locks the S4 scope to metadata:read + contents:read ONLY', () => {
    expect(Object.keys(GITHUB_SCOPED_PERMISSIONS).sort()).toEqual(['contents', 'metadata']);
    expect(GITHUB_SCOPED_PERMISSIONS).toStrictEqual({ contents: 'read', metadata: 'read' });
  });

  it('POSTs to the access-token endpoint with the JWT and the S4-scoped permissions', async () => {
    let capturedUrl = '';
    let capturedInit: { method?: string; headers?: Record<string, string>; body?: string } | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return makeFetchResponse(201, { token: 'ghs_test_token', expires_at: '2026-08-20T12:00:00Z' });
    };

    const result = await createInstallationToken('999', 'header.payload.sig', fetchFn);

    expect(capturedUrl).toBe('https://api.github.com/app/installations/999/access_tokens');
    expect(capturedInit?.method).toBe('POST');
    expect(capturedInit?.headers?.['Authorization']).toBe('Bearer header.payload.sig');
    expect(capturedInit?.headers?.['Accept']).toBe('application/vnd.github+json');

    const body = JSON.parse(capturedInit?.body ?? '{}') as { permissions: Record<string, string> };
    expect(Object.keys(body.permissions).sort()).toEqual(['contents', 'metadata']);
    expect(body.permissions).toStrictEqual({ contents: 'read', metadata: 'read' });

    expect(result.token).toBe('ghs_test_token');
    expect(result.expiresAt).toBe('2026-08-20T12:00:00Z');
  });

  it('throws a structured 502 on a failed exchange', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(403, { message: 'forbidden' });
    await expect(createInstallationToken('999', 'header.payload.sig', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_TOKEN_FETCH_FAILED',
    });
  });

  it('mintInstallationToken signs a real JWT and exchanges it', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let capturedAuth = '';
    const fetchFn: FetchFn = async (_url, init) => {
      capturedAuth = init?.headers?.['Authorization'] ?? '';
      return makeFetchResponse(201, { token: 'ghs_minted', expires_at: '2026-08-20T12:00:00Z' });
    };
    const result = await mintInstallationToken('42', TEST_APP_ID, privateKey, 1_700_000_000_000, fetchFn);
    expect(capturedAuth).toMatch(/^Bearer .+\..+\..+$/);
    expect(result.token).toBe('ghs_minted');
  });
});

describe('github — installation webhook reconciliation', () => {
  const record = (status: GithubConnectionStatus = 'active') => ({
    id: '77',
    organizationId: 'org-1',
    accountLogin: 'acme',
    accountType: 'Organization' as const,
    accountId: '9001',
    status,
  });
  const live = (state: GithubLiveState['state']) => async (): Promise<GithubLiveState> =>
    state === 'missing'
      ? { state }
      : { state, accountLogin: 'acme', accountType: 'Organization', accountId: '9001' };
  const event = (action: string): GithubWebhookEvent => ({ type: 'installation', action, installation: { id: 77 } });

  // The row stays, so applications keep their repository association and the
  // vendor sees an access issue instead of a connection that vanished.
  it('marks an uninstalled installation as an access issue and keeps the row', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set(record());
    expect(await handleInstallationWebhook(store, event('deleted'), live('missing'))).toBe('updated');
    expect((await store.get('77'))?.status).toBe('access_issue');
  });

  it('marks a suspended installation as an access issue', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set(record());
    expect(await handleInstallationWebhook(store, event('suspend'), live('suspended'))).toBe('updated');
    expect((await store.get('77'))?.status).toBe('access_issue');
  });

  it('restores access on unsuspend only after GitHub confirms the installation is active', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set(record('access_issue'));
    // GitHub still reports it suspended: the event alone restores nothing.
    expect(await handleInstallationWebhook(store, event('unsuspend'), live('suspended'))).toBe('unchanged');
    expect((await store.get('77'))?.status).toBe('access_issue');
    expect(await handleInstallationWebhook(store, event('unsuspend'), live('active'))).toBe('updated');
    expect((await store.get('77'))?.status).toBe('active');
  });

  // A replayed `suspend` after the unsuspend reads GitHub's current state,
  // so it cannot take access away again.
  it('ignores a replayed suspend once GitHub reports the installation active', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set(record());
    expect(await handleInstallationWebhook(store, event('suspend'), live('active'))).toBe('unchanged');
    expect((await store.get('77'))?.status).toBe('active');
  });

  it('never ends a disconnect the organization chose', async () => {
    const store = new InMemoryGithubInstallationStore();
    await store.set(record('disconnected'));
    for (const action of ['unsuspend', 'new_permissions_accepted', 'deleted']) {
      await handleInstallationWebhook(store, event(action), live('active'));
    }
    expect((await store.get('77'))?.status).toBe('disconnected');
  });

  it('ignores an installation Deployz has no binding for', async () => {
    const store = new InMemoryGithubInstallationStore();
    const readLiveState = vi.fn(live('missing'));
    expect(await handleInstallationWebhook(store, event('deleted'), readLiveState)).toBe('ignored');
    expect(readLiveState).not.toHaveBeenCalled();
  });

  it('ignores non-installation events', async () => {
    const store = new InMemoryGithubInstallationStore();
    expect(await handleInstallationWebhook(store, { type: 'push' }, live('active'))).toBe('ignored');
  });

  // installation.created carries a GitHub account, not a Deployz tenant —
  // the binding is made by GET /api/github/setup, where the vendor's session
  // is present.
  it('ignores installation.created', async () => {
    const store = new InMemoryGithubInstallationStore();
    const created: GithubWebhookEvent = {
      type: 'installation',
      action: 'created',
      installation: { id: 77, account: { login: 'acme', type: 'Organization' } },
    };
    expect(await handleInstallationWebhook(store, created, live('active'))).toBe('ignored');
    expect(await store.listByOrganization('org-1')).toEqual([]);
  });

  it('keeps the organization choice and follows GitHub otherwise', () => {
    expect(reconciledStatus('disconnected', 'active')).toBe('disconnected');
    expect(reconciledStatus('active', 'missing')).toBe('access_issue');
    expect(reconciledStatus('active', 'suspended')).toBe('access_issue');
    expect(reconciledStatus('access_issue', 'active')).toBe('active');
  });
});

describe('github — requireActiveInstallation (the one token gate)', () => {
  const record = (status: GithubConnectionStatus) => ({
    id: '77',
    organizationId: 'org-1',
    accountLogin: 'acme',
    accountType: 'Organization' as const,
    accountId: null,
    status,
  });

  it('passes an active binding of the same organization', () => {
    expect(requireActiveInstallation(record('active'), 'org-1').id).toBe('77');
  });

  it.each([
    ['no binding', null, 'org-1', 'not_connected'],
    ['another organization', record('active'), 'org-2', 'not_connected'],
    ['a disconnected binding', record('disconnected'), 'org-1', 'disconnected'],
    ['an access issue', record('access_issue'), 'org-1', 'access_issue'],
  ])('refuses %s with 409 GITHUB_NOT_CONNECTED', (_name, input, organizationId, connectionStatus) => {
    expect(() => requireActiveInstallation(input, organizationId)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'GITHUB_NOT_CONNECTED', details: { connectionStatus } }),
    );
  });
});

describe('github — install state', () => {
  const secret = 'state-secret';

  it('round-trips a dashboard return path', () => {
    const state = createInstallState(secret, 'org-1', 1_000, '/dashboard/applications/abc/config');
    expect(verifyInstallState(secret, state, 'org-1', 2_000)).toEqual({ returnPath: '/dashboard/applications/abc/config' });
    expect(verifyInstallState(secret, createInstallState(secret, 'org-1', 1_000), 'org-1', 2_000)).toEqual({
      returnPath: null,
    });
  });

  it('refuses another organization, an expired state and a changed return path', () => {
    const state = createInstallState(secret, 'org-1', 1_000, '/dashboard/settings');
    expect(verifyInstallState(secret, state, 'org-2', 2_000)).toBe(false);
    expect(verifyInstallState(secret, state, 'org-1', 1_000 + 11 * 60 * 1000)).toBe(false);
    const [expiry, organizationId, , signature] = state.split('.');
    const tampered = [expiry, organizationId, Buffer.from('/dashboard/x').toString('base64url'), signature].join('.');
    expect(verifyInstallState(secret, tampered, 'org-1', 2_000)).toBe(false);
  });

  it.each(['https://evil.example', '//evil.example', '/dashboard/../admin', '/dashboard?x=1', '/settings'])(
    'accepts no return path outside the dashboard (%s)',
    (path) => {
      expect(isDashboardReturnPath(path)).toBe(false);
    },
  );
});

describe('github — fixture-backed list helpers', () => {
  it('lists the fixture installation as active for every organization', () => {
    const connections = new FixtureGithubConnections();
    expect(connections.list('org-1')).toEqual([
      {
        id: 'fixture-install-1',
        organizationId: 'org-1',
        accountLogin: 'deployz-demo',
        accountType: 'Organization',
        accountId: null,
        status: 'active',
      },
    ]);
  });

  // Every organization shares the fixture installation, so a disconnect is
  // kept per organization.
  it('keeps a fixture disconnect to the organization that made it', () => {
    const connections = new FixtureGithubConnections();
    expect(connections.setStatus('fixture-install-1', 'org-1', 'disconnected')).toBe(true);
    expect(connections.setStatus('fixture-install-1', 'org-1', 'disconnected')).toBe(false);
    expect(connections.get('fixture-install-1', 'org-1')?.status).toBe('disconnected');
    expect(connections.get('fixture-install-1', 'org-2')?.status).toBe('active');
    expect(connections.get('nope', 'org-1')).toBeNull();
  });

  it('lists fixture repositories for a known installation', async () => {
    const repos = await listRepositories('fixture-install-1', { fixtureMode: true });
    expect(repos.map((r) => r.name)).toEqual([
      'express-api',
      'legacy-redis',
      'bullmq-worker',
      'static-api',
      'nextjs-prisma',
      'monorepo',
    ]);
    expect(repos[0]?.fullName).toBe('deployz-demo/express-api');
  });

  it('404s for an unknown fixture installation', async () => {
    await expect(listRepositories('nope', { fixtureMode: true })).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_INSTALLATION_NOT_FOUND',
    });
  });
});

describe('github — installation live state and repository access', () => {
  it('reads suspension and the immutable account id from GitHub', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(200, { account: { login: 'acme', type: 'User', id: 9001 }, suspended_at: '2026-10-01T00:00:00Z' });
    expect(await fetchInstallationLiveState('77', 'jwt', fetchFn)).toEqual({
      state: 'suspended',
      accountLogin: 'acme',
      accountType: 'User',
      accountId: '9001',
    });
  });

  it('reads a 404 as an installation GitHub no longer has, and other failures as errors', async () => {
    expect(await fetchInstallationLiveState('77', 'jwt', async () => makeFetchResponse(404, {}))).toEqual({
      state: 'missing',
    });
    await expect(fetchInstallationLiveState('77', 'jwt', async () => makeFetchResponse(500, {}))).rejects.toMatchObject({
      code: 'GITHUB_INSTALLATION_FETCH_FAILED',
    });
  });

  it('reads a repository the token cannot see as inaccessible', async () => {
    const urls: string[] = [];
    const fetchFn = (status: number): FetchFn => async (url) => {
      urls.push(url);
      return makeFetchResponse(status, {});
    };
    expect(await canReadRepository('acme/app', 'token', fetchFn(200))).toBe(true);
    expect(await canReadRepository('acme/app', 'token', fetchFn(404))).toBe(false);
    expect(await canReadRepository('acme/app', 'token', fetchFn(403))).toBe(false);
    await expect(canReadRepository('acme/app', 'token', fetchFn(502))).rejects.toMatchObject({
      code: 'GITHUB_REPO_CHECK_FAILED',
    });
    expect(urls[0]).toBe('https://api.github.com/repos/acme/app');
  });

  it('links a user account and an organization account to their own installation settings', () => {
    expect(githubManageUrl({ id: '77', accountLogin: 'me', accountType: 'User' })).toBe(
      'https://github.com/settings/installations/77',
    );
    expect(githubManageUrl({ id: '77', accountLogin: 'acme', accountType: 'Organization' })).toBe(
      'https://github.com/organizations/acme/settings/installations/77',
    );
  });
});

describe('github — installation repository listing pagination', () => {
  const repo = (n: number) => ({ id: n, name: `repo-${n}`, full_name: `org/repo-${n}`, description: null, private: false, default_branch: 'main' });

  it('reads every page, not only the first 30 repositories GitHub returns by default', async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = (url) => {
      urls.push(url);
      const page = Number(new URL(url).searchParams.get('page'));
      const count = page === 1 ? 100 : 35;
      return makeFetchResponse(200, { repositories: Array.from({ length: count }, (_, i) => repo((page - 1) * 100 + i)) });
    };
    const repos = await listRepositories('install-1', { fixtureMode: false, installationToken: 'token', fetchFn });
    expect(repos).toHaveLength(135);
    expect(repos.at(-1)?.fullName).toBe('org/repo-134');
    expect(urls.map((url) => new URL(url).search)).toEqual(['?per_page=100&page=1', '?per_page=100&page=2']);
  });
});

describe('github — parseRepoFullName', () => {
  it('splits a well-formed "owner/repo" name', () => {
    expect(parseRepoFullName('deployz-demo/express-api')).toEqual({
      owner: 'deployz-demo',
      repo: 'express-api',
    });
  });

  it('rejects a name with no slash', () => {
    expect(() => parseRepoFullName('express-api')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'GITHUB_REPO_FULL_NAME_INVALID' }),
    );
  });

  it('rejects a name with more than one slash', () => {
    expect(() => parseRepoFullName('a/b/c')).toThrow(
      expect.objectContaining({ statusCode: 400, code: 'GITHUB_REPO_FULL_NAME_INVALID' }),
    );
  });
});

// §18 analysis input: the repository tree fetch. These cases never touch
// real GitHub — each drives fetchRepositoryTreeEntries /
// buildFileTreeForAnalysis through the injected FetchFn seam.
describe('github — repository tree fetch (§18 analysis input)', () => {
  const REF = { owner: 'acme', repo: 'widgets', branch: 'main' };

  it('fetches the recursive tree listing with the installation token', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, {
        tree: [{ path: 'package.json', type: 'blob', sha: 'abc', size: 42 }],
      });
    };
    const entries = await fetchRepositoryTreeEntries(REF, 'tok', fetchFn);
    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/git/trees/main?recursive=1');
    expect(entries).toEqual([{ path: 'package.json', type: 'blob', sha: 'abc', size: 42 }]);
  });

  it('maps a 404 with no "empty" message to GITHUB_REPO_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Not Found' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_REPO_NOT_FOUND',
    });
  });

  it('maps a 404 with an "empty" message to GITHUB_REPO_EMPTY', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(404, { message: 'Git Repository is empty.' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 422,
      code: 'GITHUB_REPO_EMPTY',
    });
  });

  it('maps a 409 to GITHUB_REPO_EMPTY', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(409, { message: 'conflict' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 422,
      code: 'GITHUB_REPO_EMPTY',
    });
  });

  it('maps a 429 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(429, { message: 'rate limited' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps a 403 with x-ratelimit-remaining: 0 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '0' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps an unrelated 403 to the generic GITHUB_TREE_FETCH_FAILED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(403, { message: 'forbidden' });
    await expect(fetchRepositoryTreeEntries(REF, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_TREE_FETCH_FAILED',
    });
  });

  it('builds a FileTree from only the relevant, capped set of files', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 100 },
            { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 50 },
            { path: 'src/index.ts', type: 'blob', sha: 'sha-src', size: 60 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 20 }, // irrelevant extension
            { path: 'node_modules/x/index.js', type: 'blob', sha: 'sha-nm', size: 10 }, // ignored dir
            { path: 'src', type: 'tree', sha: 'sha-dir' }, // a directory, not a blob
          ],
        });
      }
      const sha = url.split('/').pop();
      const content = { 'sha-pkg': '{}', 'sha-docker': 'FROM node', 'sha-src': 'export {}' }[sha!];
      return makeFetchResponse(200, {
        content: Buffer.from(content ?? '').toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toEqual({
      'package.json': '{}',
      'Dockerfile': 'FROM node',
      'src/index.ts': 'export {}',
    });
    // One tree call + one blob call per relevant file (3) — never touches
    // README.md, node_modules/**, or the directory entry.
    expect(calls).toHaveLength(4);
  });

  // twenty: GitHub cut the listing of a 47k-path repository, so `yarn.lock`
  // looked missing and the Dockerfile was rejected as unbuildable.
  it('attaches the full path list only when GitHub did not truncate the listing', async () => {
    const listing = (truncated: boolean): FetchFn => async (url) =>
      url.includes('/git/trees/')
        ? makeFetchResponse(200, { truncated, tree: [{ path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 9 }] })
        : makeFetchResponse(200, { content: Buffer.from('FROM node').toString('base64'), encoding: 'base64' });
    const full = await buildFileTreeForAnalysis(REF, 'tok', listing(false));
    expect((full as Record<symbol, unknown>)[TREE_PATHS]).toEqual(['Dockerfile']);
    const truncated = await buildFileTreeForAnalysis(REF, 'tok', listing(true));
    expect((truncated as Record<symbol, unknown>)[TREE_PATHS]).toBeUndefined();
    expect(truncated).toEqual({ Dockerfile: 'FROM node' });
  });

  it('fetches C#, Java, Kotlin, PHP, Rust and Elixir source and appsettings.json for the env-var model', async () => {
    const paths = [
      'src/Api/Services/Mailer.cs',
      'src/main/java/app/Config.java',
      'src/main/kotlin/app/App.kt',
      'app/constants.php',
      'src/main.rs',
      'config/runtime.exs',
      'lib/app/repo.ex',
      'src/Api/appsettings.json',
    ];
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [...paths, 'src/Api/appsettings.Development.json'].map((path) => ({ path, type: 'blob', sha: `sha-${path}`, size: 10 })),
        });
      }
      return makeFetchResponse(200, { content: Buffer.from('x').toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual([...paths].sort());
  });

  it('fetches the named evidence files of the AI Analysis: blobs within the size limit only', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'lib/app/application.ex', type: 'blob', sha: 'sha-app', size: 100 },
            { path: 'config/runtime.exs', type: 'blob', sha: 'sha-big', size: 300_000 },
            { path: 'lib', type: 'tree', sha: 'sha-dir' },
          ],
        });
      }
      return makeFetchResponse(200, { content: Buffer.from('def start').toString('base64'), encoding: 'base64' });
    };

    const files = await fetchFilesForAnalysis(REF, 'tok', fetchFn, ['lib/app/application.ex', 'config/runtime.exs', 'lib', 'missing.ex']);

    expect(files).toEqual({ 'lib/app/application.ex': 'def start' });
    expect(calls).toHaveLength(2);
  });

  it('resolves a symlinked Dockerfile to the content of its target file', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'Dockerfile', type: 'blob', mode: '120000', sha: 'sha-link', size: 17 },
            { path: 'docker/Dockerfile', type: 'blob', mode: '100644', sha: 'sha-real', size: 30 },
            { path: 'apps/web/Dockerfile.prod', type: 'blob', mode: '120000', sha: 'sha-rel', size: 20 },
            { path: 'apps/web/Dockerfile.real', type: 'blob', mode: '100644', sha: 'sha-rel-real', size: 30 },
          ],
        });
      }
      const sha = url.split('/').pop();
      const content = {
        'sha-link': 'docker/Dockerfile',
        'sha-real': 'FROM node\nCMD ["node", "server.js"]',
        'sha-rel': 'Dockerfile.real',
        'sha-rel-real': 'FROM node:22',
      }[sha!];
      return makeFetchResponse(200, { content: Buffer.from(content ?? '').toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree['Dockerfile']).toBe('FROM node\nCMD ["node", "server.js"]');
    expect(tree['apps/web/Dockerfile.prod']).toBe('FROM node:22');
  });

  it('drops a symlink whose target is missing instead of reading the path as content', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'Dockerfile', type: 'blob', mode: '120000', sha: 'sha-link', size: 10 }],
        });
      }
      return makeFetchResponse(200, { content: Buffer.from('nowhere/Dockerfile').toString('base64'), encoding: 'base64' });
    };
    expect(await buildFileTreeForAnalysis(REF, 'tok', fetchFn)).toEqual({});
  });

  it('fetches deployment descriptors the cloud checks read (COMP-033)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 10 },
            { path: 'manifests/kustomization.yaml', type: 'blob', sha: 'sha-kustomize', size: 10 },
            { path: 'charts/app/Chart.yaml', type: 'blob', sha: 'sha-chart', size: 10 },
            { path: 'infra/main.tf', type: 'blob', sha: 'sha-tf', size: 10 },
            { path: 'infra/main.bicep', type: 'blob', sha: 'sha-bicep', size: 10 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 10 }, // still irrelevant
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual([
      'charts/app/Chart.yaml',
      'infra/main.bicep',
      'infra/main.tf',
      'manifests/kustomization.yaml',
      'package.json',
    ]);
  });

  it('fetches scheduled-job declarations the Phase 5D detector reads (render.yaml, vercel.json, crontab, *.cron)', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 10 },
            { path: 'render.yaml', type: 'blob', sha: 'sha-render', size: 10 },
            { path: 'vercel.json', type: 'blob', sha: 'sha-vercel', size: 10 },
            { path: 'crontab', type: 'blob', sha: 'sha-crontab', size: 10 },
            { path: 'jobs/cleanup.cron', type: 'blob', sha: 'sha-cron', size: 10 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 10 }, // still irrelevant
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual([
      'crontab',
      'jobs/cleanup.cron',
      'package.json',
      'render.yaml',
      'vercel.json',
    ]);
  });

  it('fetches Procfile so a Procfile-declared worker joins SQS producer/consumer detection', async () => {
    const blobs: Record<string, string> = {
      'sha-docker': [
        'FROM node:20-alpine',
        'WORKDIR /app',
        'COPY . .',
        'EXPOSE 3000',
        'CMD ["node", "dist/server.js"]',
        '',
      ].join('\n'),
      'sha-pkg': JSON.stringify({
        name: 'procfile-app',
        scripts: { start: 'node dist/server.js' },
        dependencies: { express: '^4.18.0', '@aws-sdk/client-sqs': '^3.600.0' },
      }),
      'sha-procfile': 'web: node dist/server.js\nworker: node dist/worker.js\n',
      'sha-server': [
        "import express from 'express';",
        "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';",
        'const app = express();',
        "app.get('/health', (_req, res) => res.json({ ok: true }));",
        "app.post('/orders', () => sqs.send(new SendMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL })));",
        'app.listen(process.env.PORT ?? 3000);',
        '',
      ].join('\n'),
      'sha-worker': [
        "import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
        'sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
        '',
      ].join('\n'),
      'sha-readme': '# procfile app\n',
    };
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'Dockerfile', type: 'blob', sha: 'sha-docker', size: 10 },
            { path: 'Procfile', type: 'blob', sha: 'sha-procfile', size: 10 },
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 10 },
            { path: 'src/server.ts', type: 'blob', sha: 'sha-server', size: 10 },
            { path: 'src/worker.ts', type: 'blob', sha: 'sha-worker', size: 10 },
            { path: 'README.md', type: 'blob', sha: 'sha-readme', size: 10 }, // still irrelevant
          ],
        });
      }
      const sha = url.split('/').pop()!;
      return makeFetchResponse(200, {
        content: Buffer.from(blobs[sha] ?? '').toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    // Without the Procfile the consumer has no declared workload, lands in the
    // web reach, and the queue becomes a question instead of an SQS resource.
    expect(tree['Procfile']).toContain('worker: node dist/worker.js');

    const analysis = analyseRepo(tree);
    expect(analysis.metadata['asyncQuestions']).toEqual([]);

    const manifest = normalizeDeploymentManifest(analysis, {});
    expect(manifest.workers?.map((w) => w.id)).toEqual(['worker']);
    expect(manifest.queues).toHaveLength(1);
    const queue = manifest.queues![0]!;
    expect(queue.id).toBe('orders-queue');
    expect(queue.producers).toEqual(['web']);
    expect(queue.consumers).toEqual(['worker']);
  });

  it('fetches the additional manifest/compose/env-sample/source shapes Redis detection needs (§7 of the Redis MVP)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'requirements.txt', type: 'blob', sha: 'sha-reqs', size: 10 },
            { path: 'services/worker/pyproject.toml', type: 'blob', sha: 'sha-pyproject', size: 10 },
            { path: 'Gemfile', type: 'blob', sha: 'sha-gemfile', size: 10 },
            { path: 'go.mod', type: 'blob', sha: 'sha-gomod', size: 10 },
            { path: 'composer.json', type: 'blob', sha: 'sha-composer', size: 10 },
            { path: 'docker-compose.yml', type: 'blob', sha: 'sha-compose-root', size: 10 },
            { path: 'deploy/compose.prod.yml', type: 'blob', sha: 'sha-compose-nested', size: 10 },
            { path: 'services/worker/docker-compose.override.yaml', type: 'blob', sha: 'sha-compose-override', size: 10 },
            { path: '.env.example', type: 'blob', sha: 'sha-env-root', size: 10 },
            { path: 'services/worker/.env.sample', type: 'blob', sha: 'sha-env-nested', size: 10 },
            { path: 'services/worker/.env.template', type: 'blob', sha: 'sha-env-template', size: 10 },
            { path: 'worker.py', type: 'blob', sha: 'sha-py', size: 10 },
            { path: 'app.rb', type: 'blob', sha: 'sha-rb', size: 10 },
            { path: 'irrelevant.txt', type: 'blob', sha: 'sha-irrelevant', size: 10 }, // still not relevant
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree).sort()).toEqual(
      [
        'requirements.txt',
        'services/worker/pyproject.toml',
        'Gemfile',
        'go.mod',
        'composer.json',
        'docker-compose.yml',
        'deploy/compose.prod.yml',
        'services/worker/docker-compose.override.yaml',
        '.env.example',
        'services/worker/.env.sample',
        'services/worker/.env.template',
        'worker.py',
        'app.rb',
      ].sort(),
    );
    expect(tree).not.toHaveProperty('irrelevant.txt');
  });

  it('never lets a flood of generic root-level source files crowd a named nested signal file out of the ANALYSIS_MAX_FILES cap', async () => {
    // More unnamed root-level relevant files (plain .py scripts, no
    // manifest/compose/env-sample name of their own) than the cap alone,
    // listed BEFORE the two named nested files below — so a naive stable
    // sort that treated "any root file" and "a named signal file" as the
    // same priority would let these fill every slot and drop the nested
    // docker-compose.yml/.env.example the Redis detectors actually need.
    const rootScripts = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `script${i}.py`,
      type: 'blob' as const,
      sha: `sha-script-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...rootScripts,
            { path: 'nested/docker-compose.yml', type: 'blob', sha: 'sha-compose', size: 10 },
            { path: 'nested/.env.example', type: 'blob', sha: 'sha-env', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('nested/docker-compose.yml');
    expect(tree).toHaveProperty('nested/.env.example');
  });

  // directus keeps `STORAGE_LOCATIONS: 'local'` in `packages/env/src/constants/defaults.ts`;
  // Ghost names its MySQL client in `config/env/config.production.json`.
  it('keeps an env package default file and a production JSON config inside the cap', async () => {
    const sources = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `src/feature${i}.ts`,
      type: 'blob' as const,
      sha: `sha-src-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...sources,
            { path: 'packages/env/src/constants/defaults.ts', type: 'blob', sha: 'sha-defaults', size: 10 },
            { path: 'ghost/core/shared/config/env/config.production.json', type: 'blob', sha: 'sha-prod', size: 10 },
          ],
        });
      }
      return makeFetchResponse(200, { content: Buffer.from('x').toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toHaveProperty(['packages/env/src/constants/defaults.ts']);
    expect(tree).toHaveProperty(['ghost/core/shared/config/env/config.production.json']);
  });

  it('fetches framework config files that read env vars and keeps them above ordinary source', async () => {
    const sources = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `src/feature${i}.ts`,
      type: 'blob' as const,
      sha: `sha-src-${i}`,
      size: 10,
    }));
    const configs = [
      'config/database.yml',
      'config/filesystems.php',
      'config/locales/en.yml',
      'src/main/resources/application.properties',
      'src/main/resources/application-prod.yml',
    ];
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...sources,
            ...configs.map((path, i) => ({ path, type: 'blob', sha: `sha-config-${i}`, size: 10 })),
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('config/database.yml');
    expect(tree).toHaveProperty('config/filesystems.php');
    expect(tree).toHaveProperty('src/main/resources/application.properties');
    expect(tree).toHaveProperty('src/main/resources/application-prod.yml');
    expect(tree).not.toHaveProperty('config/locales/en.yml');
  });

  it('keeps an ASP.NET Program.cs inside the cap when manifests alone fill it (OrchardCore)', async () => {
    const manifests = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `src/Modules/M${i}/M${i}.csproj`,
      type: 'blob' as const,
      sha: `sha-csproj-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [...manifests, { path: 'src/Cms.Web/Program.cs', type: 'blob', sha: 'sha-program', size: 10 }],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, { content: Buffer.from(`content-${sha}`).toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('src/Cms.Web/Program.cs');
  });

  it('fetches Laravel route and ASP.NET entry files and keeps them above ordinary source', async () => {
    const sources = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `src/feature${i}.ts`,
      type: 'blob' as const,
      sha: `sha-src-${i}`,
      size: 10,
    }));
    const php = ['bootstrap/app.php', 'routes/web.php', 'routes/api.php', 'app/Models/User.php', 'Web/Program.cs', 'Web/Startup.cs', 'Web/Models/Page.cs'];
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [...sources, ...php.map((path, i) => ({ path, type: 'blob', sha: `sha-php-${i}`, size: 10 }))],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toHaveProperty('bootstrap/app.php');
    expect(tree).toHaveProperty('routes/web.php');
    expect(tree).toHaveProperty('routes/api.php');
    expect(tree).toHaveProperty('Web/Program.cs');
    expect(tree).toHaveProperty('Web/Startup.cs');
    expect(tree).not.toHaveProperty('app/Models/User.php');
    expect(tree).not.toHaveProperty('Web/Models/Page.cs');
  });

  it('keeps a NestJS health.controller.ts inside the ANALYSIS_MAX_FILES cap (A1-003)', async () => {
    const services = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `apps/server/src/feature${i}/feature${i}.service.ts`,
      type: 'blob' as const,
      sha: `sha-service-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...services,
            { path: 'apps/server/src/integrations/health/health.controller.ts', type: 'blob', sha: 'sha-health', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('apps/server/src/integrations/health/health.controller.ts');
  });

  it('keeps env and config-class source, a typed config class, a plugin manager and a config.yml inside the ANALYSIS_MAX_FILES cap', async () => {
    const services = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `apps/server/src/feature${i}/index.ts`,
      type: 'blob' as const,
      sha: `sha-index-${i}`,
      size: 10,
    }));
    const wanted = [
      'apps/server/src/integrations/environment/environment.service.ts',
      'packages/shared/src/node/env/GlobalValues.ts',
      'packages/config/src/configs/database.config.ts',
      'packages/server/src/engine/core-modules/twenty-config/config-variables.ts',
      'packages/nocodb/src/helpers/NcPluginMgrv2.ts',
      'dev/build/config.yml',
    ];
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [...services, ...wanted.map((path) => ({ path, type: 'blob', sha: `sha-${path}`, size: 10 }))],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, { content: Buffer.from(`content-${sha}`).toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    for (const path of wanted) expect(tree).toHaveProperty(path);
  });

  it('keeps s6 service scripts, Go init files and Go start commands inside the ANALYSIS_MAX_FILES cap, and not their look-alikes', async () => {
    const services = Array.from({ length: ANALYSIS_MAX_FILES + 5 }, (_, i) => ({
      path: `pkg/feature${i}/service.go`,
      type: 'blob' as const,
      sha: `sha-service-${i}`,
      size: 10,
    }));
    const wanted = [
      'docker/rootfs/etc/s6-overlay/s6-rc.d/init-migrations/run',
      'docker/rootfs/etc/s6-overlay/s6-rc.d/svc-web/up',
      'rootfs/etc/cont-init.d/10-migrate',
      'pkg/initialize/init.go',
      'pkg/boot/bootstrap.go',
      'pkg/cmd/web.go',
      'cmd/serve.go',
    ];
    const lookalikes = [
      'docker/rootfs/etc/s6-overlay/s6-rc.d/init-migrations/finish',
      'docker/rootfs/etc/s6-overlay/s6-rc.d/init-migrations/type',
      'bin/run',
      'pkg/initialize/init_test.go',
      'test/helpers/init.go',
      'a/b/cmd/migrate.go',
      'a/b/cmd/webhook.go',
    ];
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [...services, ...[...wanted, ...lookalikes].map((path) => ({ path, type: 'blob', sha: `sha-${path}`, size: 10 }))],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, { content: Buffer.from(`content-${sha}`).toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    for (const path of wanted) expect(tree).toHaveProperty(path);
    for (const path of lookalikes) expect(tree).not.toHaveProperty(path);
  });

  it("protects the selected Dockerfile's CMD/ENTRYPOINT script chain from the ANALYSIS_MAX_FILES trim on a large repository (DEPLOY-029)", async () => {
    // An umami-shaped 250-file repository: CMD -> scripts/start-docker.sh
    // -> scripts/check-db.js. `scripts/` sinks both to the LOWEST relevance
    // tier (isRuntimeSourcePath treats a `scripts/` segment as non-runtime,
    // same as tests/fixtures/tools), so 247 ordinary root-tier source files
    // — the same in-tree-order flood the other cap tests use — would
    // otherwise fill every slot before either script ever gets a chance.
    const filler = Array.from({ length: 247 }, (_, i) => ({
      path: `src/file${i}.ts`,
      type: 'blob' as const,
      sha: `sha-filler-${i}`,
      size: 10,
    }));
    const dockerfileContent = ['FROM node:20-alpine', 'WORKDIR /app', 'CMD ["sh", "scripts/start-docker.sh"]', ''].join('\n');
    const startScriptContent = ['#!/bin/sh', 'node scripts/check-db.js', 'exec node index.js', ''].join('\n');
    const checkDbContent = "const { execSync } = require('child_process');\nexecSync('prisma migrate deploy');\n";
    const contentBySha: Record<string, string> = {
      'sha-dockerfile': dockerfileContent,
      'sha-start-script': startScriptContent,
      'sha-check-db': checkDbContent,
    };
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...filler,
            { path: 'Dockerfile', type: 'blob', sha: 'sha-dockerfile', size: 60 },
            { path: 'scripts/start-docker.sh', type: 'blob', sha: 'sha-start-script', size: 40 },
            { path: 'scripts/check-db.js', type: 'blob', sha: 'sha-check-db', size: 60 },
          ],
        });
      }
      const sha = url.split('/').pop() ?? '';
      const content = contentBySha[sha] ?? `content-${sha}`;
      return makeFetchResponse(200, { content: Buffer.from(content).toString('base64'), encoding: 'base64' });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('Dockerfile', dockerfileContent);
    expect(tree).toHaveProperty('scripts/start-docker.sh', startScriptContent);
    expect(tree).toHaveProperty('scripts/check-db.js', checkDbContent);
  });

  it('ranks specs, fixtures and tool configs last so application source survives the cap (COMP-018)', async () => {
    // Enough cypress specs and root tool configs to fill the cap on their own,
    // listed BEFORE the application files — a large repository's source must
    // not lose its slots to files the detectors never read.
    const specs = Array.from({ length: ANALYSIS_MAX_FILES }, (_, i) => ({
      path: `frontend/cypress/e2e/case${i}.spec.ts`,
      type: 'blob' as const,
      sha: `sha-spec-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'vitest.config.ts', type: 'blob', sha: 'sha-vitest', size: 10 },
            { path: '.husky/update-openapi.js', type: 'blob', sha: 'sha-husky', size: 10 },
            { path: 'scripts/build-geo.js', type: 'blob', sha: 'sha-script', size: 10 },
            { path: 'docs/api/generate.js', type: 'blob', sha: 'sha-docs', size: 10 },
            ...specs,
            { path: 'src/lib/features/deep/nested/handler.ts', type: 'blob', sha: 'sha-deep', size: 10 },
            { path: 'src/lib/routes/health-check.ts', type: 'blob', sha: 'sha-health', size: 10 },
            { path: 'src/server.ts', type: 'blob', sha: 'sha-server', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('src/server.ts');
    expect(tree).toHaveProperty('src/lib/routes/health-check.ts');
    expect(tree).toHaveProperty('src/lib/features/deep/nested/handler.ts');
    // The three application files took their slots first; specs, scripts,
    // docs and tool configs share the last tier and fill whatever remains,
    // in tree order.
    expect(Object.keys(tree).filter((path) => path.endsWith('.spec.ts'))).toHaveLength(ANALYSIS_MAX_FILES - 7);
  });

  it('fetches Dockerfiles and Compose files before workspace manifests, and test manifests last (COMP-038)', async () => {
    // A workspace with more package.json files than the cap, most of them
    // under e2e-tests/, listed before the production Dockerfile.
    const manifests = Array.from({ length: ANALYSIS_MAX_FILES }, (_, i) => ({
      path: i < 40 ? `webapp/platform/pkg${i}/package.json` : `e2e-tests/case${i}/package.json`,
      type: 'blob' as const,
      sha: `sha-pkg-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: '.cursor/Dockerfile', type: 'blob', sha: 'sha-cursor', size: 10 },
            ...manifests,
            { path: 'server/build/Dockerfile', type: 'blob', sha: 'sha-dockerfile', size: 10 },
            { path: 'server/build/docker-compose.yml', type: 'blob', sha: 'sha-compose', size: 10 },
            { path: 'webapp/channels/package.json', type: 'blob', sha: 'sha-channels', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('server/build/Dockerfile');
    expect(tree).toHaveProperty('server/build/docker-compose.yml');
    expect(tree).toHaveProperty('webapp/channels/package.json');
    expect(tree).toHaveProperty('webapp/platform/pkg0/package.json');
    expect(Object.keys(tree).filter((path) => path.startsWith('e2e-tests/'))).toHaveLength(ANALYSIS_MAX_FILES - 44);
  });

  it('fetches entry, routing and configuration files before other source on a large tree (COMP-018)', async () => {
    // A Go tree with more plain source files than the cap, all shallower
    // than the routes file — the routes file still wins a slot because it
    // is where the health path and port are declared.
    const plain = Array.from({ length: ANALYSIS_MAX_FILES + 20 }, (_, i) => ({
      path: `internal/reader/parser${i}.go`,
      type: 'blob' as const,
      sha: `sha-plain-${i}`,
      size: 10,
    }));
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            ...plain,
            { path: 'internal/http/server/routes.go', type: 'blob', sha: 'sha-routes', size: 10 },
            { path: 'internal/config/options.go', type: 'blob', sha: 'sha-options', size: 10 },
            { path: 'main.go', type: 'blob', sha: 'sha-main', size: 10 },
          ],
        });
      }
      const sha = url.split('/').pop();
      return makeFetchResponse(200, {
        content: Buffer.from(`content-${sha}`).toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(Object.keys(tree)).toHaveLength(ANALYSIS_MAX_FILES);
    expect(tree).toHaveProperty('main.go');
    expect(tree).toHaveProperty('internal/http/server/routes.go');
    expect(tree).toHaveProperty('internal/config/options.go');
  });

  it('includes a lockfile as an empty-content entry without fetching its blob (§18 package-manager detection)', async () => {
    const calls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      calls.push(url);
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-pkg', size: 20 },
            // Deliberately over ANALYSIS_MAX_FILE_BYTES — the point of the
            // empty-content entry is that this content is NEVER fetched.
            { path: 'pnpm-lock.yaml', type: 'blob', sha: 'sha-lock', size: 500_000 },
          ],
        });
      }
      return makeFetchResponse(200, {
        content: Buffer.from('{}').toString('base64'),
        encoding: 'base64',
      });
    };

    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);

    expect(tree).toEqual({ 'package.json': '{}', 'pnpm-lock.yaml': '' });
    // One tree call + one blob call for package.json only — the lockfile's
    // sha is never requested.
    expect(calls).toHaveLength(2);
    expect(calls.some((u) => u.includes('sha-lock'))).toBe(false);
  });

  it('skips a file whose size exceeds ANALYSIS_MAX_FILE_BYTES', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-huge', size: 10_000_000 }],
        });
      }
      throw new Error('blob content should never be fetched for an oversized file');
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({});
  });

  it('drops a file whose blob content fetch fails rather than failing the whole analysis', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-x', size: 10 }],
        });
      }
      return makeFetchResponse(500, { message: 'server error' });
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({});
  });

  it('drops a file whose blob content fetch THROWS rather than failing the whole analysis', async () => {
    // A fetch seam that rejects — a network drop, or the benchmark snapshot
    // fetch refusing an offline cache miss for one blob — must degrade to
    // "file not present" exactly like an HTTP error does, not abort the tree
    // build (repo-084 NangoHQ/nango offline crash).
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [
            { path: 'package.json', type: 'blob', sha: 'sha-a', size: 10 },
            { path: 'src/server.ts', type: 'blob', sha: 'sha-b', size: 10 },
          ],
        });
      }
      if (url.includes('/git/blobs/sha-a')) {
        throw new Error('snapshot cache miss for acme/widgets blob sha-a (offline)');
      }
      return makeFetchResponse(200, {
        content: Buffer.from('content-b').toString('base64'),
        encoding: 'base64',
      });
    };
    const tree = await buildFileTreeForAnalysis(REF, 'tok', fetchFn);
    expect(tree).toEqual({ 'src/server.ts': 'content-b' });
  });
});

// Task 6: commit-SHA analysis cache — resolves the branch head sha so
// runApplicationAnalysis can decide whether a re-analysis is redundant.
// Best-effort by design: any non-200 degrades to `undefined` rather than
// throwing, since a broken cache lookup must never become a failure reason.
describe('github — fetchHeadSha (commit-SHA analysis cache)', () => {
  const REF = { owner: 'acme', repo: 'widgets', branch: 'main' };

  it('returns the sha from a recorded 200', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, { sha: 'abc123' });
    };
    const sha = await fetchHeadSha(REF, 'tok', fetchFn);
    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/commits/main');
    expect(sha).toBe('abc123');
  });

  it('returns undefined on a 404', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Not Found' });
    const sha = await fetchHeadSha(REF, 'tok', fetchFn);
    expect(sha).toBeUndefined();
  });
});

function rawCommit(sha: string, message: string, authorName: string | null = 'Jane', date: string | null = '2026-09-23T10:00:00Z') {
  return {
    sha,
    commit: { message, author: authorName === null ? null : { name: authorName, date: date ?? undefined } },
  };
}

describe('github — listBranchCommits (commit selector)', () => {
  const REF = { owner: 'acme', repo: 'widgets', branch: 'main' };

  it('fetches a page and maps commits to the CommitSummary shape', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, [
        rawCommit('a'.repeat(40), 'Fix the thing\n\nLonger body here'),
      ]);
    };
    const { commits, nextPage } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(capturedUrl).toBe('https://api.github.com/repos/acme/widgets/commits?sha=main&per_page=30&page=1');
    expect(commits).toEqual([
      {
        sha: 'a'.repeat(40),
        shortSha: 'a'.repeat(7),
        title: 'Fix the thing',
        authorName: 'Jane',
        committedAt: '2026-09-23T10:00:00Z',
      },
    ]);
    expect(nextPage).toBeNull();
  });

  it('truncates the title to the first line, max 200 chars', async () => {
    const longLine = 'x'.repeat(250);
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(200, [rawCommit('b'.repeat(40), `${longLine}\nsecond line`)]);
    const { commits } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(commits[0]!.title).toBe('x'.repeat(200));
  });

  it('allows a null author and committed date', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(200, [rawCommit('c'.repeat(40), 'msg', null, null)]);
    const { commits } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(commits[0]!.authorName).toBeNull();
    expect(commits[0]!.committedAt).toBeNull();
  });

  it('sets nextPage when a full page (30) comes back below the page cap', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(200, Array.from({ length: 30 }, (_, i) => rawCommit(i.toString(16).padStart(40, '0'), `commit ${i}`)));
    const { commits, nextPage } = await listBranchCommits(REF, 3, 'tok', fetchFn);
    expect(commits).toHaveLength(30);
    expect(nextPage).toBe(4);
  });

  it('never returns a nextPage past the page cap (10)', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(200, Array.from({ length: 30 }, (_, i) => rawCommit(i.toString(16).padStart(40, '0'), `commit ${i}`)));
    const { nextPage } = await listBranchCommits(REF, 10, 'tok', fetchFn);
    expect(nextPage).toBeNull();
  });

  it('returns nextPage null when the page is short', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(200, [rawCommit('d'.repeat(40), 'only one')]);
    const { commits, nextPage } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(commits).toHaveLength(1);
    expect(nextPage).toBeNull();
  });

  it('maps a 429 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(429, { message: 'rate limited' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps a 403 with x-ratelimit-remaining: 0 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(403, { message: 'forbidden' }, { 'x-ratelimit-remaining': '0' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps a 404 with no special message to GITHUB_REPO_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Not Found' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_REPO_NOT_FOUND',
    });
  });

  it('maps a 404 "No commit found" message to GITHUB_BRANCH_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(404, { message: 'No commit found for the ref missing-branch' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_BRANCH_NOT_FOUND',
    });
  });

  it('maps a 422 "No commit found" message to GITHUB_BRANCH_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () =>
      makeFetchResponse(422, { message: 'No commit found for the ref missing-branch' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'GITHUB_BRANCH_NOT_FOUND',
    });
  });

  it('maps a 409 (empty repository) to an empty list, not an error', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(409, { message: 'conflict' });
    const { commits, nextPage } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(commits).toEqual([]);
    expect(nextPage).toBeNull();
  });

  it('maps a 404 "empty" message to an empty list, not an error', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'Git Repository is empty.' });
    const { commits, nextPage } = await listBranchCommits(REF, 1, 'tok', fetchFn);
    expect(commits).toEqual([]);
    expect(nextPage).toBeNull();
  });

  it('maps any other non-2xx to GITHUB_COMMITS_FETCH_FAILED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(500, { message: 'boom' });
    await expect(listBranchCommits(REF, 1, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_COMMITS_FETCH_FAILED',
    });
  });
});

describe('github — getCommit (manual sha entry)', () => {
  const REF = { owner: 'acme', repo: 'widgets' };
  const FULL_SHA = 'a'.repeat(40);

  it('fetches and maps a single commit', async () => {
    let capturedUrl = '';
    const fetchFn: FetchFn = async (url) => {
      capturedUrl = url;
      return makeFetchResponse(200, rawCommit(FULL_SHA, 'Fix the thing'));
    };
    const commit = await getCommit(REF, FULL_SHA, 'tok', fetchFn);
    expect(capturedUrl).toBe(`https://api.github.com/repos/acme/widgets/commits/${FULL_SHA}`);
    expect(commit.sha).toBe(FULL_SHA);
    expect(commit.shortSha).toBe(FULL_SHA.slice(0, 7));
  });

  it('resolves a short sha whose full sha starts with the input', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(200, rawCommit(FULL_SHA, 'msg'));
    const commit = await getCommit(REF, FULL_SHA.slice(0, 7), 'tok', fetchFn);
    expect(commit.sha).toBe(FULL_SHA);
  });

  it('404s when the returned full sha does not start with the input', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(200, rawCommit(FULL_SHA, 'msg'));
    await expect(getCommit(REF, 'b'.repeat(7), 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMIT_NOT_FOUND',
    });
  });

  it('maps a 404 to COMMIT_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(404, { message: 'No commit found' });
    await expect(getCommit(REF, FULL_SHA, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMIT_NOT_FOUND',
    });
  });

  it('maps a 422 to COMMIT_NOT_FOUND', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(422, { message: 'invalid' });
    await expect(getCommit(REF, FULL_SHA, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 404,
      code: 'COMMIT_NOT_FOUND',
    });
  });

  it('maps a 429 to GITHUB_RATE_LIMITED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(429, { message: 'rate limited' });
    await expect(getCommit(REF, FULL_SHA, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 429,
      code: 'GITHUB_RATE_LIMITED',
    });
  });

  it('maps any other non-2xx to GITHUB_COMMITS_FETCH_FAILED', async () => {
    const fetchFn: FetchFn = async () => makeFetchResponse(500, { message: 'boom' });
    await expect(getCommit(REF, FULL_SHA, 'tok', fetchFn)).rejects.toMatchObject({
      statusCode: 502,
      code: 'GITHUB_COMMITS_FETCH_FAILED',
    });
  });
});

describe('github — fixture commit helpers', () => {
  it('produces 35 deterministic commits, newest first, with the expected first title', () => {
    expect(GITHUB_FIXTURE_COMMITS).toHaveLength(35);
    expect(GITHUB_FIXTURE_COMMITS[0]!.title).toBe('Fix deployment configuration');
    expect(GITHUB_FIXTURE_COMMITS.every((c) => /^[0-9a-f]{40}$/.test(c.sha))).toBe(true);
  });

  it('pages fixture commits 30 + 5 with the same nextPage contract', () => {
    const page1 = listFixtureBranchCommits(1);
    expect(page1.commits).toHaveLength(30);
    expect(page1.nextPage).toBe(2);

    const page2 = listFixtureBranchCommits(2);
    expect(page2.commits).toHaveLength(5);
    expect(page2.nextPage).toBeNull();
  });

  it('resolves a fixture commit by sha prefix', () => {
    const prefix = GITHUB_FIXTURE_COMMITS[0]!.sha.slice(0, 7);
    expect(getFixtureCommit(prefix).sha).toBe(GITHUB_FIXTURE_COMMITS[0]!.sha);
  });

  it('404s a fixture sha with no match', () => {
    expect(() => getFixtureCommit('f'.repeat(40))).toThrow(
      expect.objectContaining({ code: 'COMMIT_NOT_FOUND' }),
    );
  });
});

describe('github — getFileTreeForAnalysis (fixture + real branching)', () => {
  it('returns the fixture tree by repoFullName in fixture mode', async () => {
    const tree = await getFileTreeForAnalysis('deployz-demo/express-api', { fixtureMode: true });
    expect(tree).toEqual(GITHUB_FIXTURE_FILE_TREES['deployz-demo/express-api']);
    expect(tree['Dockerfile']).toContain('HEALTHCHECK');
  });

  it('404s for an unknown repoFullName in fixture mode', async () => {
    await expect(
      getFileTreeForAnalysis('nope/nope', { fixtureMode: true }),
    ).rejects.toMatchObject({ statusCode: 404, code: 'GITHUB_REPO_NOT_FOUND' });
  });

  it('is GITHUB_DISABLED in real mode when the token/fetchFn/branch are not supplied', async () => {
    await expect(
      getFileTreeForAnalysis('acme/widgets', { fixtureMode: false }),
    ).rejects.toMatchObject({ statusCode: 503, code: 'GITHUB_DISABLED' });
  });

  it('delegates to buildFileTreeForAnalysis in real mode', async () => {
    const fetchFn: FetchFn = async (url) => {
      if (url.includes('/git/trees/')) {
        return makeFetchResponse(200, {
          tree: [{ path: 'package.json', type: 'blob', sha: 'sha-x', size: 5 }],
        });
      }
      return makeFetchResponse(200, {
        content: Buffer.from('{}').toString('base64'),
        encoding: 'base64',
      });
    };
    const tree = await getFileTreeForAnalysis('acme/widgets', {
      fixtureMode: false,
      branch: 'main',
      installationToken: 'tok',
      fetchFn,
    });
    expect(tree).toEqual({ 'package.json': '{}' });
  });
});

describe('github — deployz-demo/async-app fixture (Phase 5 — async & scheduled workloads)', () => {
  it('analyses to a READY manifest with the expected queues, DLQ, and scheduled job', async () => {
    const tree = await getFileTreeForAnalysis('deployz-demo/async-app', { fixtureMode: true });
    const analysis = analyseRepo(tree);
    const manifest = normalizeDeploymentManifest(analysis, {});

    expect(manifest.workers?.map((w) => w.id)).toEqual(['worker']);
    expect(manifest.scheduledJobs?.map((j) => j.id)).toEqual(['cleanup']);
    expect(manifest.scheduledJobs![0]!.command).toBe('node dist/cleanup.js');
    expect(manifest.scheduledJobs![0]!.schedule).toEqual({ type: 'cron', cron: '0 3 * * *' });

    expect(manifest.queues).toHaveLength(1);
    const queue = manifest.queues![0]!;
    expect(queue.id).toBe('orders-queue');
    expect(queue.producers).toEqual(['web']);
    expect(queue.consumers).toEqual(['worker']);
    expect(queue.deadLetter?.consumers).toEqual(['worker']);

    expect(manifest.database.engine).toBe('mysql');
    expect(manifest.storage.required).toBe(true);
    expect(manifest.unsupported).toEqual([]);

    const graph = manifestToApplicationGraph(manifest);
    expect(graph.workloads.map((w) => w.id).sort()).toEqual(['cleanup', 'web', 'worker']);
    expect(graph.resources.map((r) => r.id)).toEqual(
      expect.arrayContaining(['orders-queue', 'orders-queue-dlq']),
    );
    const bindings = graph.bindings.map((b) => [b.sourceId, b.targetId, b.access]);
    expect(bindings).toContainEqual(['web', 'orders-queue', 'produce']);
    expect(bindings).toContainEqual(['worker', 'orders-queue', 'consume']);
    expect(bindings).toContainEqual(['worker', 'orders-queue-dlq', 'consume']);
    expect(bindings).toContainEqual(['orders-queue', 'orders-queue-dlq', 'dead-letter']);
    expect(bindings).toContainEqual(['cleanup-schedule', 'cleanup', 'invoke']);

    // Planner accepts the graph and produces a deterministic IR.
    expect(() => planApplicationGraph({ graph, region: null })).not.toThrow();

    const readiness = buildReadinessReport(analysis, { workerCommandResolved: true });
    expect(readiness.state).toBe('READY');
  });
});

describe('github — server routes over PGlite', () => {
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
    const signin = await auth.api.signUpEmail({
      body: { email: 'github@example.com', password: 'super-secret-1', name: 'GitHub' },
    });
    void signin;
    const response = await auth.api.signInEmail({
      body: { email: 'github@example.com', password: 'super-secret-1' },
      asResponse: true,
    });
    cookie = response.headers.get('set-cookie')!;

    app = await buildServer({
      auth,
      db,
      githubWebhookSecret: WEBHOOK_SECRET,
      githubFixtureMode: true,
      // Empty = no App install URL. Without saying so, this suite passed only
      // on a machine with no .env and failed wherever one was present.
      githubAppInstallUrl: '',
    });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it('rejects unauthenticated installations listing', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/github/installations' });
    expect(response.statusCode).toBe(401);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('UNAUTHORIZED');
  });

  it('lists fixture installations for an authenticated org', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/installations',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { installations: unknown[]; connectUrl: string | null };
    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]).toMatchObject({ id: 'fixture-install-1', accountLogin: 'deployz-demo' });
    expect(body.connectUrl).toBeNull();
  });

  it('lists fixture repositories for an installation', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/github/repos?installationId=fixture-install-1',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { repositories: Array<{ name: string }> };
    expect(body.repositories.map((r) => r.name)).toEqual([
      'express-api',
      'legacy-redis',
      'bullmq-worker',
      'static-api',
      'nextjs-prisma',
      'monorepo',
    ]);
  });

  it('requires an installationId on the repos route', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/github/repos', headers: { cookie } });
    expect(response.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INSTALLATION_ID_REQUIRED');
  });

  describe('commit selector — fixture mode', () => {
    let applicationId: string;

    beforeAll(async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/applications',
        headers: { cookie, 'content-type': 'application/json' },
        payload: JSON.stringify({
          name: 'Express API',
          githubInstallationId: 'fixture-install-1',
          repoFullName: 'deployz-demo/express-api',
          repoUrl: 'https://github.com/deployz-demo/express-api',
          defaultBranch: 'main',
        }),
      });
      applicationId = (response.json() as { id: string }).id;
    });

    it('returns fixture page 1 (30 commits, nextPage 2) scoped to the application repo/branch', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits?page=1`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        repoFullName: string;
        branch: string;
        commits: unknown[];
        nextPage: number | null;
      };
      expect(body.repoFullName).toBe('deployz-demo/express-api');
      expect(body.branch).toBe('main');
      expect(body.commits).toHaveLength(30);
      expect(body.nextPage).toBe(2);
    });

    it('returns fixture page 2 (5 commits, nextPage null)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits?page=2`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { commits: unknown[]; nextPage: number | null };
      expect(body.commits).toHaveLength(5);
      expect(body.nextPage).toBeNull();
    });

    it('defaults to page 1 when no page is given', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      expect((response.json() as { commits: unknown[] }).commits).toHaveLength(30);
    });

    it('rejects an invalid page with 400 INVALID_PAGE', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits?page=11`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INVALID_PAGE');
    });

    it('rejects a non-numeric page with 400 INVALID_PAGE', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits?page=abc`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INVALID_PAGE');
    });

    it('rejects unauthenticated access with 401', async () => {
      const response = await app.inject({ method: 'GET', url: `/api/applications/${applicationId}/commits` });
      expect(response.statusCode).toBe(401);
    });

    it('resolves a valid short sha to the full 40-char sha', async () => {
      const shortSha = GITHUB_FIXTURE_COMMITS[0]!.sha.slice(0, 7);
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits/${shortSha}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { commit: { sha: string; title: string } };
      expect(body.commit.sha).toBe(GITHUB_FIXTURE_COMMITS[0]!.sha);
      expect(body.commit.title).toBe('Fix deployment configuration');
    });

    it('rejects an invalid sha format (e.g. a branch name) with 400 INVALID_COMMIT_SHA', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits/main`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(400);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('INVALID_COMMIT_SHA');
    });

    it('404s an unknown but well-formed sha', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits/${'f'.repeat(40)}`,
        headers: { cookie },
      });
      expect(response.statusCode).toBe(404);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('COMMIT_NOT_FOUND');
    });

    it('404s a cross-org application (authorization boundary)', async () => {
      const other = await auth.api.signUpEmail({
        body: { email: 'github-other@example.com', password: 'super-secret-1', name: 'Other' },
      });
      void other;
      const signin = await auth.api.signInEmail({
        body: { email: 'github-other@example.com', password: 'super-secret-1' },
        asResponse: true,
      });
      const otherCookie = signin.headers.get('set-cookie')!;
      const response = await app.inject({
        method: 'GET',
        url: `/api/applications/${applicationId}/commits`,
        headers: { cookie: otherCookie },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  it('rejects a webhook with an invalid signature as a structured 400 envelope (no stack)', async () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      payload,
    });
    expect(response.statusCode).toBe(400);
    const envelope = errorEnvelopeSchema.parse(response.json());
    expect(envelope.error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    expect(JSON.stringify(response.json())).not.toContain('at ');
  });

  it('accepts a signature-verified webhook', async () => {
    const payload = JSON.stringify({ action: 'created', installation: { id: 1, account: { login: 'acme' } } });
    const response = await app.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'installation',
        'x-hub-signature-256': signPayload(payload),
      },
      payload,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { received: boolean; handled: string };
    expect(body.received).toBe(true);
    expect(body.handled).toBe('ignored'); // resolver is BLOCKED -> no-op, but signature passed
  });

  it('returns 503 for the webhook when no secret is configured', async () => {
    const bareApp = await buildServer({
      auth,
      db,
      githubFixtureMode: true,
      githubWebhookSecret: '', // explicitly unconfigured, never "whatever .env has"
    });
    const payload = JSON.stringify({ action: 'created', installation: { id: 1 } });
    const response = await bareApp.inject({
      method: 'POST',
      url: '/api/github/webhook',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
      payload,
    });
    expect(response.statusCode).toBe(503);
    expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('GITHUB_DISABLED');
    await bareApp.close();
  });
});

// Keep the fixture shape honest for the E2E: the fixture org has the six
// §216 repos (ready with Postgres, needs attention, ready with Redis,
// ready with no database, ready with Next.js + Prisma, and a monorepo).
it('fixture installation exposes the §216 six-repo shape', () => {
  expect(GITHUB_FIXTURE_INSTALLATIONS).toHaveLength(1);
  expect(GITHUB_FIXTURE_INSTALLATIONS[0]?.repositories.map((r) => r.name)).toEqual([
    'express-api',
    'legacy-redis',
    'bullmq-worker',
    'static-api',
    'nextjs-prisma',
    'monorepo',
  ]);
});
