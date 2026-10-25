import type { Metadata } from 'next';

import { InstallLoadError } from '@/components/install-load-error';
import { InvitationTokenGate } from '@/components/invitation-token-gate';
import { SecurityDetailsContent } from '@/components/security-details-content';
import { fetchInstallData } from '@/lib/install-data';
import { fetchPublicInstallData } from '@/lib/public-install-data';
import { publicInstallErrorMessage } from '@/lib/public-install-types';

export const metadata: Metadata = {
  title: 'Security & AWS access',
  robots: { index: false, follow: false },
};

export default async function SecurityDetailsPage({
  params,
}: {
  params: Promise<{ installLinkId: string }>;
}) {
  const { installLinkId } = await params;
  // Resolve the link first: this page used to render the full security story
  // for any id at all, including ones the parent route had already told the
  // reader were invalid.
  const lookup = await fetchInstallData(installLinkId);
  const securityHref = `/install/${encodeURIComponent(installLinkId)}/security`;
  if (lookup.status === 'error') return <InstallLoadError href={securityHref} />;

  // The install review links here before a deployment exists: a public link
  // resolves with its plan, and a targeted invitation resolves client-side
  // with the token its install page stored.
  if (lookup.status === 'not_found') {
    const publicLookup = await fetchPublicInstallData(installLinkId);
    if (publicLookup?.status === 'ok') {
      return (
        <SecurityDetailsContent
          plan={publicLookup.data.plan}
          backHref={`/install/${encodeURIComponent(installLinkId)}`}
        />
      );
    }
    if (publicLookup?.status === 'error') return <InstallLoadError href={securityHref} />;
    if (publicLookup?.status === 'gone') {
      return (
        <div className="flex flex-col gap-4">
          <h1 className="text-2xl font-semibold tracking-tight">This application cannot be installed</h1>
          <p className="max-w-md text-sm text-muted-foreground">{publicInstallErrorMessage(publicLookup.code)}</p>
        </div>
      );
    }
    if (publicLookup === null) {
      return <InvitationTokenGate installLinkId={installLinkId} view="security" />;
    }
  }

  if (lookup.status !== 'ok') {
    const heading =
      lookup.status === 'unavailable' && lookup.code === 'INSTALL_LINK_EXPIRED'
        ? 'This installation link has expired'
        : lookup.status === 'unavailable' && lookup.code === 'INSTALL_LINK_REVOKED'
          ? 'This installation link was revoked'
          : "This link isn't valid";
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {lookup.status === 'unavailable'
            ? lookup.message
            : "This installation link doesn't match an active deployment. Contact whoever sent you this link for a new one."}
        </p>
      </div>
    );
  }

  return (
    <SecurityDetailsContent
      plan={lookup.data.plan}
      backHref={`/install/${encodeURIComponent(installLinkId)}`}
    />
  );
}
