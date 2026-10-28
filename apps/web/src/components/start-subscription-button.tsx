'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api-client';
import {
  createCheckoutIntent,
  fetchBillingConfig,
  fetchSubscriptionStatus,
  openSubscriptionCheckout,
} from '@/lib/billing-checkout';

const ACTIVATION_POLL_MS = 2_000;
const ACTIVATION_WAIT_MS = 30_000;

// Starts the platform subscription: a subscribe-only checkout intent opens the
// billing provider's overlay. The overlay saying "completed" is not the
// authority — the webhook is — so after payment this waits until the
// organization reads ACTIVE, then refreshes the page.
export function StartSubscriptionButton({
  children,
  onActivated,
}: {
  children: React.ReactNode;
  /** Called once the subscription reads ACTIVE; the page is refreshed too. */
  onActivated?: () => void;
}) {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'opening' | 'activating' | 'delayed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  async function waitForActivation(): Promise<void> {
    const deadline = Date.now() + ACTIVATION_WAIT_MS;
    while (mounted.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, ACTIVATION_POLL_MS));
      const status = await fetchSubscriptionStatus().catch(() => null);
      if (status === 'ACTIVE') {
        onActivated?.();
        router.refresh();
        return;
      }
    }
    if (mounted.current) setState('delayed');
  }

  async function onClick(): Promise<void> {
    setError(null);
    setState('opening');
    try {
      const config = await fetchBillingConfig();
      const intent = await createCheckoutIntent({});
      const outcome = await openSubscriptionCheckout(config, intent.transactionId);
      if (outcome !== 'completed') {
        setState('idle');
        return;
      }
      setState('activating');
      await waitForActivation();
    } catch (caught) {
      setError(errorMessage(caught));
      setState('idle');
    }
  }

  if (state === 'activating') {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
        <Spinner aria-hidden />
        Payment received. Activating your subscription…
      </p>
    );
  }

  if (state === 'delayed') {
    return (
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <span>Payment received. It can take a minute for your subscription to show here.</span>
        <Button type="button" variant="outline" size="sm" onClick={() => router.refresh()}>
          <RefreshCw aria-hidden className="size-4" />
          Refresh
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <Button
          type="button"
          onClick={() => void onClick()}
          loading={state === 'opening'}
          loadingText="Opening checkout…"
          data-testid="start-subscription"
        >
          {children}
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
