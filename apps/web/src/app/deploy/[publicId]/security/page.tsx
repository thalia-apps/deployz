import type { Metadata } from 'next';
import { cookies } from 'next/headers';

import { DeployLinkInvalidState } from '@/components/deploy-link-invalid-state';
import { SecurityDetailsContent } from '@/components/security-details-content';
import { fetchDeployLinkData } from '@/lib/deploy-link-flow';
import { LINK_TOKEN_COOKIE } from '@/lib/link-token-cookie';

// Rendered per request so the resolve is always fresh — same rule as the
// /deploy page this hangs off.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Security & AWS access',
  // Tokenized private links must stay out of search indexes.
  robots: { index: false, follow: false },
};

// The Security Details sub-page of the tokenized deploy link: the same trust
// story the install link serves, resolved through the same
// x-deployz-token-header flow and failing closed exactly like /deploy. The
// token comes from the cookie the /deploy page set and is never rendered in
// page content.
export default async function DeploySecurityPage({
  params,
}: {
  params: Promise<{ publicId: string }>;
}) {
  const { publicId } = await params;
  const token = (await cookies()).get(LINK_TOKEN_COOKIE)?.value;

  if (!token) {
    return <DeployLinkInvalidState reason="invalid" />;
  }

  const result = await fetchDeployLinkData(publicId, token);

  if (!result.ok) {
    return <DeployLinkInvalidState reason={result.reason} />;
  }

  return (
    <SecurityDetailsContent
      plan={result.data.plan}
      backHref={`/deploy/${encodeURIComponent(publicId)}`}
      backLabel="Back to deployment"
    />
  );
}
