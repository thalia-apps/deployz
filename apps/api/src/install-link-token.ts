import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from './env.js';

// The install link id alone is not a credential: it appears in URLs, browser
// history and access logs. The URL fragment carries a second secret, derived
// from the id with the server secret, so no extra column is stored. The page
// sends it as the `x-deployz-token` header (docs/installation-invitations.md).
// Without it the public install routes withhold the relay enrollment material
// and refuse the retry.
export function installLinkToken(installLinkId: string): string {
  return createHmac('sha256', env.betterAuthSecret ?? 'deployz-dev-install-link')
    .update(`install-link:${installLinkId}`)
    .digest('base64url');
}

export function verifyInstallLinkToken(installLinkId: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const expected = Buffer.from(installLinkToken(installLinkId));
  const actual = Buffer.from(presented);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
