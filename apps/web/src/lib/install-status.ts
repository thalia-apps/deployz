// §12/§44 unified deployment-status client for the public install page.
// Wraps `GET /api/install/:installLinkId/status` — the owner-or-vendor,
// customer-only projection the API derives in apps/api/src/deployment-status
// .ts (see customerDeploymentStatusSchema in @deployz/contracts). Mirrors
// install-data.ts's split between a server-time fetch (initial paint) and a
// browser fetch (the client poll loop), and domains.ts's local-fetch
// convention rather than apiRequest: this route carries no session, so
// there's no error envelope worth unwrapping into ApiRequestError.

import type { CustomerDeploymentStatus } from '@deployz/contracts';

import { apiUrl, serverApiUrl } from '@/lib/api-url';

/**
 * Server-side fetch for the page's initial paint. Returns null on ANY
 * failure — unknown link, network error, 5xx — because the client's
 * `useStatusPoll` loop is the real source of truth after hydration; a failed
 * initial fetch only costs one extra client round trip before the progress
 * card has something to show.
 */
export async function fetchInstallStatusServer(
  installLinkId: string,
  cookieHeader?: string | undefined,
): Promise<CustomerDeploymentStatus | null> {
  try {
    const response = await fetch(
      `${serverApiUrl()}/api/install/${encodeURIComponent(installLinkId)}/status`,
      { cache: 'no-store', ...(cookieHeader ? { headers: { cookie: cookieHeader } } : {}) },
    );
    if (!response.ok) return null;
    return (await response.json()) as CustomerDeploymentStatus;
  } catch {
    return null;
  }
}

/** Browser fetch used by the client poll loop. Throws on a non-ok response
 *  so `useStatusPoll`'s own failure/backoff/staleness handling applies. */
export async function fetchInstallStatus(installLinkId: string): Promise<CustomerDeploymentStatus> {
  const response = await fetch(`${apiUrl}/api/install/${encodeURIComponent(installLinkId)}/status`, {
    credentials: 'include',
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Install status request failed (${response.status})`);
  }
  return (await response.json()) as CustomerDeploymentStatus;
}
