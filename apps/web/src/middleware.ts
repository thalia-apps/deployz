import { getSessionCookie } from 'better-auth/cookies';
import { type NextRequest, NextResponse } from 'next/server';

import { resolveHostRoute } from '@/lib/host-routing';

// Middleware runs on the Edge runtime, which has no runtime process.env for
// anything but NEXT_PUBLIC_* — these are inlined when the bundle is built, so
// they must be present as build arguments, not deployment env vars.
const MARKETING_HOST = process.env.NEXT_PUBLIC_MARKETING_HOST;
const APP_HOST = process.env.NEXT_PUBLIC_APP_HOST;
// Must equal the API's COOKIE_PREFIX, or this looks for a cookie name the API
// never sets. `|| undefined` is load-bearing: the build passes an empty string
// for production, and an empty prefix breaks the cookie lookup.
const COOKIE_PREFIX = process.env.NEXT_PUBLIC_COOKIE_PREFIX || undefined;

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  // The Host header, not nextUrl.hostname: the container sits behind a proxy
  // that forwards to an internal address, so nextUrl can carry that origin
  // instead of the one the browser asked for. Port-stripped and lowercased so
  // a :443 or a capitalised host still matches.
  const host = (request.headers.get('host') ?? '').split(':')[0]!.toLowerCase();

  const route = resolveHostRoute({
    host,
    pathname,
    marketingHost: MARKETING_HOST,
    appHost: APP_HOST,
  });

  if (route) {
    const url = request.nextUrl.clone();
    url.host = route.host;
    url.pathname = route.pathname;
    url.port = '';
    // TLS is terminated upstream, so nextUrl.protocol is http in production.
    // Emitting an http:// Location would ship one cleartext hop carrying the
    // session cookie.
    url.protocol = 'https:';
    // 307, not 308: a permanent redirect is cached by the browser, so a wrong
    // host mapping would be sticky and unrecoverable without a cache clear.
    return NextResponse.redirect(url, 307);
  }

  // Optimistic gating only for /dashboard: the mere presence of the session
  // cookie is enough to let the request through to the server layout, which
  // re-validates the session against the API on every render. The auth pages
  // (/sign-in, /sign-up) are intentionally NOT redirected when a cookie is
  // present — the cookie cannot be validated in the edge runtime, so redirecting
  // to /dashboard on a stale-but-present cookie would loop forever against the
  // layout's redirect-to-/sign-in on an invalid session.
  if (
    (pathname.startsWith('/dashboard') || pathname.startsWith('/admin')) &&
    !getSessionCookie(request, COOKIE_PREFIX ? { cookiePrefix: COOKIE_PREFIX } : undefined)
  ) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = '/sign-in';
    // Carry the destination so signing in lands where the visitor was going.
    // Clearing the search string sent everyone to the dashboard home instead,
    // even though both auth pages already handle callbackUrl (and guard it
    // against open redirects).
    const destination = `${pathname}${request.nextUrl.search}`;
    signIn.search = `?callbackUrl=${encodeURIComponent(destination)}`;
    return NextResponse.redirect(signIn);
  }

  const response = NextResponse.next();
  // Only the marketing hostname should be indexed; the app host serves the
  // same build and would otherwise show up as duplicate content.
  if (APP_HOST && host === APP_HOST) {
    response.headers.set('x-robots-tag', 'noindex, nofollow');
  }
  return response;
}

// Every path the host split covers has to be listed here or it silently
// escapes the split and gets served by whichever hostname was asked. A
// catch-all with negative lookaheads would remove that drift risk, at the
// cost of running middleware on every static asset request too.
export const config = {
  matcher: [
    '/',
    '/pricing',
    '/sign-in',
    '/sign-up',
    '/dashboard/:path*',
    '/admin/:path*',
    '/organizations/:path*',
    '/install/:path*',
    '/deploy/:path*',
    '/accept-invitation/:path*',
    '/github/setup',
  ],
};
