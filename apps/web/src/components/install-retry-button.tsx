'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '@/components/ui/button';
import type { DeployLinkToken } from '@/lib/deploy-link-flow';
import { retryDeployLinkAttempt } from '@/lib/deploy-link-flow';
import { InstallRetryError, retryInstallAttempt } from '@/lib/install-data';

// Customer-facing "Retry connection" for an install whose connector never
// connected (ux-guidelines §1: the one action once the wait is stale): starts a fresh
// attempt (new enrollment code) and refreshes the page so it re-renders the
// pre-install state: a new Quick Create link, or the update instructions for
// the connector stack that is already in the customer's account.
export function InstallRetryButton({
  installLinkId,
  token,
  deployLink = null,
}: {
  installLinkId: string;
  /** The install link token (the page URL fragment); the retry needs it. */
  token?: string | undefined;
  /** Set on the /deploy page: the retry resolves through the deploy link
   *  (token header) instead of the install link. */
  deployLink?: DeployLinkToken | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onRetry(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      if (deployLink) {
        await retryDeployLinkAttempt(deployLink.publicId, deployLink.token);
      } else {
        await retryInstallAttempt(installLinkId, token);
      }
      router.refresh();
    } catch (caught) {
      setError(
        caught instanceof InstallRetryError && caught.status === 409
          ? 'This deployment was already installed. Contact your software provider for help.'
          : "Couldn't start the retry. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        className="w-fit"
        loading={pending}
        loadingText="Retrying connection…"
        onClick={() => void onRetry()}
      >
        Retry connection
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
