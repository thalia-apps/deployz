'use client';

import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { errorMessage } from '@/lib/api-client';
import { openBillingPortal, type BillingPortalTarget } from '@/lib/billing-checkout';

// The way into the billing provider's hosted customer portal. Every screen
// that manages a subscription (card, invoices, cancel) is the provider's, so
// this is a hand-off, not a page: it mints a short-lived pre-authenticated
// session on the API and sends the vendor there. Same tab, never an iframe —
// the portal is where the vendor's card lives.
export function ManageBillingButton({
  target = 'overview',
  children,
  variant = 'outline',
  size = 'sm',
}: {
  /** Which portal page to land on. */
  target?: BillingPortalTarget;
  children: React.ReactNode;
  variant?: React.ComponentProps<typeof Button>['variant'];
  size?: React.ComponentProps<typeof Button>['size'];
}) {
  const [pending, setPending] = useState(false);

  async function onClick(): Promise<void> {
    setPending(true);
    try {
      const url = await openBillingPortal(target);
      window.location.assign(url);
    } catch (caught) {
      toast.error(errorMessage(caught));
      setPending(false);
    }
  }

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      loading={pending}
      loadingText="Opening billing portal…"
      onClick={() => void onClick()}
      data-testid={`manage-billing-${target}`}
    >
      {children}
      <ExternalLink aria-hidden className="size-4" />
    </Button>
  );
}
