import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The staging and the production dashboard share the '.deployz.dev' cookie
// domain, so only the cookie NAME keeps them apart. The middleware reads
// NEXT_PUBLIC_COOKIE_PREFIX at module scope, which the bundle inlines at build
// time, so each case re-imports the module with the value stubbed.
// An empty prefix is what production builds with, so it is stubbed, not left out.
const run = async (prefix: string, cookie: string) => {
  vi.stubEnv('NEXT_PUBLIC_COOKIE_PREFIX', prefix);
  vi.resetModules();
  const { middleware } = await import('@/middleware');
  const request = new NextRequest('https://app.deployz.dev/dashboard', {
    headers: { cookie },
  });
  return middleware(request);
};

describe('middleware session gating', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets the default cookie through when no prefix is configured', async () => {
    const response = await run('', 'better-auth.session_token=abc');
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects a staging cookie when no prefix is configured', async () => {
    const response = await run('', 'deployz-staging.session_token=abc');
    expect(response.headers.get('location')).toContain('/sign-in');
  });

  it('lets the prefixed cookie through when the prefix is configured', async () => {
    const response = await run('deployz-staging', 'deployz-staging.session_token=abc');
    expect(response.headers.get('location')).toBeNull();
  });

  it('redirects the default cookie when the prefix is configured', async () => {
    const response = await run('deployz-staging', 'better-auth.session_token=abc');
    expect(response.headers.get('location')).toContain('/sign-in');
  });
});
