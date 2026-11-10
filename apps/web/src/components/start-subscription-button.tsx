'use client';

import { AlertTriangle, RefreshCw } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { errorMessage } from '@/lib/api-client';
import {
  CHECKOUT_COMPLETE_PARAM,
  createCheckoutIntent,
  fetchSubscriptionStatus,
  openEmbeddedCheckout,
} from '@/lib/billing-checkout';

const ACTIVATION_POLL_MS = 2_000;
const ACTIVATION_WAIT_MS = 30_000;

// Starts the subscription: a subscribe-only checkout intent opens the billing
// provider's checkout embedded in this page. When it is paid, the page waits
// until the organization reads ACTIVE, then refreshes — the webhook is the
// authority, not the checkout. A checkout that cannot be embedded returns to
// this page with ?checkout=complete, which waits the same way.
export function StartSubscriptionButton({
  children,
  onActivated,
}: {
  children: React.ReactNode;
  /** Called once the subscription reads ACTIVE; the page is refreshed too. */
  onActivated?: () => void;
}) {
  const router = useRouter();
  const { resolvedTheme } = useTheme();
  const [state, setState] = useState<'idle' | 'opening' | 'activating' | 'delayed'>('idle');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get(CHECKOUT_COMPLETE_PARAM) !== 'complete') return;
    url.searchParams.delete(CHECKOUT_COMPLETE_PARAM);
    // Polar appends a short-lived portal session token; keep it out of history.
    url.searchParams.delete('customer_session_token');
    window.history.replaceState(null, '', url);
    setState('activating');
    void waitForActivation(ACTIVATION_POLL_MS, ACTIVATION_WAIT_MS).then((activated) => {
      if (!activated && mounted.current) setState('delayed');
    });
  }, []);

  async function waitForActivation(pollMs: number, waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (mounted.current && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      const status = await fetchSubscriptionStatus().catch(() => null);
      if (status === 'ACTIVE') {
        onActivated?.();
        router.refresh();
        return true;
      }
    }
    return false;
  }

  async function onClick(): Promise<void> {
    setError(null);
    setState('opening');
    try {
      const { checkoutUrl } = await createCheckoutIntent({ returnPath: window.location.pathname });
      const outcome = await openEmbeddedCheckout(checkoutUrl, resolvedTheme === 'dark' ? 'dark' : 'light');
      if (!mounted.current) return;
      // Closed without paying: offer the button again, never a "payment
      // received" the vendor did not make.
      if (outcome === 'closed') {
        setState('idle');
        return;
      }
      setState('activating');
      if (!(await waitForActivation(ACTIVATION_POLL_MS, ACTIVATION_WAIT_MS)) && mounted.current) setState('delayed');
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
