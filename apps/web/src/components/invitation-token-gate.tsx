'use client';

import { useEffect, useState } from 'react';

import { DocsLink } from '@/components/docs-link';
import { InstallLoadError } from '@/components/install-load-error';
import { PublicInstallFlow } from '@/components/public-install-flow';
import { SecurityDetailsContent } from '@/components/security-details-content';
import { Spinner } from '@/components/ui/spinner';
import { DOCS } from '@/lib/docs-links';
import { fetchPublicInstallData } from '@/lib/public-install-data';
import { publicInstallErrorMessage, type PublicInstallResolve } from '@/lib/public-install-types';

// Targeted invitations authorize through a one-time token carried as the URL
// fragment (`/install/<id>#<token>`). A fragment never reaches the server, so
// it stays out of request logs and referrers. Here it is captured once,
// persisted to sessionStorage so a reload or back-navigation keeps working,
// and stripped from the visible URL immediately. The token travels only as
// the x-deployz-token header — it is never rendered, logged, or reported.
const TOKEN_STORAGE_PREFIX = 'deployz-install-token:';

interface InvitationTokenGateProps {
  installLinkId: string;
  /** The invitation's Security details page instead of its confirm flow. */
  view?: 'install' | 'security';
}

type GateState =
  | { kind: 'resolving' }
  | { kind: 'invalid' }
  | { kind: 'error' }
  | { kind: 'gone'; code: string }
  | { kind: 'ready'; resolve: PublicInstallResolve; token: string };

/**
 * Client-side bootstrap for a targeted installation invitation. The server
 * page cannot see the URL fragment, so an invitation that failed both server
 * lookups lands here: with a token it resolves privately and renders the
 * normal confirm flow; without one it fails safe with the same copy as an
 * unknown link (a missing or wrong token is indistinguishable by design).
 */
export function InvitationTokenGate({ installLinkId, view = 'install' }: InvitationTokenGateProps) {
  const [state, setState] = useState<GateState>({ kind: 'resolving' });

  useEffect(() => {
    let cancelled = false;
    const fromHash =
      window.location.hash.length > 1 ? decodeURIComponent(window.location.hash.slice(1)) : '';
    if (fromHash !== '') {
      // Capture first, then hide: the history entry loses the token at once.
      window.sessionStorage.setItem(TOKEN_STORAGE_PREFIX + installLinkId, fromHash);
      window.history.replaceState(null, '', window.location.pathname);
    }
    const token = fromHash || window.sessionStorage.getItem(TOKEN_STORAGE_PREFIX + installLinkId) || '';
    if (token === '') {
      setState({ kind: 'invalid' });
      return;
    }
    void (async () => {
      const lookup = await fetchPublicInstallData(installLinkId, token);
      if (cancelled) return;
      if (lookup === null) {
        setState({ kind: 'invalid' });
        return;
      }
      if (lookup.status === 'error') {
        setState({ kind: 'error' });
        return;
      }
      if (lookup.status === 'gone') {
        setState({ kind: 'gone', code: lookup.code });
        return;
      }
      setState({ kind: 'ready', resolve: lookup.data, token });
    })();
    return () => {
      cancelled = true;
    };
  }, [installLinkId]);

  if (state.kind === 'resolving') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Opening your installation…</h1>
        <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Spinner aria-hidden /> Verifying your installation link.
        </p>
      </div>
    );
  }

  if (state.kind === 'gone') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">This application cannot be installed</h1>
        <p className="max-w-md text-sm text-muted-foreground">{publicInstallErrorMessage(state.code)}</p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <InstallLoadError
        href={`/install/${encodeURIComponent(installLinkId)}${view === 'security' ? '/security' : ''}`}
      />
    );
  }

  if (state.kind === 'invalid') {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">This link isn&apos;t valid</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          This installation link doesn&apos;t match an active installation. The one-time code may be
          missing or incorrect. Contact whoever sent you this link for a new one.
        </p>
        <DocsLink href={DOCS.customerLinkDoesNotOpen}>If the link does not open</DocsLink>
      </div>
    );
  }

  if (view === 'security') {
    return (
      <SecurityDetailsContent
        plan={state.resolve.plan}
        backHref={`/install/${encodeURIComponent(installLinkId)}`}
      />
    );
  }

  return (
    <PublicInstallFlow linkId={installLinkId} resolve={state.resolve} token={state.token} customerKnown />
  );
}
