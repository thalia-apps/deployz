import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BENCHMARK_INSTALLATION_TOKEN,
  classifyGithubUrl,
  createSnapshotFetch,
  snapshotCachePath,
} from './snapshot.js';

const SHA = 'a'.repeat(40);

describe('snapshot fetch', () => {
  let cacheDir: string;
  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), 'snapshot-cache-'));
  });
  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('classifies the requests the analysis path makes', () => {
    expect(classifyGithubUrl('https://api.github.com/app/installations/42/access_tokens')).toEqual({ kind: 'token' });
    expect(classifyGithubUrl(`https://api.github.com/repos/acme/api/commits/${SHA}`)).toEqual({
      kind: 'head',
      owner: 'acme',
      repo: 'api',
      ref: SHA,
    });
    expect(classifyGithubUrl(`https://api.github.com/repos/acme/api/git/trees/${SHA}?recursive=1`)).toEqual({
      kind: 'tree',
      owner: 'acme',
      repo: 'api',
      ref: SHA,
    });
    expect(classifyGithubUrl('https://api.github.com/repos/acme/api/git/blobs/deadbeef')).toEqual({
      kind: 'blob',
      owner: 'acme',
      repo: 'api',
      ref: 'deadbeef',
    });
    expect(classifyGithubUrl('https://api.github.com/installation/repositories')).toEqual({ kind: 'other' });
    expect(snapshotCachePath('/c', { kind: 'blob', owner: 'acme', repo: 'api', ref: 'deadbeef' })).toBe(
      join('/c', 'acme__api', 'blobs', 'deadbeef.json'),
    );
  });

  it('answers the token and head-commit lookups locally', async () => {
    const fetchFn = createSnapshotFetch({ cacheDir, token: null, offline: true });
    const token = await fetchFn('https://api.github.com/app/installations/1/access_tokens', { method: 'POST' });
    expect(token.status).toBe(201);
    expect(await token.json()).toMatchObject({ token: BENCHMARK_INSTALLATION_TOKEN });
    const head = await fetchFn(`https://api.github.com/repos/acme/api/commits/${SHA}`);
    expect(await head.json()).toEqual({ sha: SHA });
  });

  it('fetches a tree once, caches it by sha, and serves it offline afterwards', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ tree: [{ path: 'package.json', type: 'blob', sha: 'x', size: 2 }], truncated: false }), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '4999' },
      });
    }) as unknown as typeof fetch;
    const url = `https://api.github.com/repos/acme/api/git/trees/${SHA}?recursive=1`;

    const online = createSnapshotFetch({ cacheDir, token: 'secret', fetchImpl });
    expect((await online.call(null, url)).status).toBe(200);
    expect((await online.call(null, url)).status).toBe(200);
    expect(calls).toHaveLength(1);

    const offline = createSnapshotFetch({ cacheDir, token: null, offline: true });
    expect(await (await offline(url)).json()).toMatchObject({ truncated: false });
    await expect(offline(`https://api.github.com/repos/acme/api/git/blobs/missing`)).rejects.toThrow('cache miss');
  });

  it('sends the token to GitHub, never the placeholder, and does not cache failures', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: (init?.headers as Record<string, string>)['Authorization'] ?? null });
      return new Response('{"message":"Not Found"}', { status: 404 });
    }) as unknown as typeof fetch;
    const fetchFn = createSnapshotFetch({ cacheDir, token: 'ghp_real', fetchImpl });
    const url = 'https://api.github.com/repos/acme/api/git/blobs/nope';
    expect((await fetchFn(url)).status).toBe(404);
    expect((await fetchFn(url)).status).toBe(404);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.auth).toBe('Bearer ghp_real');
  });

  it('waits for the rate-limit window to reset and retries', async () => {
    const waits: number[] = [];
    let attempt = 0;
    const fetchImpl = (async () => {
      attempt += 1;
      if (attempt === 1) {
        return new Response('{"message":"rate limited"}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' },
        });
      }
      return new Response('{"content":"aGk=","encoding":"base64"}', { status: 200 });
    }) as unknown as typeof fetch;
    const fetchFn = createSnapshotFetch({
      cacheDir,
      token: 't',
      fetchImpl,
      sleep: async (ms) => {
        waits.push(ms);
      },
      now: () => 990_000,
    });
    const response = await fetchFn('https://api.github.com/repos/acme/api/git/blobs/ratelimited');
    expect(response.status).toBe(200);
    expect(waits).toEqual([11_000]);
  });
});
