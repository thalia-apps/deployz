/**
 * Immutable repository snapshots through the production fetch seam.
 *
 * `runApplicationAnalysis` reads GitHub through an injectable `FetchFn`
 * (apps/api/src/github.ts). This module supplies one that answers the
 * installation-token and head-commit lookups locally (the harness pins a
 * commit, so there is no head to resolve) and serves the tree/blob reads
 * from an on-disk cache keyed by git object sha — a sha names immutable
 * content, so a cached answer is the answer forever. A miss goes to GitHub
 * once. Everything the production code does with the responses (relevance
 * filtering, caps, priority, lockfile handling) is untouched.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { FetchFn } from '@deployz/api/github';

/** The token the harness hands the production code; never sent to GitHub. */
export const BENCHMARK_INSTALLATION_TOKEN = 'benchmark-installation-token';

const RATE_LIMIT_ATTEMPTS = 3;
const MAX_RATE_LIMIT_WAIT_MS = 60 * 60 * 1000;

export type SnapshotRequest =
  | { kind: 'token' }
  | { kind: 'head'; owner: string; repo: string; ref: string }
  | { kind: 'tree'; owner: string; repo: string; ref: string }
  | { kind: 'blob'; owner: string; repo: string; ref: string }
  | { kind: 'other' };

/** Classify a GitHub API URL into the requests the analysis path makes. */
export function classifyGithubUrl(url: string): SnapshotRequest {
  const { pathname } = new URL(url);
  if (/^\/app\/installations\/[^/]+\/access_tokens$/.test(pathname)) return { kind: 'token' };
  const match = /^\/repos\/([^/]+)\/([^/]+)\/(commits|git\/trees|git\/blobs)\/([^/]+)$/.exec(pathname);
  if (!match) return { kind: 'other' };
  const [, owner, repo, resource, rawRef] = match;
  const ref = decodeURIComponent(rawRef!);
  const base = { owner: owner!, repo: repo!, ref };
  if (resource === 'commits') return { kind: 'head', ...base };
  if (resource === 'git/trees') return { kind: 'tree', ...base };
  return { kind: 'blob', ...base };
}

/** Where a tree/blob answer lives in the cache. */
export function snapshotCachePath(cacheDir: string, request: Extract<SnapshotRequest, { kind: 'tree' | 'blob' }>): string {
  return join(cacheDir, `${request.owner}__${request.repo}`, `${request.kind}s`, `${request.ref}.json`);
}

/** GITHUB_TOKEN, else the gh CLI's token, else unauthenticated (60 requests/hour). */
export function resolveGithubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env['GITHUB_TOKEN']?.trim();
  if (fromEnv) return fromEnv;
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return token || null;
  } catch {
    return null;
  }
}

interface CachedResponse {
  status: number;
  body: unknown;
}

export interface SnapshotFetchOptions {
  cacheDir: string;
  token: string | null;
  /** Refuse to touch the network: a cache miss is an error. */
  offline?: boolean | undefined;
  fetchImpl?: typeof fetch | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  now?: (() => number) | undefined;
}

type FetchResponse = Awaited<ReturnType<FetchFn>>;

function respond(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponse {
  return {
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
  };
}

function readCache(path: string): CachedResponse | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CachedResponse;
}

function writeCache(path: string, response: CachedResponse): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(response));
}

export function createSnapshotFetch(options: SnapshotFetchOptions): FetchFn {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;

  async function fetchLive(url: string): Promise<CachedResponse & { headers: Headers }> {
    for (let attempt = 1; ; attempt++) {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
      });
      const rateLimited =
        response.status === 429 ||
        (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0');
      if (rateLimited && attempt < RATE_LIMIT_ATTEMPTS) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
        const wait = Math.min(Math.max(reset - now() + 1000, 1000), MAX_RATE_LIMIT_WAIT_MS);
        await sleep(wait);
        continue;
      }
      const text = await response.text();
      let body: unknown = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      return { status: response.status, body, headers: response.headers };
    }
  }

  return async (url) => {
    const request = classifyGithubUrl(url);
    switch (request.kind) {
      case 'token':
        return respond(201, { token: BENCHMARK_INSTALLATION_TOKEN, expires_at: '2099-01-01T00:00:00Z' });
      case 'head':
        return respond(200, { sha: request.ref });
      case 'tree':
      case 'blob': {
        const path = snapshotCachePath(options.cacheDir, request);
        const cached = readCache(path);
        if (cached) return respond(cached.status, cached.body);
        if (options.offline) {
          throw new Error(`snapshot cache miss for ${request.owner}/${request.repo} ${request.kind} ${request.ref} (offline)`);
        }
        const live = await fetchLive(url);
        if (live.status >= 200 && live.status < 300) writeCache(path, { status: live.status, body: live.body });
        return respond(live.status, live.body, {
          'x-ratelimit-remaining': live.headers.get('x-ratelimit-remaining') ?? '',
        });
      }
      case 'other':
        throw new Error(`unexpected GitHub request from the analysis path: ${url}`);
    }
  };
}
