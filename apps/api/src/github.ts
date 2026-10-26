import { createHmac, createSign, timingSafeEqual } from 'node:crypto';
import { posix as posixPath } from 'node:path';

import { eq } from 'drizzle-orm';

import {
  isRuntimeSourcePath,
  listDockerfileCandidates,
  extractCmdScriptPaths,
  dockerfileImageCommand,
  CMD_CHAIN_MAX_DEPTH,
  type FileTree,
  TREE_PATHS,
} from '@deployz/analysis';
import type { RuntimeDb } from '@deployz/db';
import * as schema from '@deployz/db/schema';

import { ApiError } from './errors.js';

// ---------------------------------------------------------------------------
// GitHub App integration — server-side control-plane surface (§15/§17).
//
// The control plane holds the App's private key and vends SHORT-LIVED
// installation access tokens on demand (never stored). Webhook events arrive
// FROM GitHub to /api/github/webhook and are signature-verified against the
// App's webhook secret. The S4 guardrail caps every request at metadata:read
// + contents:read — no PRs, no checks, no admin (§17: those are "optional /
// later", and AI code modification is Not-MVP §20).
//
// Real App install / token fetch / webhook delivery from GitHub are BLOCKED in
// this environment (no App credentials, no network) — so the JWT signing and
// token exchange are built with injectable fetch/key seams, and repo listing
// degrades to a fixture store in test mode. Same graceful-degradation pattern
// as todo 6 (createStripe -> null) and todo 12 (FetchFn / SecretsClient).

export const GITHUB_API_BASE = 'https://api.github.com';

// S4 guardrail: the ONLY permissions the App ever requests. Asserted verbatim
// in github.test.ts — adding anything here is a guardrail violation.
export const GITHUB_SCOPED_PERMISSIONS = {
  contents: 'read',
  metadata: 'read',
} as const;

// The scope reduced for a single installation token. GitHub allows narrowing
// an App's granted permissions on the token request; we always narrow to the
// two read scopes even if the App's manifest somehow granted more.
const TOKEN_REQUEST_PERMISSIONS: Record<string, string> = {
  contents: 'read',
  metadata: 'read',
};

// ---------------------------------------------------------------------------
// Fetch seam (mirrors the relay's FetchFn — a minimal structural type so mocks
// are trivial and no DOM globals are required).
// ---------------------------------------------------------------------------

export interface FetchFn {
  (url: string, init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    status: number;
    headers: { get(name: string): string | null };
    json(): Promise<unknown>;
  }>;
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

// Verifies the `X-Hub-Signature-256` header (HMAC-SHA256 over the RAW body
// using the App webhook secret) with a constant-time comparison. Returns a
// boolean; the route maps `false` to a structured 400 envelope.
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) {
    return false;
  }
  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }
  const provided = signatureHeader.slice(prefix.length);
  const computed = createHmac('sha256', secret).update(rawBody).digest('hex');
  const providedBuf = Buffer.from(provided, 'utf8');
  const computedBuf = Buffer.from(computed, 'utf8');
  if (providedBuf.length !== computedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, computedBuf);
}

// ---------------------------------------------------------------------------
// Install state (binds a GitHub install to the organization that started it)
// ---------------------------------------------------------------------------

const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

function signInstallState(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

// `<expiryMs>.<organizationId>.<hmac>`. GitHub hands `state` back unchanged on
// the Setup URL redirect, so a callback that carries a valid one was started
// by a session of that organization.
export function createInstallState(secret: string, organizationId: string, nowMs: number): string {
  const payload = `${nowMs + INSTALL_STATE_TTL_MS}.${organizationId}`;
  return `${payload}.${signInstallState(secret, payload)}`;
}

export function verifyInstallState(
  secret: string,
  state: string | undefined,
  organizationId: string,
  nowMs: number,
): boolean {
  const parts = state?.split('.');
  if (!parts || parts.length !== 3) {
    return false;
  }
  const [expiry, stateOrganizationId, signature] = parts as [string, string, string];
  const provided = Buffer.from(signature, 'utf8');
  const computed = Buffer.from(signInstallState(secret, `${expiry}.${stateOrganizationId}`), 'utf8');
  return (
    provided.length === computed.length &&
    timingSafeEqual(provided, computed) &&
    stateOrganizationId === organizationId &&
    Number(expiry) > nowMs
  );
}

// ---------------------------------------------------------------------------
// GitHub App JWT (RS256, iat/exp claims)
// ---------------------------------------------------------------------------

// Signs the JWT signing input and returns the base64url signature. The real
// signer uses the App's RSA private key (RS256); tests inject a stub signer so
// no key material is required to assert JWT structure.
export interface AppJwtSigner {
  sign(input: string): string;
}

function base64Url(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64url');
}

// The App's private key reaches this process as one environment variable, and
// it collects escapes on the way: the repo-root `.env` stores the PEM
// double-quoted with `\n` escapes (which the .env parser decodes), while a
// GitHub Actions secret is copied through verbatim (nothing decodes it). So a
// key can arrive fully escaped, or — as production did — with only its first
// and last line breaks still written as two characters. node:crypto sees a
// PEM with no header line and throws `DECODER routines::unsupported`.
//
// Decoding the escapes here is safe: `\n` cannot occur inside base64 or inside
// the PEM armour, so there is nothing legitimate to corrupt.
// Anything that is not a PEM string (a KeyObject, as the tests pass) is
// already structured and goes through untouched.
export function normalizeAppPrivateKey<T>(privateKey: T): T | string {
  if (typeof privateKey !== 'string') return privateKey;
  return privateKey
    .split(String.raw`\r\n`)
    .join('\n')
    .split(String.raw`\n`)
    .join('\n')
    .replace(/\r/g, '');
}

// RS256 signer backed by the App's private key.
export function createRsaSigner(privateKey: string): AppJwtSigner {
  const key = normalizeAppPrivateKey(privateKey);
  return {
    sign(input: string): string {
      const signer = createSign('RSA-SHA256');
      signer.update(input);
      signer.end();
      try {
        return signer.sign(key).toString('base64url');
      } catch {
        // A key we cannot sign with is a GitHub configuration problem, and it
        // has to say so. Left bare, node:crypto's error is not an ApiError, so
        // the error funnel renders it as an anonymous 500 INTERNAL_ERROR —
        // which is how a mangled key once looked exactly like a broken API.
        throw new ApiError(
          503,
          'GITHUB_APP_KEY_INVALID',
          'The GitHub App private key could not be read',
        );
      }
    },
  };
}

// Clock-skew margin. GitHub rejects a JWT whose `exp` is more than 10 minutes
// ahead of GITHUB's clock, so issuing at exactly iat + 600 fails whenever our
// clock runs even a second fast ("'Expiration time' claim ('exp') is too far
// in the future"). Backdating `iat` and shortening the lifetime, as GitHub's
// own documentation recommends, leaves a minute of slack at both ends.
const JWT_CLOCK_SKEW_SECONDS = 60;

// Builds the App JWT from an injectable signer. `iat` = floor(nowMs / 1000)
// backdated by the skew margin, `exp` = iat + 9 minutes (inside GitHub's
// 10-minute maximum even when our clock is a minute fast).
export function buildAppJwt(appId: string, signer: AppJwtSigner, nowMs: number): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(nowMs / 1000) - JWT_CLOCK_SKEW_SECONDS;
  const payload = { iat, exp: iat + 600 - 2 * JWT_CLOCK_SKEW_SECONDS, iss: String(appId) };
  const headerB64 = base64Url(JSON.stringify(header));
  const payloadB64 = base64Url(JSON.stringify(payload));
  const signature = signer.sign(`${headerB64}.${payloadB64}`);
  return `${headerB64}.${payloadB64}.${signature}`;
}

// The "real" entry point: RS256-signed with the App's private key.
export function createAppJwt(appId: string, privateKey: string, nowMs: number): string {
  return buildAppJwt(appId, createRsaSigner(privateKey), nowMs);
}

// ---------------------------------------------------------------------------
// Installation token vending
// ---------------------------------------------------------------------------

// Exchanges an installation id for a short-lived installation access token.
// POSTs to /app/installations/{id}/access_tokens with the App JWT; the request
// body narrows the token's permissions to contents:read + metadata:read (S4).
export async function createInstallationToken(
  installationId: string,
  jwt: string,
  fetchFn: FetchFn,
): Promise<{ token: string; expiresAt: string }> {
  const url = `${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`;
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ permissions: TOKEN_REQUEST_PERMISSIONS }),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_TOKEN_FETCH_FAILED', 'Failed to mint a GitHub installation token');
  }
  const data = (await response.json()) as { token: string; expires_at: string };
  return { token: data.token, expiresAt: data.expires_at };
}

// Convenience: build the App JWT and exchange it in one call.
export async function mintInstallationToken(
  installationId: string,
  appId: string,
  privateKey: string,
  nowMs: number,
  fetchFn: FetchFn,
): Promise<{ token: string; expiresAt: string }> {
  const jwt = createAppJwt(appId, privateKey, nowMs);
  return createInstallationToken(installationId, jwt, fetchFn);
}

// ---------------------------------------------------------------------------
// Repo listing (GET /installation/repositories with the installation token)
// ---------------------------------------------------------------------------

export interface GithubRepository {
  id: string;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

// Lists the repos visible to an installation using the short-lived token.
// BLOCKED against real GitHub in this environment — testable via mock fetch.
// GitHub pages this endpoint (30 per page by default), so every page is read,
// bounded (100 per page, at most `maxPages`) so one picker request can never
// become an unbounded scan.
export async function listInstallationRepositories(
  installationToken: string,
  fetchFn: FetchFn,
  maxPages = 10,
): Promise<GithubRepository[]> {
  const perPage = 100;
  const repositories: GithubRepository[] = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const response = await fetchFn(`${GITHUB_API_BASE}/installation/repositories?per_page=${perPage}&page=${page}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (response.status < 200 || response.status >= 300) {
      throw new ApiError(502, 'GITHUB_REPO_LIST_FAILED', 'Failed to list repositories');
    }
    const data = (await response.json()) as {
      repositories: Array<{
        id: number;
        name: string;
        full_name: string;
        description: string | null;
        private: boolean;
        default_branch: string;
      }>;
    };
    for (const repo of data.repositories) {
      repositories.push({
        id: String(repo.id),
        name: repo.name,
        fullName: repo.full_name,
        description: repo.description,
        private: repo.private,
        defaultBranch: repo.default_branch,
      });
    }
    if (data.repositories.length < perPage) break; // a short page is the last one
  }
  return repositories;
}

// ---------------------------------------------------------------------------
// Installation store (Postgres — github_installations).
//
// Durable because the control plane runs as a Lambda: an in-memory map is
// empty on the next cold start and invisible to every other concurrent
// execution environment, so a vendor who connected GitHub would find the
// connection gone on the next request.
// ---------------------------------------------------------------------------

export interface GithubInstallationRecord {
  id: string;
  organizationId: string;
  accountLogin: string;
  accountType: 'Organization' | 'User';
}

export interface GithubInstallationStore {
  set(installation: GithubInstallationRecord): Promise<void>;
  delete(installationId: string): Promise<void>;
  get(installationId: string): Promise<GithubInstallationRecord | null>;
  listByOrganization(organizationId: string): Promise<GithubInstallationRecord[]>;
}

function toRecord(row: {
  id: string;
  organizationId: string;
  accountLogin: string;
  accountType: string;
}): GithubInstallationRecord {
  return {
    id: row.id,
    organizationId: row.organizationId,
    accountLogin: row.accountLogin,
    accountType: row.accountType === 'User' ? 'User' : 'Organization',
  };
}

export function createGithubStore(db: RuntimeDb): GithubInstallationStore {
  return {
    async set(installation) {
      await db
        .insert(schema.githubInstallations)
        .values(installation)
        .onConflictDoUpdate({
          target: schema.githubInstallations.id,
          set: {
            organizationId: installation.organizationId,
            accountLogin: installation.accountLogin,
            accountType: installation.accountType,
            updatedAt: new Date(),
          },
        });
    },

    async delete(installationId) {
      await db
        .delete(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, installationId));
    },

    async get(installationId) {
      const rows = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.id, installationId))
        .limit(1);
      const row = rows[0];
      return row ? toRecord(row) : null;
    },

    async listByOrganization(organizationId) {
      const rows = await db
        .select()
        .from(schema.githubInstallations)
        .where(eq(schema.githubInstallations.organizationId, organizationId));
      return rows.map(toRecord);
    },
  };
}

/** In-memory store — tests only; production always uses `createGithubStore`. */
export class InMemoryGithubInstallationStore implements GithubInstallationStore {
  private byId = new Map<string, GithubInstallationRecord>();

  async set(installation: GithubInstallationRecord): Promise<void> {
    this.byId.set(installation.id, installation);
  }

  async delete(installationId: string): Promise<void> {
    this.byId.delete(installationId);
  }

  async get(installationId: string): Promise<GithubInstallationRecord | null> {
    return this.byId.get(installationId) ?? null;
  }

  async listByOrganization(organizationId: string): Promise<GithubInstallationRecord[]> {
    return [...this.byId.values()].filter((record) => record.organizationId === organizationId);
  }
}

// ---------------------------------------------------------------------------
// Installation webhook handling
// ---------------------------------------------------------------------------

export interface GithubWebhookInstallation {
  id: number;
  account?: { login: string; type?: string } | undefined;
}

export interface GithubWebhookEvent {
  type: string;
  action?: string | undefined;
  installation?: GithubWebhookInstallation | undefined;
  sender?: { login: string } | undefined;
}

export type InstallationWebhookResult = 'removed' | 'ignored';

// Handles installation.deleted (drop the installation) — the ONLY installation
// event that carries enough information to act on.
//
// A webhook cannot bind an installation to a Deployz organization: the payload
// names a GitHub account, and nothing in it identifies the vendor's tenant.
// Matching the GitHub login against an organization slug cannot work either —
// `organizationSlug` always appends a random seed, so no slug ever equals a
// GitHub login. The binding therefore happens where the vendor's session is
// present: GET /api/github/setup, the App's Setup URL, which GitHub redirects
// the installing user to with `installation_id` in the query.
export async function handleInstallationWebhook(
  store: GithubInstallationStore,
  event: GithubWebhookEvent,
): Promise<InstallationWebhookResult> {
  if (event.type !== 'installation') {
    return 'ignored';
  }
  const installation = event.installation;
  if (!installation) {
    return 'ignored';
  }

  if (event.action === 'deleted') {
    await store.delete(String(installation.id));
    return 'removed';
  }

  return 'ignored';
}

// Reads an installation's own account (login + type) with the App JWT, so the
// setup route can record who the installation belongs to without trusting
// anything the browser sent beyond the installation id itself.
export async function fetchInstallationAccount(
  installationId: string,
  jwt: string,
  fetchFn: FetchFn,
): Promise<{ accountLogin: string; accountType: 'Organization' | 'User' }> {
  const response = await fetchFn(`${GITHUB_API_BASE}/app/installations/${installationId}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_INSTALLATION_FETCH_FAILED', 'Failed to read the GitHub installation');
  }
  const data = (await response.json()) as {
    account?: { login?: string; type?: string } | undefined;
  };
  const accountLogin = data.account?.login;
  if (!accountLogin) {
    throw new ApiError(502, 'GITHUB_INSTALLATION_FETCH_FAILED', 'GitHub installation has no account');
  }
  return {
    accountLogin,
    accountType: data.account?.type === 'User' ? 'User' : 'Organization',
  };
}

// ---------------------------------------------------------------------------
// Fixtures (test mode) + list helpers
// ---------------------------------------------------------------------------

export interface GithubInstallation {
  id: string;
  accountLogin: string;
  accountType: string;
}

interface GithubFixtureInstallation extends GithubInstallation {
  repositories: GithubRepository[];
}

// §216: a fixture GitHub org with three fixture repos — one ready (health
// check + Postgres), one that needs a managed Redis cache (also ready), and
// one that needs attention (an unsupported Redis setup). Used ONLY when
// GITHUB_FIXTURE_MODE is set (tests / local dev); never fabricated in prod.
export const GITHUB_FIXTURE_INSTALLATIONS: readonly GithubFixtureInstallation[] = [
  {
    id: 'fixture-install-1',
    accountLogin: 'deployz-demo',
    accountType: 'Organization',
    repositories: [
      {
        id: 'fixture-repo-1',
        name: 'express-api',
        fullName: 'deployz-demo/express-api',
        description: "Ready to deploy — includes a health check and database config.",
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-2',
        name: 'legacy-redis',
        fullName: 'deployz-demo/legacy-redis',
        description: "Depends on a service Deployz doesn't support yet.",
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-3',
        name: 'bullmq-worker',
        fullName: 'deployz-demo/bullmq-worker',
        description: 'Node worker app using BullMQ — Redis managed automatically.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-4',
        name: 'static-api',
        fullName: 'deployz-demo/static-api',
        description: 'Stateless API with no database — deploys without DB resources.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-5',
        name: 'nextjs-prisma',
        fullName: 'deployz-demo/nextjs-prisma',
        description: 'Next.js app with Prisma and a required PostgreSQL database.',
        private: false,
        defaultBranch: 'main',
      },
      {
        id: 'fixture-repo-6',
        name: 'monorepo',
        fullName: 'deployz-demo/monorepo',
        description: 'pnpm workspace monorepo — the API app is nested under apps/api.',
        private: false,
        defaultBranch: 'main',
      },
    ],
  },
];

export async function listInstallations(
  store: GithubInstallationStore,
  organizationId: string,
  opts: { fixtureMode: boolean },
): Promise<GithubInstallation[]> {
  if (opts.fixtureMode) {
    return GITHUB_FIXTURE_INSTALLATIONS.map((installation) => ({
      id: installation.id,
      accountLogin: installation.accountLogin,
      accountType: installation.accountType,
    }));
  }
  const records = await store.listByOrganization(organizationId);
  return records.map((record) => ({
    id: record.id,
    accountLogin: record.accountLogin,
    accountType: record.accountType,
  }));
}

export async function listRepositories(
  installationId: string,
  opts: {
    fixtureMode: boolean;
    installationToken?: string | undefined;
    fetchFn?: FetchFn | undefined;
  },
): Promise<GithubRepository[]> {
  if (opts.fixtureMode) {
    const fixture = GITHUB_FIXTURE_INSTALLATIONS.find(
      (installation) => installation.id === installationId,
    );
    if (!fixture) {
      throw new ApiError(404, 'GITHUB_INSTALLATION_NOT_FOUND', 'GitHub installation not found');
    }
    return [...fixture.repositories];
  }
  if (!opts.installationToken || !opts.fetchFn) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }
  return listInstallationRepositories(opts.installationToken, opts.fetchFn);
}

// ---------------------------------------------------------------------------
// Repository tree fetch (§18 analysis input)
//
// GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1 lists every
// tracked path (no content), then we fetch the CONTENT of only the files the
// §18 detectors actually read (packages/analysis/src/detectors.ts) via the
// git blobs API. BLOCKED against real GitHub in this environment — testable
// via mock fetch, same seam as everything above. Same S4 permission scope
// (contents:read + metadata:read) as the rest of this file — no writes, no
// PRs, no checks.
// ---------------------------------------------------------------------------

/** A single entry from the GitHub git-trees API (recursive listing). */
interface GitTreeEntry {
  path: string;
  type: string; // 'blob' | 'tree' | 'commit'
  // '120000' marks a symlink: its blob content is the link target path.
  mode?: string | undefined;
  sha: string;
  size?: number | undefined;
}

// Caps on what we will ever download for one analysis run. A repository can
// have thousands of files; the §18 detectors only read a small, well-known
// set (Dockerfile, package.json, .env*, docker-compose.yml, **/schema.prisma,
// and source files by extension for env-var / port / health / fs / worker /
// external-service pattern matching — see isRelevantPath below). These caps
// bound both the number of GitHub API calls (one per fetched file) and the
// memory/time cost of running the detectors themselves.
export const ANALYSIS_MAX_FILES = 200;
export const ANALYSIS_MAX_FILE_BYTES = 200_000; // 200 KB per file
// Parallel blob reads. GitHub's secondary rate limits allow ~100 concurrent
// requests per installation; 12 keeps a comfortable margin while turning a
// minutes-long serial fetch into a few seconds.
export const ANALYSIS_FETCH_CONCURRENCY = 12;

// Directories the §18 detectors never need and that would otherwise blow the
// file cap on repos that (unusually) commit build output or vendored deps.
// A committed `build/` directory holds build TOOLING (mattermost's
// `server/build/Dockerfile`), not output — it is not ignored (Stage A
// COMP-038); build output there is gitignored in practice.
const IGNORED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  '.next',
  'out',
  'coverage',
  '.turbo',
  'cdk.out',
  'vendor',
  '.git',
]);

// Go joins the source set with the Stage A detectors that read Go route
// registrations and configuration literals (COMP-005, COMP-013). `sh` joins
// it for DEPLOY-029: `detectStartupMigrationEvidence` follows the shell
// script(s) a Dockerfile CMD/ENTRYPOINT invokes (and every script those call
// in turn) — without it here, that script is never fetched in real (non-
// fixture) mode and the detector has nothing to read. `ini` joins it for the
// same reason: a CMD `uwsgi --ini uwsgi.ini` can carry a `hook-pre-app` migration.
// C#, Java, Kotlin, PHP, Rust and Elixir join it so the env-var model sees the
// variables those apps read (detectEnvVarModel), inside the same file cap.
const SOURCE_EXTENSION_REGEX = /\.(sh|ini|ts|js|mjs|cjs|jsx|tsx|py|rb|go|cs|java|kt|php|rs|ex|exs)$/i;
// A manifest, a Dockerfile or a Prisma schema anywhere in the tree — a
// workspace repository keeps all three outside the root, and the detectors
// read every one of them (packages/analysis/src/detectors.ts).
const MANIFEST_REGEX = /(?:^|\/)package\.json$/i;
// Either naming order (`Dockerfile.prod`, `prod.Dockerfile`, `Dockerfile-build`) —
// the same shape packages/analysis/src/detectors.ts selects from (COMP-027).
const DOCKERFILE_REGEX = /(?:^|\/)(?:dockerfile(?:[.-][\w.-]+)?|[\w.-]+\.dockerfile)$/i;
const PRISMA_SCHEMA_REGEX = /schema\.prisma$/i;
// Non-npm manifests the §7 Redis detectors (and, for the other languages,
// the rest of the analyser) read — requirements.txt/pyproject.toml (Python),
// Gemfile (Ruby), go.mod (Go), composer.json (PHP), pom.xml/build.gradle
// (JVM), *.csproj (.NET), Cargo.toml (Rust), mix.exs (Elixir). Any depth,
// same as package.json — a workspace/monorepo keeps these outside the root
// too (COMP-029).
const OTHER_MANIFEST_REGEX =
  /(?:^|\/)(?:requirements\.txt|pyproject\.toml|Gemfile|go\.mod|composer\.json|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|libs\.versions\.toml|[\w.-]+\.csproj|Directory\.Packages\.props|Cargo\.toml|mix\.exs)$/i;
// docker-compose.yml/.yaml or compose.yml/.yaml, with an optional
// `.<name>` infix (`compose.prod.yml`, `docker-compose.override.yaml`), at
// any depth — the very-high-signal Redis/Valkey compose-image check reads
// these wherever they live, not just the repo root.
const COMPOSE_REGEX = /(?:^|\/)(?:docker-)?compose(?:\.[\w.-]+)?\.ya?ml$/i;
// .env.example/.env.template/.env.sample at any depth — the checked-in env
// samples vendors actually commit (never a real `.env`, which is gitignored).
const ENV_SAMPLE_REGEX = /(?:^|\/)\.env\.(?:example|template|sample)$/i;
// Framework config files that read env vars under the app's own names: Rails
// `config/*.yml` (ERB), Laravel `config/*.php`, Spring `application*.properties|yml`,
// and the .NET `appsettings.json` values that an environment variable overrides.
// Direct children of `config/` only — `config/locales/` would flood the cap.
const CONFIG_ENV_FILE_REGEX =
  /(?:^|\/)config\/[\w.-]+\.(?:ya?ml|php)$|(?:^|\/)config\.ya?ml$|(?:^|\/)application(?:-[\w.-]+)?\.(?:properties|ya?ml)$|(?:^|\/)appsettings(?:\.Production)?\.json$/i;
// File-based health routes — the same shape detectHealthEndpoint matches on
// the path rather than on the file's contents — and a NestJS
// `health.controller.ts`, whose `@Controller('health')` is the only evidence.
const HEALTH_ROUTE_FILE_REGEX =
  /(?:^|\/)(?:health|healthz|healthcheck|heartbeat)(?:\.controller)?(?:\.[jt]sx?|\/(?:route|index|\+server)\.[jt]sx?)$/i;
// Route and boot files in languages that are not source extensions: Laravel
// declares its routes, and the framework health route (`health: '/up'`), in
// `routes/*.php` and `bootstrap/app.php`; ASP.NET maps its endpoints and health
// checks in `Program.cs` or `Startup.cs`. Without them the AI analyst never sees
// those routes.
const ROUTE_ENTRY_FILE_REGEX = /(?:^|\/)(?:(?:bootstrap\/app|routes\/[\w.-]+)\.php|Program\.cs|Startup\.cs)$/;
// Lockfiles the §18 package-manager detector needs — matched by BASENAME
// only (not `isRelevantPath`'s path-prefix shapes): their presence is the
// signal, never their content, so they are never blob-fetched and never
// count against ANALYSIS_MAX_FILES (see the lockfile loop in
// buildFileTreeForAnalysis below).
const LOCKFILE_BASENAME_REGEX =
  /^(?:pnpm-lock\.yaml|yarn\.lock|package-lock\.json|bun\.lockb?|bun\.lock)$/;

// Deployment descriptors the §10 cloud/infra rejection checks read (COMP-033):
// Terraform (.tf), Bicep (.bicep), Kustomize and Helm. A bounded set — the
// detectors' own IaC patterns — so `isRelevantPath` and the checks agree.
const DEPLOYMENT_DESCRIPTOR_REGEX =
  /(?:^|\/)(?:kustomization\.ya?ml|Chart\.ya?ml|.*\.tf|.*\.bicep)$/i;

// Scheduled-job declarations (Phase 5D): render.yaml `type: cron` services,
// vercel.json `crons`, and crontab / *.cron files — the shapes
// detectScheduledJobs reads. None are source extensions or the other manifest
// shapes above, so they need an explicit rule to reach the analysis tree.
const SCHEDULE_FILE_REGEX =
  /(?:^|\/)(?:render\.ya?ml|vercel\.json|crontab)$|\.cron$/i;

// The worker-command declaration the detectors read (detectors.ts
// PROCFILE_REGEX, async-detection.ts): a Procfile non-web process is what
// makes a separate worker a declared workload, which queue attribution needs
// to tell a consumer apart from the web process. Case-sensitive on purpose —
// that is the detectors' own pattern.
const PROCFILE_REGEX = /(?:^|\/)Procfile$/;
// A supervisord config that the start path names runs its programs in the web
// container too (detectors.ts mainCommandRunsWorker, linkding's `run_huey`).
const SUPERVISORD_CONFIG_REGEX = /(?:^|\/)supervisord?[\w.-]*\.conf$/;

// The extension-less scripts an s6-overlay image runs at start (`/init`): a
// service's `run` or `up` file and a `cont-init.d` step. detectStartupMigrationEvidence
// reads them for a migration the image runs before the app (paperless-ngx).
const S6_SCRIPT_REGEX = /(?:^|\/)s6-rc\.d\/[^/]+\/(?:run|up)$|(?:^|\/)cont-init\.d\/[^/]+$/;

function isIgnoredPath(path: string): boolean {
  return path.split('/').some((segment) => IGNORED_DIR_SEGMENTS.has(segment));
}


// Mirrors exactly what packages/analysis/src/detectors.ts, rejection.ts and
// redis.ts read from the file tree — see those files for the authoritative
// patterns. Keep this in sync if a detector starts reading a new file shape.
function isRelevantPath(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  if (MANIFEST_REGEX.test(path)) return true;
  if (OTHER_MANIFEST_REGEX.test(path)) return true;
  if (DOCKERFILE_REGEX.test(path)) return true;
  if (PRISMA_SCHEMA_REGEX.test(path)) return true;
  if (CONFIG_ENV_FILE_REGEX.test(path)) return true;
  if (ROUTE_ENTRY_FILE_REGEX.test(path)) return true;
  if (COMPOSE_REGEX.test(path)) return true;
  if (ENV_SAMPLE_REGEX.test(path)) return true;
  if (DEPLOYMENT_DESCRIPTOR_REGEX.test(path)) return true;
  if (SCHEDULE_FILE_REGEX.test(path)) return true;
  if (PROCFILE_REGEX.test(path)) return true;
  if (SUPERVISORD_CONFIG_REGEX.test(path)) return true;
  if (S6_SCRIPT_REGEX.test(path)) return true;
  const isRoot = !path.includes('/');
  if (isRoot) {
    if (/^\.env(\.\w+)?$/i.test(path)) return true;
  }
  if (SOURCE_EXTENSION_REGEX.test(path)) return true;
  return false;
}

/** A lockfile at any depth, matched by basename — see LOCKFILE_BASENAME_REGEX. */
function isLockfilePath(path: string): boolean {
  if (isIgnoredPath(path)) return false;
  const basename = path.split('/').pop() ?? path;
  return LOCKFILE_BASENAME_REGEX.test(basename);
}

// Priority order for trimming to ANALYSIS_MAX_FILES when a repo has more
// relevant files than the cap: the small, high-signal config files always
// win a slot before the (potentially numerous) source files. A health-route
// file ranks above ordinary source because it is the only evidence of a
// health endpoint in a file-routed application.
//
// The generic "any relevant file sitting at the repo root" bucket is
// DELIBERATELY one tier below the named-pattern group (tier 0), not merged
// into it: an ordinary root-level script that happens to be relevant only
// because of its extension (app.py, manage.py, main.rb — no manifest/
// compose/env-sample name of its own) must never be able to outrank, and so
// crowd out of the ANALYSIS_MAX_FILES cap, a *named* signal file like a
// nested `docker-compose.yml` or `.env.example` that the Redis detectors
// specifically look for. Named patterns are checked (and returned) before
// this generic root check ever runs, so this bucket only ever catches
// unnamed root files.
//
// Tests, specs, fixtures, scripts, docs and tool configuration rank LAST
// (tier 6): the detectors ignore them (`isRuntimeSourcePath`, the same rule
// the analyser applies), and on a large repository they are numerous enough
// to push every application source file out of the cap (Stage A COMP-018).
// Within the application-source tiers, shallower files come first —
// `src/server.ts` before `src/features/x/y/z.ts`.
//
// Files where an application declares how it starts, listens and routes —
// the ones the port/health/env detectors need most on a repository with far
// more source files than the cap (a Go or Django tree can carry hundreds).
const ENTRY_FILE_REGEX =
  /(?:^|\/)(?:main|server|app|index|routes?|router|handlers?|config|settings|urls|options|env)\.[a-z]+$|(?:^|\/)(?:routes?|server|config|http)\/|(?:^|\/)(?:init|initialize|bootstrap)\.go$|(?:^|\/)cmd\/(?:web|serve|server|start|run)\.go$/i;
// Files that read the environment and name the datastore the app uses:
// `environment.service.ts`, `env/GlobalValues.ts`, `configs/database.config.ts`. They are few
// and small, and a deep one would otherwise lose its slot to hundreds of `index.ts`. A plain
// `env.ts` stays with the entry files: front ends carry one too. A typed config class
// (`config-variables.ts`) and a plugin or storage manager (`NcPluginMgrv2.ts`) hold the
// app's storage env names the same way.
const ENV_CONFIG_FILE_REGEX =
  /(?:^|\/)(?:environment(?:\.(?:service|config))?|env\.(?:service|config)|[\w.-]*config-variables|[\w.-]*(?:plugin|storage)-?(?:mgr|manager)[\w.-]*)\.[a-z]+$|(?:^|\/)(?:env|environment)\/[^/]+\.(?:[cm]?[jt]s|py|rb|go)$|(?:^|\/)configs\/[\w.-]+\.config\.[cm]?[jt]s$/i;

//
// Dockerfiles, Compose files and env samples come before package manifests:
// a large workspace ships hundreds of `package.json` files, and inside one
// tier they would sort alphabetically ahead of a production Dockerfile that
// then never enters the tree (Stage A COMP-038). A manifest in a test,
// fixture or tooling directory ranks with the rest of that directory.
//
// `protectedPaths` (DEPLOY-029) ranks above even the Dockerfile itself: the
// selected Dockerfile's own CMD/ENTRYPOINT script chain — typically living
// under `scripts/`, `bin/` or `tools/`, so `isRuntimeSourcePath` would
// otherwise sink it to tier 7 — must never lose its slot to the cap, or
// `detectStartupMigrationEvidence` has nothing to read on a large repository.
function relevancePriority(path: string, protectedPaths: ReadonlySet<string>): number {
  if (protectedPaths.has(path)) return -1;
  if (DOCKERFILE_REGEX.test(path)) return 0;
  if (COMPOSE_REGEX.test(path)) return 0;
  if (ENV_SAMPLE_REGEX.test(path)) return 0;
  // `next start` runs it at boot: its env guards stop the start (detectors.ts NEXT_CONFIG_FILE_REGEX).
  if (/(?:^|\/)next\.config\.[cm]?[jt]s$/i.test(path)) return 3;
  if (!isRuntimeSourcePath(path)) return 7; // tests, specs, fixtures, scripts, docs, tool configs
  // One per runnable ASP.NET project, where it maps its endpoints: a module-heavy
  // repository has more `.csproj` manifests than the cap holds (OrchardCore).
  if (/(?:^|\/)Program\.cs$/.test(path)) return 0;
  if (MANIFEST_REGEX.test(path)) return 1;
  if (OTHER_MANIFEST_REGEX.test(path)) return 1;
  if (!path.includes('/')) return 2; // generic (unnamed) root files
  if (PRISMA_SCHEMA_REGEX.test(path) || CONFIG_ENV_FILE_REGEX.test(path) || S6_SCRIPT_REGEX.test(path)) return 3;
  if (HEALTH_ROUTE_FILE_REGEX.test(path) || ROUTE_ENTRY_FILE_REGEX.test(path) || ENV_CONFIG_FILE_REGEX.test(path)) return 4;
  if (ENTRY_FILE_REGEX.test(path)) return 5; // entry, routing and configuration source
  return 6; // other source files
}

function compareRelevance(a: string, b: string, protectedPaths: ReadonlySet<string>): number {
  const priorityDiff = relevancePriority(a, protectedPaths) - relevancePriority(b, protectedPaths);
  if (priorityDiff !== 0) return priorityDiff;
  return relevancePriority(a, protectedPaths) >= 5 ? a.split('/').length - b.split('/').length : 0;
}

export interface RepositoryRef {
  owner: string;
  repo: string;
  branch: string;
}

// Splits an "owner/repo" full name into its parts. Throws a structured error
// on malformed input rather than producing a broken API URL.
export function parseRepoFullName(fullName: string): { owner: string; repo: string } {
  const parts = fullName.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new ApiError(
      400,
      'GITHUB_REPO_FULL_NAME_INVALID',
      `Malformed repository full name: ${fullName}`,
    );
  }
  return { owner: parts[0], repo: parts[1] };
}

async function readErrorMessage(response: { json(): Promise<unknown> }): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string } | undefined;
    return body?.message ?? '';
  } catch {
    return '';
  }
}

// Fetches the full recursive file listing for a branch (paths + blob shas +
// sizes, no content). Handles the shared failure modes — repo/branch not
// found, empty repo (no commits => no tree), and GitHub rate limiting — by
// mapping each to a distinct structured ApiError so the analysis runner
// (apps/api/src/analysis.ts) can fail cleanly instead of throwing an
// unhandled error.
export async function fetchRepositoryTreeEntries(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<GitTreeEntry[]> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(ref.branch)}?recursive=1`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 429) {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 404) {
    const message = await readErrorMessage(response);
    if (/empty/i.test(message)) {
      throw new ApiError(422, 'GITHUB_REPO_EMPTY', 'Repository has no commits to analyze');
    }
    throw new ApiError(404, 'GITHUB_REPO_NOT_FOUND', 'Repository or branch not found');
  }
  if (response.status === 409) {
    throw new ApiError(422, 'GITHUB_REPO_EMPTY', 'Repository has no commits to analyze');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_TREE_FETCH_FAILED', 'Failed to fetch repository tree');
  }

  const data = (await response.json()) as { tree?: GitTreeEntry[]; truncated?: boolean };
  return data.tree ?? [];
}

// Resolves a branch's current head commit sha — the Task 6 commit-SHA
// analysis cache uses this to decide whether a re-analysis would produce the
// same result as the one already stored. Best-effort: any non-200 (branch
// not found, rate limited, transient error) degrades to `undefined` rather
// than throwing, since a broken cache lookup must never become a failure
// reason for the analysis itself.
export async function fetchHeadSha(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<string | undefined> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.branch)}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (response.status < 200 || response.status >= 300) {
    return undefined;
  }
  const data = (await response.json()) as { sha?: string };
  return data.sha;
}

// Fetches a single blob's content (base64-decoded to a UTF-8 string) by its
// git object sha — one call per relevant file, capped by ANALYSIS_MAX_FILES /
// ANALYSIS_MAX_FILE_BYTES in `buildFileTreeForAnalysis` below.
async function fetchBlobContent(
  ref: RepositoryRef,
  sha: string,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/git/blobs/${sha}`;
  let response: Awaited<ReturnType<FetchFn>>;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${installationToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
  } catch {
    // A fetch seam that throws — a network drop, or the benchmark snapshot
    // fetch refusing an offline cache miss — leaves this one blob as
    // unreadable as an HTTP error does. A single unreadable file should not
    // fail the whole analysis — the detectors treat a missing key as "not
    // present", which is the correct degraded behaviour here too.
    return null;
  }
  if (response.status < 200 || response.status >= 300) {
    // A single unreadable file should not fail the whole analysis — the
    // detectors treat a missing key as "not present", which is the correct
    // degraded behaviour here too.
    return null;
  }
  const data = (await response.json()) as { content?: string; encoding?: string };
  if (!data.content) return null;
  if (data.encoding && data.encoding !== 'base64') return null;
  try {
    return Buffer.from(data.content, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

// A git symlink's blob holds only its target path. A detector must read the
// target file's content, so a symlinked Dockerfile resolves to the real one.
async function fetchEntryContent(
  ref: RepositoryRef,
  entry: GitTreeEntry,
  entriesByPath: ReadonlyMap<string, GitTreeEntry>,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<string | null> {
  const content = await fetchBlobContent(ref, entry.sha, installationToken, fetchFn);
  if (entry.mode !== '120000' || content === null) return content;
  const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
  const target = posixPath.normalize(posixPath.join(dir, content.trim()));
  const targetEntry = entriesByPath.get(target);
  if (targetEntry?.type !== 'blob' || targetEntry.mode === '120000') return null;
  return fetchBlobContent(ref, targetEntry.sha, installationToken, fetchFn);
}

const EMPTY_PROTECTED_PATHS: ReadonlySet<string> = new Set();

// DEPLOY-029: resolve the selected Dockerfile's CMD/ENTRYPOINT script chain
// — the exact paths `detectStartupMigrationEvidence` follows — against the
// FULL relevant-path list, before the ANALYSIS_MAX_FILES trim below ever
// runs. `scripts/`, `bin/` and `tools/` paths rank at tier 7
// (`isRuntimeSourcePath`), so on a repository at or beyond the cap these
// specific files could otherwise be dropped and the whole DEPLOY-029 fix
// becomes inert. Only fetches the handful of blobs the chain actually
// needs: the Dockerfile itself, then each script it names, transitively,
// same depth and traversal `extractCmdScriptPaths` uses — never the whole
// repository. The caller only invokes this once the repository is actually
// at or beyond the cap — see `buildFileTreeForAnalysis`.
async function resolveCmdChainProtectedPaths(
  ref: RepositoryRef,
  relevantEntries: GitTreeEntry[],
  installationToken: string,
  fetchFn: FetchFn,
): Promise<ReadonlySet<string>> {
  const protectedPaths = new Set<string>();
  const knownPaths: FileTree = {};
  const entryByPath = new Map<string, GitTreeEntry>();
  for (const entry of relevantEntries) {
    knownPaths[entry.path] = '';
    entryByPath.set(entry.path, entry);
  }

  const dockerfilePath = listDockerfileCandidates(knownPaths)[0];
  const dockerfileEntry = dockerfilePath !== undefined ? entryByPath.get(dockerfilePath) : undefined;
  if (dockerfilePath === undefined || dockerfileEntry === undefined) return protectedPaths;

  const dockerfileContent = await fetchEntryContent(ref, dockerfileEntry, entryByPath, installationToken, fetchFn);
  if (dockerfileContent === null) return protectedPaths;

  const dockerDir = dockerfilePath.includes('/') ? dockerfilePath.split('/').slice(0, -1).join('/') : '';
  const { cmd, entrypoint } = dockerfileImageCommand(dockerfileContent);
  const visited = new Set<string>();
  let frontier = extractCmdScriptPaths(`${cmd ?? ''} ${entrypoint ?? ''}`, knownPaths, dockerDir, visited);

  for (let depth = 0; depth < CMD_CHAIN_MAX_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      protectedPaths.add(path);
      const scriptEntry = entryByPath.get(path);
      if (scriptEntry === undefined) continue;
      const content = await fetchBlobContent(ref, scriptEntry.sha, installationToken, fetchFn);
      if (content === null) continue;
      next.push(...extractCmdScriptPaths(content, knownPaths, dockerDir, visited));
    }
    frontier = next;
  }

  return protectedPaths;
}

// Builds the FileTree the §18 detectors expect: a small, capped subset of
// the repository's files, selected by `isRelevantPath` and bounded by
// ANALYSIS_MAX_FILES / ANALYSIS_MAX_FILE_BYTES. Fetches content for each
// selected file individually via the blob API (one GitHub API call per
// file) — acceptable at this scale because the cap keeps the call count
// bounded regardless of repository size.
export async function buildFileTreeForAnalysis(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<FileTree> {
  const entries = await fetchRepositoryTreeEntries(ref, installationToken, fetchFn);

  const relevantEntries = entries.filter((entry) => entry.type === 'blob' && isRelevantPath(entry.path));
  // Below the cap, nothing is ever trimmed, so there is nothing to protect
  // — skip the extra Dockerfile/script blob fetches entirely on the common
  // (small-repository) case.
  const protectedPaths =
    relevantEntries.length > ANALYSIS_MAX_FILES
      ? await resolveCmdChainProtectedPaths(ref, relevantEntries, installationToken, fetchFn)
      : EMPTY_PROTECTED_PATHS;

  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const candidates = relevantEntries
    .filter((entry) => entry.size === undefined || entry.size <= ANALYSIS_MAX_FILE_BYTES)
    .sort((a, b) => compareRelevance(a.path, b.path, protectedPaths))
    .slice(0, ANALYSIS_MAX_FILES);

  // Fetched ANALYSIS_FETCH_CONCURRENCY at a time. One-at-a-time turns 200
  // independent blob reads into 200 round trips in series, which is minutes
  // of wall clock on a real repository — far longer than any request or
  // Lambda invocation lives.
  const tree: FileTree = {};
  let next = 0;
  const workers = Array.from(
    { length: Math.min(ANALYSIS_FETCH_CONCURRENCY, candidates.length) },
    async () => {
      while (next < candidates.length) {
        const entry = candidates[next++];
        if (!entry) break;
        const content = await fetchEntryContent(ref, entry, entriesByPath, installationToken, fetchFn);
        if (content !== null) {
          tree[entry.path] = content;
        }
      }
    },
  );
  await Promise.all(workers);

  // Lockfiles can exceed ANALYSIS_MAX_FILE_BYTES and their content is never
  // read — only their presence is the §18 package-manager detection signal.
  // Added as empty-content entries, independent of isRelevantPath's size cap
  // and ANALYSIS_MAX_FILES (a repo's lockfile must never lose a slot to an
  // unrelated source file).
  for (const entry of entries) {
    if (entry.type === 'blob' && isLockfilePath(entry.path)) {
      tree[entry.path] = '';
    }
  }
  // Every tracked path, so a detector can tell a missing file from an unfetched one.
  Object.defineProperty(tree, TREE_PATHS, {
    value: entries.filter((entry) => entry.type === 'blob').map((entry) => entry.path),
    enumerable: false,
  });

  return tree;
}

/**
 * The named files of the repository (blobs within `ANALYSIS_MAX_FILE_BYTES`),
 * for the AI evidence pack: the files `evidenceFileRequests` asks for. A path
 * that is not a blob or cannot be read is left out.
 */
export async function fetchFilesForAnalysis(
  ref: RepositoryRef,
  installationToken: string,
  fetchFn: FetchFn,
  paths: readonly string[],
): Promise<FileTree> {
  const entries = await fetchRepositoryTreeEntries(ref, installationToken, fetchFn);
  const entriesByPath = new Map(entries.map((entry) => [entry.path, entry]));
  const wanted = paths
    .map((path) => entriesByPath.get(path))
    .filter((entry): entry is GitTreeEntry => entry?.type === 'blob' && (entry.size === undefined || entry.size <= ANALYSIS_MAX_FILE_BYTES));
  const files: FileTree = {};
  let next = 0;
  const workers = Array.from({ length: Math.min(ANALYSIS_FETCH_CONCURRENCY, wanted.length) }, async () => {
    while (next < wanted.length) {
      const entry = wanted[next++];
      if (!entry) break;
      const content = await fetchEntryContent(ref, entry, entriesByPath, installationToken, fetchFn);
      if (content !== null) files[entry.path] = content;
    }
  });
  await Promise.all(workers);
  return files;
}

// §216 fixture file trees, keyed by the fixture repo's `fullName` (the same
// string `applications.repo_full_name` holds once a fixture repo is
// "selected" — there is no separate repo-id column on the row). Mirrors the
// six-repo shape in GITHUB_FIXTURE_INSTALLATIONS: express-api is fully
// compatible (Dockerfile + HEALTHCHECK + /health + Postgres + migration
// script); legacy-redis has an unsupported Redis setup (Redis Stack modules)
// so it reliably exercises the NOT_COMPATIBLE path end-to-end without real
// GitHub credentials; bullmq-worker is the same otherwise-READY shape as
// express-api plus a supported, high-confidence Redis requirement,
// exercising the "Redis — managed automatically" ready path end-to-end;
// nextjs-prisma (spec Fixture 1) is a Next.js + Prisma app whose PostgreSQL
// requirement is backed by both a Prisma `postgresql` provider and a
// DATABASE_URL reference — the required-vs-present evidence gating from the
// postgres provisioning task; monorepo (spec Fixture 4) is a pnpm workspace
// whose only application (and only Dockerfile) lives under apps/api, with no
// root start script — it exercises Dockerfile-candidate ranking across
// nested paths and the §15 'monorepo-target' unresolved question.
// Phase 14 adds three fixture trees that only ever appear as
// repoFullName-driven analysis targets (NOT in GITHUB_FIXTURE_INSTALLATIONS,
// so the repo picker never offers them): config-required-app is
// express-api's shape plus a genuine required env var (STRIPE_SECRET_KEY read
// with no fallback) — the §11.2 missing-required-config gate fires at
// deployment creation until the vendor enters a value; mongodb-app is the
// same READY shape plus a mongoose dependency, so its only blocker is the
// unsupported database (§10); local-fs-app is the same READY shape plus a
// persistent local filesystem write, so its only blocker is the local-disk
// storage finding (§11.4).
export const GITHUB_FIXTURE_FILE_TREES: Readonly<Record<string, FileTree>> = {
  'deployz-demo/express-api': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'express-api',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\n',
  },
  'deployz-demo/legacy-redis': {
    'package.json': JSON.stringify({
      name: 'legacy-redis',
      scripts: { start: 'node index.js' },
      // ioredis alone is a plain, SUPPORTED Redis client — @redis/json is
      // what actually makes this repo unsupported (Redis Stack modules,
      // §4 of the Redis MVP spec). Both stay: without a normal client
      // dependency too, `assessRedis` has no non-Stack evidence to report
      // and the rejection can't be attributed to Redis at all (a known
      // detection gap — see packages/analysis/src/redis.ts).
      dependencies: { express: '^4.18.0', ioredis: '^5.4.0', '@redis/json': '^1.0.6' },
    }),
    'index.js': [
      "const express = require('express');",
      'const app = express();',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Otherwise READY-shaped (same Dockerfile/health/Postgres/migration shape
  // as express-api above) but with a direct `bullmq` dependency and a
  // REDIS_URL sample — a supported, high-confidence Redis requirement that
  // exercises the "Redis — managed automatically" ready path end-to-end.
  'deployz-demo/bullmq-worker': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'bullmq-worker',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', pg: '^8.12.0', bullmq: '^5.7.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': ['DATABASE_URL=', 'REDIS_URL=', ''].join('\n'),
  },
  // A stateless API with no database: Dockerfile + HEALTHCHECK + /health +
  // a migration script, but no PostgreSQL driver. Analysis resolves to
  // databaseState 'none' and databaseRequired stays false — the app deploys
  // without RDS resources or DATABASE_* env vars.
  'deployz-demo/static-api': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'static-api',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx migrate up' },
      dependencies: { express: '^4.18.0', migrate: '^2.1.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Next.js + Prisma, spec Fixture 1: a Prisma `postgresql` provider AND a
  // DATABASE_URL reference — the two independent signals `assessPostgres`
  // requires alongside the `@prisma/client` dependency for
  // `postgres.required: true` (RDS provisioning). Otherwise READY-shaped
  // (Dockerfile + HEALTHCHECK + a file-routed /health endpoint + a migration
  // script), and package-manager/build-command detection via the root
  // `packageManager` pin and `scripts.build`.
  'deployz-demo/nextjs-prisma': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'RUN npm run build',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/api/health || exit 1',
      'CMD ["npm", "start"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'nextjs-prisma',
      packageManager: 'pnpm@9.0.0',
      scripts: { build: 'next build', start: 'next start', 'db:migrate': 'prisma migrate deploy' },
      dependencies: { next: '^14.2.0', '@prisma/client': '^5.14.0', prisma: '^5.14.0' },
    }),
    'prisma/schema.prisma': [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
    ].join('\n'),
    '.env.example': ['DATABASE_URL=', 'NEXTAUTH_SECRET=', ''].join('\n'),
    'app/api/health/route.ts': [
      "export async function GET() {",
      '  return Response.json({ ok: true });',
      '}',
      '',
    ].join('\n'),
  },
  // Monorepo, spec Fixture 4: a pnpm workspace whose only application (and
  // only Dockerfile) lives under apps/api — exercises `detectDockerfile`'s
  // shallower-wins ranking across nested paths (there is only one candidate
  // here, but it is two levels deep, not at the root) and the §15
  // 'monorepo-target' unresolved question (>=3 package.json files, no root
  // start script, no root Dockerfile).
  'deployz-demo/monorepo': {
    'pnpm-workspace.yaml': ['packages:', '  - apps/*', ''].join('\n'),
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({
      name: 'monorepo',
      private: true,
      packageManager: 'pnpm@9',
    }),
    'apps/web/package.json': JSON.stringify({
      name: 'web',
      scripts: { build: 'next build', dev: 'next dev' },
      dependencies: { next: '^14.2.0' },
    }),
    'apps/api/package.json': JSON.stringify({
      name: 'api',
      scripts: { start: 'node src/index.js' },
      dependencies: { express: '^4.18.0' },
    }),
    'apps/api/Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY apps/api/package.json ./',
      'RUN npm ci --omit=dev',
      'COPY apps/api/src ./src',
      'EXPOSE 3000',
      'CMD ["node", "src/index.js"]',
    ].join('\n'),
    'apps/api/src/index.js': [
      "const express = require('express');",
      'const app = express();',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    // A health handler that no route registers: analysis cannot resolve its path, so the vendor is asked.
    'apps/api/src/health-controller.js': 'module.exports = (req, res) => res.json({ ok: true });\n',
  },
  // Express-api's exact READY shape (Dockerfile + HEALTHCHECK + /health +
  // Postgres + migration script) plus one genuine required env var: the code
  // READS STRIPE_SECRET_KEY (an external vendor credential, never auto-generated) with no fallback
  // only declares it (no usable default). Analysis-level readiness stays READY
  // (required env values are unknowable to the analyser); the §11.2
  // deployment-creation gate refuses MANIFEST_NEEDS_CONFIGURATION until the
  // vendor enters a value on the Configuration screen.
  'deployz-demo/config-required-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'config-required-app',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      "import crypto from 'node:crypto';",
      'const app = express();',
      // Two required reads: no `??`/`||` fallback, no presence guard. The app
      // cannot start without them (detectEnvVarModel's narrow rule).
      // SESSION_SECRET is an app-internal secret Deployz generates (Phase 4);
      // LICENSE_KEY is the vendor's to provide — the deployment-creation gate
      // refuses until it has a value.
      'const signingKey = process.env.SESSION_SECRET;',
      'const licenseKey = process.env.LICENSE_KEY;',
      'function sign(value: string): string {',
      '  return crypto.createHmac("sha256", signingKey).update(value + licenseKey).digest("hex");',
      '}',
      "app.get('/health', (_req, res) => res.json({ ok: true, tag: sign('health') }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\nSESSION_SECRET=\nLICENSE_KEY=\n',
  },
  // One variable of every ownership shape (docs/environment-variables.md),
  // for the environment-ownership spec: a required URL and a required
  // third-party secret (vendor decisions), an app-internal secret Deployz
  // generates, the managed database binding, defaulted and presence-guarded
  // options, a build-time name and a sample-only key. The sample values are
  // evidence only — they never make a required read optional.
  'deployz-demo/env-matrix-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'env-matrix-app',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', pg: '^8.12.0', stripe: '^16.0.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      "import crypto from 'node:crypto';",
      "import { Pool } from 'pg';",
      "import Stripe from 'stripe';",
      'const app = express();',
      'const pool = new Pool({ connectionString: process.env.DATABASE_URL });',
      'const apiBase = new URL(process.env.API_BASE_URL);',
      'const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);',
      'const level = process.env.LOG_LEVEL ?? "info";',
      'const signups = process.env.FEATURE_SIGNUPS === "true";',
      'const brand = process.env.NEXT_PUBLIC_BRAND_NAME ?? "Acme";',
      'function sign(value: string): string {',
      '  return crypto.createHmac("sha256", process.env.SESSION_SECRET).update(value).digest("hex");',
      '}',
      "app.get('/health', (_req, res) => res.json({ ok: true, tag: sign(String(apiBase) + level + signups + brand), pool: Boolean(pool && stripe) }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': [
      'DATABASE_URL=postgres://localhost:5432/app',
      'API_BASE_URL=http://localhost:4000',
      'STRIPE_SECRET_KEY=sk_test_replace_me',
      'SESSION_SECRET=change-me',
      'LOG_LEVEL=info',
      'SAMPLE_ONLY_FLAG=1',
      '',
    ].join('\n'),
  },
  // The same otherwise-READY express-api shape with a mongoose dependency —
  // a MongoDB app whose ONLY blocker is the unsupported database. Used by
  // the Phase 14 scenario-matrix spec to prove an unsupported repo is
  // refused at deployment creation with NO AWS provisioning.
  // Express-api's READY shape plus a Procfile declaring TWO named workers
  // (email-worker, import-worker) and a migration script — the Phase 4A
  // multi-workload fixture: analysis resolves `web` + two worker processes,
  // the graph compiles one ECS service per workload, and the simulated E2E
  // exercises install → deploy → restart → rollback across all three.
  'deployz-demo/multi-worker-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'Procfile': [
      'web: node dist/index.js',
      'email-worker: node dist/workers/email.js',
      'import-worker: node dist/workers/import.js',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'multi-worker-app',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', pg: '^8.12.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=\n',
  },
  // Phase 4B MySQL fixture: the READY express-api shape with a mysql2
  // dependency and a mysql:// DATABASE_URL — the two signals `assessMysql`
  // requires for `mysql.required: true`. Deployz plans RDS MySQL (the
  // aws.rds-mysql capability) instead of rejecting the app; used by the
  // mysql-sweep simulated scenario (install → deploy → destroy → purge).
  'deployz-demo/mysql-api': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'mysql-api',
      scripts: { start: 'node dist/index.js', 'db:migrate': 'npx drizzle-kit migrate' },
      dependencies: { 'drizzle-kit': '^0.31.0', express: '^4.18.0', mysql2: '^3.9.0' },
    }),
    'src/index.ts': [
      "import express from 'express';",
      "import mysql from 'mysql2/promise';",
      'const app = express();',
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      "app.get('/health', async (_req, res) => {",
      '  await pool.query("SELECT 1");',
      "  res.json({ ok: true });",
      '});',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    '.env.example': 'DATABASE_URL=mysql://localhost:3306/app\n',
  },
  // Phase 4 composition fixture (Phase 4D): the representative target
  // topology — web(public) + two Procfile workers + a migration, MySQL
  // (mysql2 + Prisma provider "mysql" + a compose mysql service) and Redis
  // (ioredis + REDIS_URL + a compose redis service), a `migrate` package
  // script, and compose worker evidence. Every managed resource is here as
  // REAL corroborated evidence, not a hand-set flag.
  'deployz-demo/composed-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'Procfile': [
      'web: node dist/index.js',
      'email-worker: node dist/workers/email.js',
      'import-worker: node dist/workers/import.js',
      '',
    ].join('\n'),
    'docker-compose.yml': [
      'services:',
      '  app:',
      '    build: .',
      '  email-worker:',
      '    image: composed-app',
      '    command: node dist/workers/email.js',
      '  db:',
      '    image: mysql:8.0',
      '    environment:',
      '      MYSQL_ROOT_PASSWORD: example',
      '  redis:',
      '    image: redis:7-alpine',
      '',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'composed-app',
      scripts: {
        start: 'node dist/index.js',
        build: 'tsc',
        migrate: 'node migrate.js',
      },
      dependencies: {
        express: '^4.18.0',
        mysql2: '^3.9.0',
        ioredis: '^5.4.0',
        '@prisma/client': '^5.14.0',
      },
      devDependencies: { prisma: '^5.14.0' },
    }),
    'prisma/schema.prisma': [
      'datasource db {',
      '  provider = "mysql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
    ].join('\n'),
    // Plain unattended migration runner: applies pending SQL migrations from
    // ./migrations non-interactively, exit 0 on success.
    'migrate.js': [
      'const migrations = require("./migrations");',
      'async function main() {',
      '  for (const migration of migrations.pending()) {',
      '    await migration.up();',
      '  }',
      '  process.exit(0);',
      '}',
      'main();',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import express from 'express';",
      "import mysql from 'mysql2/promise';",
      "import Redis from 'ioredis';",
      'const app = express();',
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      'const redis = new Redis(process.env.REDIS_URL);',
      "app.get('/health', async (_req, res) => {",
      '  await pool.query("SELECT 1");',
      '  await redis.ping();',
      '  res.json({ ok: true });',
      '});',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    'src/workers/email.js': [
      "import mysql from 'mysql2/promise';",
      "import Redis from 'ioredis';",
      'const redis = new Redis(process.env.REDIS_URL);',
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      'redis.subscribe("email-jobs");',
      '',
    ].join('\n'),
    'src/workers/import.js': [
      "import mysql from 'mysql2/promise';",
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      'async function run() { await pool.query("SELECT 1"); }',
      'run();',
      '',
    ].join('\n'),
    '.env.example': ['DATABASE_URL=mysql://localhost:3306/composed', 'REDIS_URL=redis://localhost:6379', ''].join('\n'),
  },
  'deployz-demo/mongodb-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'mongodb-app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0', mongoose: '^8.0.0' },
    }),
    // The app's own data model lives in MongoDB (Stage A COMP-032: a client
    // dependency alone is not a requirement).
    'src/models/user.ts': [
      "import mongoose from 'mongoose';",
      'export const User = mongoose.model("User", new mongoose.Schema({ email: String }));',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // The same otherwise-READY express-api shape plus one persistent local
  // filesystem write behind a declared VOLUME — an app whose ONLY blocker is
  // the ephemeral-disk storage finding (Stage A COMP-024: the declaration,
  // not the write call, is the evidence). Used by the Phase 14
  // scenario-matrix spec to prove a repairable repo is refused at deployment
  // creation with the repair guidance surfaced (fix-instructions).
  'deployz-demo/local-fs-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'VOLUME /data',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/index.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'local-fs-app',
      scripts: { start: 'node dist/index.js' },
      dependencies: { express: '^4.18.0' },
    }),
    'src/storage.ts': [
      "import fs from 'node:fs';",
      '// Persistent state written to the local disk — unsupported in',
      '// Deployz\u2019s ephemeral container model (wipe-on-every-deploy).',
      'export function saveUpload(file: Buffer): string {',
      "  const path = '/data/' + Date.now();",
      '  fs.writeFileSync(path, file);',
      '  return path;',
      '}',
      '',
    ].join('\n'),
    'src/index.ts': [
      "import express from 'express';",
      'const app = express();',
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
  },
  // Phase 5 — async & scheduled workloads: an SQS producer (web) + consumer
  // (worker) queue with a dead-letter queue, and a render.yaml `type: cron`
  // scheduled job that itself does MySQL + S3 work. Drives a simulated E2E
  // scenario proving queues/scheduledJobs reach the manifest and the graph.
  'deployz-demo/async-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/server.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'async-app',
      scripts: { start: 'node dist/server.js', build: 'tsc' },
      dependencies: {
        express: '^4.18.0',
        mysql2: '^3.9.0',
        '@prisma/client': '^5.14.0',
        '@aws-sdk/client-sqs': '^3.600.0',
        '@aws-sdk/client-s3': '^3.600.0',
      },
      devDependencies: { prisma: '^5.14.0' },
    }),
    'prisma/schema.prisma': [
      'datasource db {',
      '  provider = "mysql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
    ].join('\n'),
    'Procfile': ['web: node dist/server.js', 'worker: node dist/worker.js', ''].join('\n'),
    'render.yaml': [
      'services:',
      '  - type: cron',
      '    name: cleanup',
      '    schedule: "0 3 * * *"',
      '    startCommand: node dist/cleanup.js',
      '',
    ].join('\n'),
    'src/server.ts': [
      "import express from 'express';",
      "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';",
      'const app = express();',
      "const sqs = new SQSClient({});",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      "app.post('/orders', async (req, res) => {",
      '  await sqs.send(new SendMessageCommand({',
      '    QueueUrl: process.env.ORDERS_QUEUE_URL,',
      '    MessageBody: JSON.stringify(req.body),',
      '  }));',
      '  res.status(202).json({ ok: true });',
      '});',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    'src/worker.ts': ["import './orders-consumer';", "import './dlq-monitor';", ''].join('\n'),
    'src/orders-consumer.ts': [
      "import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';",
      "import mysql from 'mysql2/promise';",
      'const sqs = new SQSClient({});',
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      'async function poll() {',
      '  const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      '  for (const message of result.Messages ?? []) {',
      '    await pool.query("INSERT INTO orders (payload) VALUES (?)", [message.Body]);',
      '    await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));',
      '  }',
      '}',
      'poll();',
      '',
    ].join('\n'),
    'src/dlq-monitor.ts': [
      "import { SQSClient, ReceiveMessageCommand } from '@aws-sdk/client-sqs';",
      'const sqs = new SQSClient({});',
      'async function poll() {',
      '  await sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_DLQ_URL }));',
      '}',
      'poll();',
      '',
    ].join('\n'),
    'src/cleanup.ts': [
      "import mysql from 'mysql2/promise';",
      "import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';",
      'const pool = mysql.createPool({ uri: process.env.DATABASE_URL });',
      'const s3 = new S3Client({});',
      'async function run() {',
      '  await pool.query("DELETE FROM sessions WHERE expires_at < NOW()");',
      '  await s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: "tmp/expired" }));',
      '  process.exit(0);',
      '}',
      'run();',
      '',
    ].join('\n'),
    '.env.example': [
      'DATABASE_URL=mysql://localhost:3306/async_app',
      'ORDERS_QUEUE_URL=',
      'ORDERS_DLQ_URL=',
      '',
    ].join('\n'),
  },
  // Phase 5 — async & scheduled workloads with PostgreSQL: an SQS producer
  // (web) + separate consumer (worker), a dead-letter queue read by the same
  // worker, and a render.yaml `type: cron` scheduled job that cleans the
  // PostgreSQL table and S3. Used for AWS Gate D real-AWS qualification.
  'deployz-demo/async-pg-worker-app': {
    'Dockerfile': [
      'FROM node:20-alpine',
      'WORKDIR /app',
      'COPY package*.json ./',
      'RUN npm ci --omit=dev',
      'COPY . .',
      'EXPOSE 3000',
      'HEALTHCHECK --interval=30s --timeout=3s CMD curl -f http://localhost:3000/health || exit 1',
      'CMD ["node", "dist/server.js"]',
    ].join('\n'),
    'package.json': JSON.stringify({
      name: 'async-pg-worker-app',
      scripts: { start: 'node dist/server.js', build: 'tsc' },
      dependencies: {
        express: '^4.18.0',
        pg: '^8.12.0',
        '@prisma/client': '^5.14.0',
        '@aws-sdk/client-sqs': '^3.600.0',
        '@aws-sdk/client-s3': '^3.600.0',
      },
      devDependencies: { prisma: '^5.14.0' },
    }),
    'prisma/schema.prisma': [
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '}',
      '',
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
    ].join('\n'),
    'Procfile': ['web: node dist/server.js', 'worker: node dist/worker.js', ''].join('\n'),
    'render.yaml': [
      'services:',
      '  - type: cron',
      '    name: cleanup',
      '    schedule: "0 3 * * *"',
      '    startCommand: node dist/scheduled.js',
      '',
    ].join('\n'),
    'src/server.ts': [
      "import express from 'express';",
      "import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';",
      'const app = express();',
      "const sqs = new SQSClient({});",
      "app.get('/health', (_req, res) => res.json({ ok: true }));",
      "app.post('/orders', async (req, res) => {",
      '  await sqs.send(new SendMessageCommand({',
      '    QueueUrl: process.env.ORDERS_QUEUE_URL,',
      '    MessageBody: JSON.stringify(req.body),',
      '  }));',
      '  res.status(202).json({ ok: true });',
      '});',
      'app.listen(process.env.PORT || 3000);',
      '',
    ].join('\n'),
    'src/worker.ts': [
      "import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';",
      "import pg from 'pg';",
      'const sqs = new SQSClient({});',
      'const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });',
      'async function pollQueue() {',
      '  const result = await sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL }));',
      '  for (const message of result.Messages ?? []) {',
      "    await pool.query('INSERT INTO orders (payload) VALUES ($1)', [message.Body]);",
      '    await sqs.send(new DeleteMessageCommand({ QueueUrl: process.env.ORDERS_QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));',
      '  }',
      '}',
      'async function pollDlq() {',
      '  await sqs.send(new ReceiveMessageCommand({ QueueUrl: process.env.ORDERS_DLQ_URL }));',
      '}',
      'pollQueue();',
      'pollDlq();',
      '',
    ].join('\n'),
    'src/scheduled.ts': [
      "import pg from 'pg';",
      "import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';",
      'const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });',
      'const s3 = new S3Client({});',
      'async function run() {',
      "  await pool.query(\"DELETE FROM orders WHERE created_at < NOW() - INTERVAL '7 days'\");",
      '  await s3.send(new DeleteObjectCommand({ Bucket: process.env.AWS_S3_BUCKET, Key: "tmp/expired" }));',
      '  process.exit(0);',
      '}',
      'run();',
      '',
    ].join('\n'),
    '.env.example': [
      'DATABASE_URL=postgresql://localhost:5432/async_pg_worker_app',
      'ORDERS_QUEUE_URL=',
      'ORDERS_DLQ_URL=',
      'AWS_S3_BUCKET=',
      '',
    ].join('\n'),
  },
  // AWS Gate D D1 — public repo Klarline/retail-inventory-platform at HEAD
  // 3a2b8a3 (2026-01-05). API container (Express + Socket.io + Prisma) +
  // separate worker container (SQS consumer). PostgreSQL via Prisma. Producer
  // edge in api/routes/marketplaceOrderRoutes.js (sendToQueue). Consumer edge
  // in api/workers/sqs-consumer.js. SQS_QUEUE_URL env. No Scheduler, no Redis.
  // Mirrored verbatim so the analyser receives the real production evidence.
  'Klarline/retail-inventory-platform': {
    '.gitignore': [
      '# Dependencies',
      'node_modules/',
      'package-lock.json',
      '',
      '# Environment variables',
      '.env',
      '.env.local',
      '.env.production',
      '',
      '# Build outputs',
      'dist/',
      'build/',
      '',
      '# Database',
      '*.db',
      '*.sqlite',
      '',
      '# Logs',
      'logs/',
      '*.log',
      'npm-debug.log*',
      '',
      '# OS files',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# IDE',
      '.vscode/',
      '.idea/',
      '*.swp',
      '*.swo',
      '',
      '# Testing',
      'coverage/',
      '',
      '# Prisma',
      'prisma/*.db',
      'prisma/*.db-journal',
      '',
      '# Misc',
      '.cache/',
      'temp/',
      '',
    ].join('\n'),
    'README.md': [
      '# Multi-Tenant E-Commerce Platform',
      '',
      'Production-ready marketplace platform enabling multiple independent retail stores to manage inventory and serve customers through unified storefronts.',
      '',
      'Stack: Node.js 18 + Express + Prisma + PostgreSQL + Socket.io + AWS SQS + Docker.',
      '',
    ].join('\n'),
    'api/.dockerignore': [
      'node_modules',
      '.prisma',
      'npm-debug.log',
      '.env*',
      '.git',
      '.gitignore',
      'README.md',
      'Dockerfile',
      '.dockerignore',
      'docker-compose.yml',
      'Dockerrun.aws.json',
      '',
    ].join('\n'),
    'api/.env.example': [
      'DATABASE_URL=postgresql://user:password@host:5432/dbname',
      'JWT_SECRET=your-secret-key-here',
      'CLIENT_URL=https://your-frontend-url.vercel.app',
      'AWS_REGION=us-east-1',
      'AWS_ACCESS_KEY_ID=your-access-key',
      'AWS_SECRET_ACCESS_KEY=your-secret-key',
      'SQS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/123456789/inventory-orders-queue',
      'API_URL=http://api:8080',
      '',
    ].join('\n'),
    'api/.gitignore': [
      '# Dependencies',
      'node_modules/',
      'package-lock.json',
      '',
      '# Environment variables',
      '.env',
      '.env.local',
      '.env.production',
      '',
      '# Prisma',
      'prisma/*.db',
      'prisma/*.db-journal',
      '/generated/prisma',
      '',
      '# Logs',
      '*.log',
      '',
      '# OS files',
      '.DS_Store',
      'Thumbs.db',
      '',
      '# Build output - auto-generated',
      'dist/',
      'build/',
      'out/',
      '# Elastic Beanstalk Files',
      '.elasticbeanstalk/*',
      '!.elasticbeanstalk/*.cfg.yml',
      '!.elasticbeanstalk/*.global.yml',
      '',
    ].join('\n'),
    'api/Dockerfile': [
      'FROM node:18-slim',
      '',
      'ENV PRISMA_CLI_BINARY_TARGETS=debian-openssl-3.0.x',
      '',
      'RUN apt-get update -y && apt-get install -y openssl ca-certificates',
      '',
      'WORKDIR /app',
      '',
      'COPY package.json ./',
      'COPY prisma ./prisma/',
      '',
      'RUN npm install --production',
      '',
      'COPY . .',
      '',
      'RUN npx prisma generate',
      '',
      'EXPOSE 8080',
      '',
      'CMD ["node", "index.js"]',
      '',
    ].join('\n'),
    'api/docker-compose.yml': [
      "version: '3.8'",
      '',
      'services:',
      '  api:',
      '    build: .',
      '    ports:',
      '      - "8080:8080"',
      '    environment:',
      '      DATABASE_URL: ${DATABASE_URL}',
      '      JWT_SECRET: ${JWT_SECRET}',
      '      CLIENT_URL: ${CLIENT_URL}',
      '      AWS_REGION: ${AWS_REGION}',
      '      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}',
      '      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}',
      '      SQS_QUEUE_URL: ${SQS_QUEUE_URL}',
      '      API_URL: ${API_URL}',
      '      NODE_ENV: production',
      '      PORT: 8080',
      '    command: node index.js',
      '',
      '  worker:',
      '    build: .',
      '    environment:',
      '      DATABASE_URL: ${DATABASE_URL}',
      '      AWS_REGION: ${AWS_REGION}',
      '      AWS_ACCESS_KEY_ID: ${AWS_ACCESS_KEY_ID}',
      '      AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY}',
      '      SQS_QUEUE_URL: ${SQS_QUEUE_URL}',
      '      API_URL: ${API_URL}',
      '      NODE_ENV: production',
      '    command: node workers/sqs-consumer.js',
      '    depends_on:',
      '      - api',
      '',
    ].join('\n'),
    'api/index.js': [
      'import * as dotenv from "dotenv";',
      'dotenv.config();',
      'import express from "express";',
      'import http from "http";',
      'import morgan from "morgan";',
      'import cors from "cors";',
      'import cookieParser from "cookie-parser";',
      "import { initializeWebSocket } from './websocket-server.js';",
      '',
      'import authRoutes from "./routes/authRoutes.js";',
      'import productRoutes from "./routes/productRoutes.js";',
      'import saleRoutes from "./routes/saleRoutes.js";',
      'import dashboardRoutes from "./routes/dashboardRoutes.js";',
      'import purchaseOrderRoutes from "./routes/purchaseOrderRoutes.js";',
      'import analyticsRoutes from "./routes/analyticsRoutes.js";',
      'import storeRoutes from "./routes/storeRoutes.js";',
      'import teamRoutes from "./routes/teamRoutes.js";',
      'import customerAuthRoutes from "./routes/customerAuthRoutes.js";',
      'import marketplaceRoutes from "./routes/marketplaceRoutes.js";',
      'import marketplaceOrderRoutes from "./routes/marketplaceOrderRoutes.js";',
      'import customerOrderRoutes from "./routes/customerOrderRoutes.js";',
      '',
      'const app = express();',
      'const server = http.createServer(app);',
      '',
      'const io = initializeWebSocket(server);',
      '',
      'app.use(cors({',
      "  origin: process.env.CLIENT_URL || 'http://localhost:3000',",
      '  credentials: true',
      '}));',
      'app.use(express.urlencoded({ extended: true }));',
      'app.use(express.json());',
      'app.use(morgan("dev"));',
      'app.use(cookieParser());',
      '',
      'app.get("/", (req, res) => { res.send("OK"); });',
      'app.get("/ping", (req, res) => { res.send("pong"); });',
      '',
      'app.use(authRoutes);',
      'app.use("/orders", customerOrderRoutes);',
      'app.use("/dashboard", dashboardRoutes);',
      'app.use("/products", productRoutes);',
      'app.use("/sales", saleRoutes);',
      'app.use("/purchase-orders", purchaseOrderRoutes);',
      'app.use("/analytics", analyticsRoutes);',
      'app.use("/my-store", storeRoutes);',
      'app.use("/team", teamRoutes);',
      '',
      'app.use("/auth/customer", customerAuthRoutes);',
      'app.use("/marketplace", marketplaceRoutes);',
      'app.use("/marketplace", marketplaceOrderRoutes);',
      '',
      'const PORT = parseInt(process.env.PORT) || 8080;',
      'server.listen(PORT, () => {',
      '  console.log(`Server running on http://localhost:${PORT}`);',
      '});',
      '',
    ].join('\n'),
    'api/package.json': JSON.stringify({
      name: 'retail-inventory-api',
      version: '1.0.0',
      description: 'Backend API for retail inventory management platform',
      main: 'index.js',
      scripts: {
        start: 'node index.js',
        dev: 'nodemon index.js',
        worker: 'node workers/sqs-consumer.js',
        preinstall: 'npm i -D prisma@5.22.0',
        postinstall: 'npx prisma generate',
        test: 'echo "Error: no test specified" && exit 1',
      },
      type: 'module',
      dependencies: {
        '@aws-sdk/client-sqs': '^3.962.0',
        '@prisma/client': '^5.22.0',
        bcrypt: '^6.0.0',
        'cookie-parser': '^1.4.7',
        cors: '^2.8.5',
        dotenv: '^17.2.3',
        express: '^5.1.0',
        jsonwebtoken: '^9.0.2',
        morgan: '^1.10.1',
        'snowflake-id': '^1.1.0',
        'socket.io': '^4.8.3',
        'socket.io-client': '^4.8.3',
      },
      devDependencies: { nodemon: '^3.1.11', prisma: '^5.22.0' },
    }),
    'api/websocket-server.js': [
      "import { Server } from 'socket.io';",
      '',
      'let io;',
      '',
      'export function initializeWebSocket(server) {',
      '  io = new Server(server, {',
      '    cors: {',
      "      origin: process.env.CLIENT_URL || 'http://localhost:3000',",
      '      credentials: true',
      '    }',
      '  });',
      '',
      "  io.on('connection', (socket) => {",
      "    socket.on('join-store', (storeId) => { socket.join(`store-${storeId}`); });",
      "    socket.on('worker-new-order', (data) => {",
      '      io.to(`store-${data.storeId}`).emit("new-order", data);',
      '    });',
      '  });',
      '',
      '  return io;',
      '}',
      '',
      'export function getIO() {',
      '  if (!io) throw new Error("Socket.io not initialized");',
      '  return io;',
      '}',
      '',
    ].join('\n'),
    'api/workers/sqs-consumer.js': [
      "import * as dotenv from 'dotenv';",
      'dotenv.config();',
      "import { io as ioClient } from 'socket.io-client';",
      "import { PrismaClient } from '@prisma/client';",
      "import { receiveFromQueue, deleteFromQueue } from '../utils/sqsClient.js';",
      '',
      'const prisma = new PrismaClient();',
      "const API_URL = process.env.API_URL || 'http://localhost:8080';",
      'const socket = ioClient(API_URL);',
      '',
      'async function processOrder(orderId) {',
      "  const order = await prisma.customerOrders.findUnique({",
      "    where: { id: orderId },",
      "    include: { items: true }",
      '  });',
      "  if (!order) throw new Error(`Order ${orderId} not found`);",
      "  if (order.status !== 'pending') return;",
      '',
      '  await prisma.$transaction(async (tx) => {',
      '    for (const item of order.items) {',
      '      const result = await tx.$executeRaw`',
      '        UPDATE "Products"',
      '        SET quantity = quantity - ${item.quantity}',
      '        WHERE id = ${item.productId}',
      '        AND quantity >= ${item.quantity}',
      '      `;',
      '      if (result === 0) throw new Error(`Insufficient stock for product ${item.productId}`);',
      '    }',
      "    await tx.customerOrders.update({ where: { id: orderId }, data: { status: 'confirmed', confirmedAt: new Date() } });",
      '  });',
      '',
      "  socket.emit('worker-new-order', {",
      '    storeId: order.storeId,',
      '    orderNumber: order.orderNumber,',
      '    customerName: order.customerName,',
      '    totalAmount: order.total,',
      '    itemCount: order.items.length,',
      '    createdAt: order.createdAt',
      '  });',
      '}',
      '',
      'async function pollQueue() {',
      "  while (true) {",
      '    try {',
      '      const messages = await receiveFromQueue();',
      '      if (messages.length === 0) continue;',
      '      for (const message of messages) {',
      '        try {',
      '          const { orderId } = JSON.parse(message.Body);',
      '          await processOrder(orderId);',
      '          await deleteFromQueue(message.ReceiptHandle);',
      '        } catch (error) { console.error("Error processing message:", error.message); }',
      '      }',
      '    } catch (error) {',
      '      console.error("Error polling queue:", error);',
      '      await new Promise((resolve) => setTimeout(resolve, 5000));',
      '    }',
      '  }',
      '}',
      '',
      'pollQueue();',
      '',
    ].join('\n'),
    'api/utils/sqsClient.js': [
      "import { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';",
      '',
      'const sqsClient = new SQSClient({',
      '  region: process.env.AWS_REGION,',
      '  credentials: {',
      '    accessKeyId: process.env.AWS_ACCESS_KEY_ID,',
      '    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY',
      '  }',
      '});',
      '',
      'export async function sendToQueue(orderId) {',
      '  const command = new SendMessageCommand({',
      '    QueueUrl: process.env.SQS_QUEUE_URL,',
      '    MessageBody: JSON.stringify({ orderId })',
      '  });',
      '  return await sqsClient.send(command);',
      '}',
      '',
      'export async function receiveFromQueue() {',
      '  const command = new ReceiveMessageCommand({',
      '    QueueUrl: process.env.SQS_QUEUE_URL,',
      '    MaxNumberOfMessages: 1,',
      '    WaitTimeSeconds: 20',
      '  });',
      '  const response = await sqsClient.send(command);',
      '  return response.Messages || [];',
      '}',
      '',
      'export async function deleteFromQueue(receiptHandle) {',
      '  const command = new DeleteMessageCommand({',
      '    QueueUrl: process.env.SQS_QUEUE_URL,',
      '    ReceiptHandle: receiptHandle',
      '  });',
      '  await sqsClient.send(command);',
      '}',
      '',
    ].join('\n'),
    'api/utils/snowflake.js': [
      "import pkg from 'snowflake-id';",
      'const SnowflakeId = pkg.default ?? pkg;',
      'const snowflake = new SnowflakeId({ mid: 1, offset: (2024 - 1970) * 31536000 * 1000 });',
      "export function generateOrderNumber() { return `ORD-${snowflake.generate()}`; }",
      '',
    ].join('\n'),
    'api/utils/validation.js': [
      'export function isValidEmail(email) {',
      "  if (!email) return false;",
      "  return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email);",
      '}',
      'export function isValidPhone(phone) { if (!phone) return true; return /^\\d{10}$/.test(phone.replace(/\\D/g, "")); }',
      'export function isValidPassword(password) { return !!password && password.length >= 6; }',
      'export function sanitizeEmail(email) { return email ? email.toLowerCase().trim() : ""; }',
      'export function sanitizePhone(phone) { return phone ? phone.replace(/\\D/g, "") : null; }',
      '',
    ].join('\n'),
    'api/middleware/requireAuth.js': [
      "import jwt from 'jsonwebtoken';",
      'export function requireAuth(req, res, next) {',
      '  const token = req.cookies.token;',
      '  if (!token) return res.status(401).json({ error: "Unauthorized" });',
      '  try {',
      '    const payload = jwt.verify(token, process.env.JWT_SECRET);',
      '    req.userId = payload.userId;',
      '    req.storeId = payload.storeId;',
      '    next();',
      '  } catch (err) { return res.status(401).json({ error: "Unauthorized" }); }',
      '}',
      '',
    ].join('\n'),
    'api/middleware/requireCustomerAuth.js': [
      "import jwt from 'jsonwebtoken';",
      'export function requireCustomerAuth(req, res, next) {',
      '  const token = req.cookies.customerToken || req.headers.authorization?.split(" ")[1];',
      '  if (!token) return res.status(401).json({ error: "Please login to continue" });',
      '  try {',
      '    const payload = jwt.verify(token, process.env.JWT_SECRET);',
      '    if (!payload.customerId) return res.status(401).json({ error: "Invalid token type" });',
      '    req.customerId = payload.customerId;',
      '    req.customerEmail = payload.email;',
      '    next();',
      '  } catch (err) { return res.status(401).json({ error: "Invalid or expired token" }); }',
      '}',
      '',
    ].join('\n'),
    'api/middleware/requireOwner.js': [
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export async function requireOwner(req, res, next) {',
      '  try {',
      '    const user = await prisma.users.findFirst({ where: { id: req.userId, storeId: req.storeId }, select: { role: true } });',
      "    if (!user) return res.status(404).json({ error: 'User not found' });",
      "    if (user?.role !== 'owner') return res.status(403).json({ error: 'Owner access required' });",
      '    next();',
      '  } catch (err) { return res.status(500).json({ error: "Authorization failed" }); }',
      '}',
      '',
    ].join('\n'),
    'api/helpers/authHelpers.js': [
      "import crypto from 'crypto';",
      "import bcrypt from 'bcrypt';",
      "import jwt from 'jsonwebtoken';",
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export async function registerOwner(email, password, name, storeName) {',
      '  const hashedPassword = await bcrypt.hash(password, 10);',
      '  const store = await prisma.stores.create({ data: { name: storeName, joinCode: crypto.randomUUID() } });',
      "  const user = await prisma.users.create({ data: { email, password: hashedPassword, name, role: 'owner', storeId: store.id } });",
      "  const t = jwt.sign({ userId: user.id, storeId: user.storeId }, process.env.JWT_SECRET, { expiresIn: '1d' });",
      '  return { user, store, token: t };',
      '}',
      'export async function loginAdmin(email, password) {',
      '  const user = await prisma.users.findUnique({ where: { email } });',
      "  if (!user || !(await bcrypt.compare(password, user.password))) throw new Error('Invalid credentials');",
      "  const t = jwt.sign({ userId: user.id, storeId: user.storeId }, process.env.JWT_SECRET, { expiresIn: '1d' });",
      '  return { user, store: user.store, token: t };',
      '}',
      '',
    ].join('\n'),
    'api/helpers/customerAuthHelpers.js': [
      "import bcrypt from 'bcrypt';",
      "import jwt from 'jsonwebtoken';",
      "import { PrismaClient } from '@prisma/client';",
      'const prisma = new PrismaClient();',
      'export async function registerCustomer({ email, password, name }) {',
      '  const hashed = await bcrypt.hash(password, 10);',
      '  const c = await prisma.customers.create({ data: { email, password: hashed, name } });',
      "  const t = jwt.sign({ customerId: c.id, email: c.email }, process.env.JWT_SECRET, { expiresIn: '7d' });",
      '  return { customer: c, token: t };',
      '}',
      'export async function loginCustomer(email, password) {',
      '  const c = await prisma.customers.findUnique({ where: { email } });',
      "  if (!c || !(await bcrypt.compare(password, c.password))) throw new Error('Invalid');",
      "  const t = jwt.sign({ customerId: c.id, email: c.email }, process.env.JWT_SECRET, { expiresIn: '7d' });",
      '  return { customer: c, token: t };',
      '}',
      '',
    ].join('\n'),
    'api/prisma/schema.prisma': [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      '',
      'datasource db {',
      '  provider = "postgresql"',
      '  url      = env("DATABASE_URL")',
      '  relationMode = "prisma"',
      '}',
      '',
      'model Users {',
      '  id        Int       @id @default(autoincrement())',
      '  email     String    @unique',
      '  password  String',
      '  name      String?',
      '  role      String?',
      '  storeId   Int?',
      '  createdAt DateTime  @default(now())',
      '  store     Stores?   @relation(fields: [storeId], references: [id])',
      '}',
      '',
      'model Stores {',
      '  id        Int      @id @default(autoincrement())',
      '  name      String',
      '  joinCode  String  @unique @default(uuid())',
      '  createdAt DateTime @default(now())',
      '  users           Users[]',
      '  products        Products[]',
      '  customerOrders  CustomerOrders[]',
      '}',
      '',
      'model Products {',
      '  id        String   @id @default(uuid())',
      '  storeId   Int',
      '  name      String',
      '  barcode   String',
      '  cost      Decimal  @db.Decimal(10, 2)',
      '  price     Decimal  @db.Decimal(10, 2)',
      '  quantity  Int',
      '  createdAt DateTime @default(now())',
      '  updatedAt DateTime @updatedAt',
      '  store               Stores              @relation(fields: [storeId], references: [id], onDelete: Cascade)',
      '  customerOrderItems  CustomerOrderItems[]',
      '  @@unique([storeId, barcode])',
      '}',
      '',
      'model Customers {',
      '  id        String   @id @default(uuid())',
      '  email     String   @unique',
      '  password  String',
      '  name      String',
      '  createdAt DateTime @default(now())',
      '  customerOrders CustomerOrders[]',
      '}',
      '',
      'model CustomerOrders {',
      '  id              String   @id @default(uuid())',
      '  storeId         Int',
      '  customerId      String',
      '  orderNumber     String   @unique',
      '  status          String',
      '  customerEmail   String',
      '  customerName    String',
      '  subtotal        Decimal  @db.Decimal(10, 2)',
      '  total           Decimal  @db.Decimal(10, 2)',
      '  createdAt       DateTime @default(now())',
      '  updatedAt       DateTime @updatedAt',
      '  confirmedAt     DateTime?',
      '  store    Stores             @relation(fields: [storeId], references: [id], onDelete: Cascade)',
      '  customer Customers          @relation(fields: [customerId], references: [id])',
      '  items    CustomerOrderItems[]',
      '}',
      '',
      'model CustomerOrderItems {',
      '  id              String  @id @default(uuid())',
      '  orderId         String',
      '  productId       String',
      '  productName     String',
      '  priceAtPurchase Decimal @db.Decimal(10, 2)',
      '  quantity        Int',
      '  subtotal        Decimal @db.Decimal(10, 2)',
      '  customerOrder CustomerOrders @relation(fields: [orderId], references: [id], onDelete: Cascade)',
      '  product       Products       @relation(fields: [productId], references: [id])',
      '}',
      '',
    ].join('\n'),
    'api/routes/marketplaceOrderRoutes.js': [
      "import express from 'express';",
      "import { PrismaClient } from '@prisma/client';",
      "import { requireCustomerAuth } from '../middleware/requireCustomerAuth.js';",
      "import { generateOrderNumber } from '../utils/snowflake.js';",
      "import { sendToQueue } from '../utils/sqsClient.js';",
      '',
      'const router = express.Router();',
      'const prisma = new PrismaClient();',
      '',
      'router.post("/stores/:storeId/orders", requireCustomerAuth, async (req, res) => {',
      '  const { storeId } = req.params;',
      '  const { items } = req.body;',
      '  const customerId = req.customerId;',
      '',
      '  const customer = await prisma.customers.findUnique({ where: { id: customerId }, select: { email: true, name: true } });',
      '  let subtotal = 0;',
      '  const orderItems = [];',
      '  for (const item of items) {',
      '    const product = await prisma.products.findFirst({ where: { id: item.productId, storeId: parseInt(storeId) } });',
      '    if (!product) throw new Error(`Product ${item.productId} not found`);',
      '    const price = parseFloat(product.price);',
      '    const itemSubtotal = price * item.quantity;',
      '    subtotal += parseFloat(itemSubtotal);',
      '    orderItems.push({ productId: product.id, productName: product.name, priceAtPurchase: price, quantity: item.quantity, subtotal: itemSubtotal });',
      '  }',
      '',
      '  const order = await prisma.customerOrders.create({',
      '    data: {',
      '      storeId: parseInt(storeId),',
      '      customerId,',
      '      orderNumber: generateOrderNumber(),',
      '      status: "pending",',
      '      customerEmail: customer.email,',
      '      customerName: customer.name,',
      '      subtotal,',
      '      total: subtotal,',
      '      items: { create: orderItems }',
      '    },',
      '    include: { items: true }',
      '  });',
      '',
      '  await sendToQueue(order.id);',
      '',
      '  res.status(201).json(order);',
      '});',
      '',
      'export default router;',
      '',
    ].join('\n'),
    'Procfile': [
      'web: node api/index.js',
      'worker: node api/workers/sqs-consumer.js',
      '',
    ].join('\n'),
  },
};

// Builds the analysis FileTree for one application's repository, branching
// on fixture vs real GitHub exactly like `listRepositories` above. In
// fixture mode, the tree is looked up by `repoFullName` — no network call,
// no installation token. In real mode, an installation token and branch are
// required (the caller mints the token the same way the /api/github/repos
// route does) and the repository name is split + fetched from GitHub.
export async function getFileTreeForAnalysis(
  repoFullName: string,
  opts: {
    fixtureMode: boolean;
    branch?: string | undefined;
    installationToken?: string | undefined;
    fetchFn?: FetchFn | undefined;
  },
): Promise<FileTree> {
  if (opts.fixtureMode) {
    const fixtureTree = GITHUB_FIXTURE_FILE_TREES[repoFullName];
    if (!fixtureTree) {
      throw new ApiError(404, 'GITHUB_REPO_NOT_FOUND', 'Repository not found');
    }
    return { ...fixtureTree };
  }
  if (!opts.installationToken || !opts.fetchFn || !opts.branch) {
    throw new ApiError(503, 'GITHUB_DISABLED', 'GitHub App is not configured');
  }
  const { owner, repo } = parseRepoFullName(repoFullName);
  return buildFileTreeForAnalysis(
    { owner, repo, branch: opts.branch },
    opts.installationToken,
    opts.fetchFn,
  );
}

// ---------------------------------------------------------------------------
// Commit listing (releases commit selector) — GET .../commits and
// GET .../commits/{sha}. Same fetch seam and error-mapping shape as
// fetchRepositoryTreeEntries above; errors are distinct codes (GITHUB_*_NOT_FOUND
// vs COMMIT_NOT_FOUND) so the route can tell "branch is gone" apart from
// "that sha doesn't exist" apart from "repo is gone entirely".
// ---------------------------------------------------------------------------

export interface CommitSummary {
  sha: string;
  shortSha: string;
  title: string;
  authorName: string | null;
  committedAt: string | null;
}

const COMMITS_PAGE_SIZE = 30;
const COMMITS_MAX_PAGE = 10;
const COMMIT_TITLE_MAX_LENGTH = 200;

interface RawGithubCommit {
  sha: string;
  commit?: { message?: string; author?: { name?: string; date?: string } | null } | null;
}

function mapCommit(raw: RawGithubCommit): CommitSummary {
  const message = raw.commit?.message ?? '';
  const title = (message.split('\n')[0] ?? '').slice(0, COMMIT_TITLE_MAX_LENGTH);
  return {
    sha: raw.sha,
    shortSha: raw.sha.slice(0, 7),
    title,
    authorName: raw.commit?.author?.name ?? null,
    committedAt: raw.commit?.author?.date ?? null,
  };
}

// Lists one page of a branch's commit history, newest first. `page` is
// 1-based; `nextPage` is null once GitHub returns fewer than a full page or
// the page cap is reached — callers must never walk past COMMITS_MAX_PAGE
// (§ contract: never fetch full history).
export async function listBranchCommits(
  ref: RepositoryRef,
  page: number,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<{ commits: CommitSummary[]; nextPage: number | null }> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/commits?sha=${encodeURIComponent(ref.branch)}&per_page=${COMMITS_PAGE_SIZE}&page=${page}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 429) {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 409) {
    return { commits: [], nextPage: null };
  }
  if (response.status === 404 || response.status === 422) {
    const message = await readErrorMessage(response);
    if (/empty/i.test(message)) {
      return { commits: [], nextPage: null };
    }
    if (/No commit found/i.test(message)) {
      throw new ApiError(404, 'GITHUB_BRANCH_NOT_FOUND', 'Branch not found');
    }
    if (response.status === 404) {
      throw new ApiError(404, 'GITHUB_REPO_NOT_FOUND', 'Repository not found');
    }
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_COMMITS_FETCH_FAILED', 'Failed to fetch commits');
  }

  const data = (await response.json()) as RawGithubCommit[];
  const commits = data.map(mapCommit);
  const nextPage = page < COMMITS_MAX_PAGE && commits.length === COMMITS_PAGE_SIZE ? page + 1 : null;
  return { commits, nextPage };
}

// Resolves one commit by (possibly short) sha for manual entry. Requires the
// resolved commit's full sha to start with the lowercased input — GitHub's
// commit-lookup endpoint otherwise never distinguishes "prefix I gave you"
// from "sha GitHub decided to interpret it as", and a branch name must never
// resolve here (the route's regex already blocks that before this is called).
export async function getCommit(
  ref: { owner: string; repo: string },
  sha: string,
  installationToken: string,
  fetchFn: FetchFn,
): Promise<CommitSummary> {
  const url = `${GITHUB_API_BASE}/repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(sha)}`;
  const response = await fetchFn(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${installationToken}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (response.status === 429) {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new ApiError(429, 'GITHUB_RATE_LIMITED', 'GitHub API rate limit exceeded');
  }
  if (response.status === 404 || response.status === 422) {
    throw new ApiError(404, 'COMMIT_NOT_FOUND', 'Commit not found');
  }
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(502, 'GITHUB_COMMITS_FETCH_FAILED', 'Failed to fetch commit');
  }

  const data = (await response.json()) as RawGithubCommit;
  if (!data.sha.toLowerCase().startsWith(sha.toLowerCase())) {
    throw new ApiError(404, 'COMMIT_NOT_FOUND', 'Commit not found');
  }
  return mapCommit(data);
}

// §216-style fixture data (same deterministic-fixture principle as
// GITHUB_FIXTURE_INSTALLATIONS): 35 commits so page 1 returns a full 30 with
// nextPage 2 and page 2 returns the remaining 5 with nextPage null. Newest
// first, deterministic shas (the commit's own index, zero-padded to 40 hex
// chars) so tests never depend on real GitHub data.
const GITHUB_FIXTURE_COMMIT_COUNT = 35;
const GITHUB_FIXTURE_COMMIT_BASE_MS = Date.UTC(2026, 0, 1);

export const GITHUB_FIXTURE_COMMITS: readonly CommitSummary[] = Array.from(
  { length: GITHUB_FIXTURE_COMMIT_COUNT },
  (_unused, index) => {
    const sha = index.toString(16).padStart(40, '0');
    const title = index === 0 ? 'Fix deployment configuration' : `Fixture commit ${GITHUB_FIXTURE_COMMIT_COUNT - index}`;
    return {
      sha,
      shortSha: sha.slice(0, 7),
      title,
      authorName: 'Fixture Author',
      committedAt: new Date(GITHUB_FIXTURE_COMMIT_BASE_MS - index * 86_400_000).toISOString(),
    };
  },
);

// Fixture-mode counterpart to listBranchCommits — same pagination contract,
// no installation token or network call.
export function listFixtureBranchCommits(page: number): { commits: CommitSummary[]; nextPage: number | null } {
  const start = (page - 1) * COMMITS_PAGE_SIZE;
  const commits = GITHUB_FIXTURE_COMMITS.slice(start, start + COMMITS_PAGE_SIZE);
  const nextPage = page < COMMITS_MAX_PAGE && commits.length === COMMITS_PAGE_SIZE ? page + 1 : null;
  return { commits, nextPage };
}

// Fixture-mode counterpart to getCommit — resolves by sha prefix against
// GITHUB_FIXTURE_COMMITS, same as GitHub itself would for a short sha.
export function getFixtureCommit(sha: string): CommitSummary {
  const lowered = sha.toLowerCase();
  const commit = GITHUB_FIXTURE_COMMITS.find((candidate) => candidate.sha.startsWith(lowered));
  if (!commit) {
    throw new ApiError(404, 'COMMIT_NOT_FOUND', 'Commit not found');
  }
  return commit;
}



